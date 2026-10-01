package server

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	contracts "efttoolbox/contracts"

	stun "github.com/pion/stun/v4"
)

const (
	// The repository regenerates these lists on a schedule: hostnames for the domain source, IP
	// literals (IPv4 + IPv6) for the IP source, and a NAT-testing set that stays IPv4-only because
	// NAT behaviour is an IPv4 concept.
	stunHostListURL  = "https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_hosts.txt"
	stunIP4ListURL   = "https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_ipv4s.txt"
	stunIP6ListURL   = "https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_ipv6s.txt"
	stunNatListURL   = "https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_nat_testing_ipv4s.txt"
	stunListMax      = 400
	stunProbeTimeout = time.Second
	stunProbeWorkers = 12
)

func fetchStunHostServers() ([]string, error) {
	return fetchStunList(stunHostListURL)
}

// fetchStunIPServers merges the IPv4 and IPv6 literal lists; the panel shows them together and the
// resolver picks each entry's family (udp4 for IPv4, udp6 for bracketed IPv6).
func fetchStunIPServers() ([]string, error) {
	ipv4, err := fetchStunList(stunIP4ListURL)
	if err != nil {
		return nil, err
	}
	ipv6, err := fetchStunList(stunIP6ListURL)
	if err != nil {
		return nil, err
	}
	return mergeServers(ipv4, ipv6), nil
}

func fetchStunNatServers() ([]string, error) {
	return fetchStunList(stunNatListURL)
}

// mergeServers concatenates lists in order, dropping duplicates and honouring the same cap as a
// single list so a merged response cannot outgrow the probe endpoint's limit.
func mergeServers(lists ...[]string) []string {
	merged := []string{}
	seen := map[string]bool{}
	for _, list := range lists {
		for _, server := range list {
			if seen[server] {
				continue
			}
			seen[server] = true
			merged = append(merged, server)
			if len(merged) >= stunListMax {
				return merged
			}
		}
	}
	return merged
}

// stunNetwork picks the UDP network for a STUN endpoint: a bracketed IPv6 literal uses udp6, and
// hostnames and IPv4 literals use udp4. Hostnames stay IPv4 so a name that also carries AAAA
// records cannot silently move a session, and the NAT verdict, onto a different address family.
func stunNetwork(endpoint string) string {
	host, _, err := splitStunAddress(endpoint)
	if err != nil {
		return "udp4"
	}
	if ip := net.ParseIP(host); ip != nil && ip.To4() == nil {
		return "udp6"
	}
	return "udp4"
}

func parseStunList(data string) []string {
	servers := []string{}
	seen := map[string]bool{}
	for _, line := range strings.Split(data, "\n") {
		entry := strings.TrimSpace(line)
		entry = strings.TrimPrefix(entry, "stun:")
		if entry == "" || strings.HasPrefix(entry, "#") {
			continue
		}
		host, port, err := net.SplitHostPort(entry)
		if err != nil || host == "" || len(host) > 253 {
			continue
		}
		if _, err := strconv.Atoi(port); err != nil {
			continue
		}
		if seen[entry] {
			continue
		}
		seen[entry] = true
		servers = append(servers, entry)
		if len(servers) >= stunListMax {
			break
		}
	}
	return servers
}

func fetchStunList(url string) ([]string, error) {
	client := &http.Client{Timeout: 8 * time.Second}
	response, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("stun list status %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 512<<10))
	if err != nil {
		return nil, err
	}
	servers := parseStunList(string(data))
	if len(servers) == 0 {
		return nil, fmt.Errorf("stun list empty")
	}
	return servers, nil
}

// probeStunServer measures one binding round trip; the latency is what the STUN page shows.
func probeStunServer(server string, timeout time.Duration) (time.Duration, error) {
	host, port, err := splitStunAddress(server)
	if err != nil {
		return 0, err
	}
	network := stunNetwork(server)
	raddr, err := net.ResolveUDPAddr(network, net.JoinHostPort(host, port))
	if err != nil {
		return 0, err
	}
	conn, err := net.DialUDP(network, nil, raddr)
	if err != nil {
		return 0, err
	}
	defer func() { _ = conn.Close() }()
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return 0, err
	}
	request := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	start := time.Now()
	if _, err := conn.Write(request.Raw); err != nil {
		return 0, err
	}
	buffer := make([]byte, 1500)
	for {
		n, err := conn.Read(buffer)
		if err != nil {
			return 0, err
		}
		response := &stun.Message{Raw: buffer[:n]}
		if err := response.Decode(); err != nil {
			continue
		}
		if response.TransactionID != request.TransactionID {
			continue
		}
		var mapped stun.XORMappedAddress
		if err := mapped.GetFrom(response); err != nil {
			return 0, err
		}
		return time.Since(start), nil
	}
}

func splitStunAddress(server string) (string, string, error) {
	entry := strings.TrimPrefix(strings.TrimSpace(server), "stun:")
	host, port, err := net.SplitHostPort(entry)
	if err != nil {
		return "", "", err
	}
	if _, err := strconv.Atoi(port); err != nil {
		return "", "", err
	}
	return host, port, nil
}

// probeStunServers fans out with a bounded worker pool: a full-list sweep stays well under the
// burst the network can take, and results keep their input order.
func probeStunServers(servers []string) contracts.StunProbeResults {
	results := make([]contracts.StunProbeResult, len(servers))
	sem := make(chan struct{}, stunProbeWorkers)
	var wg sync.WaitGroup
	for index, server := range servers {
		wg.Add(1)
		go func(index int, server string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			result := contracts.StunProbeResult{Server: server}
			if rtt, err := probeStunServer(server, stunProbeTimeout); err == nil {
				latency := int(rtt.Round(time.Millisecond) / time.Millisecond)
				result.LatencyMs = &latency
			}
			results[index] = result
		}(index, server)
	}
	wg.Wait()
	return contracts.StunProbeResults{Results: results}
}

// natCheck compares this socket's mapping at two different servers: identical means the mapping
// does not depend on the remote endpoint (cone), differing means symmetric, where hole punching
// without a relay cannot work. The peers come from the cached/static NAT-testing list.
func natCheck(servers []string) contracts.NatCheckResult {
	return compareNAT(servers)
}

// natCheckAttempts bounds the fan-out: public STUN servers rot constantly, so the whole list is
// never swept — the first two answers decide and the rest of the flight is abandoned.
const natCheckAttempts = 6

// natCheckDeadline covers the whole flight: every request races at once, so one deadline bounds
// the endpoint no matter how many peers are dead.
const natCheckDeadline = 2 * time.Second

// compareNAT is the network half of natCheck, split out so tests can inject peers.
func compareNAT(servers []string) contracts.NatCheckResult {
	if len(servers) < 2 {
		return contracts.NatCheckResult{Kind: "unknown", Message: strPtr("multiplayer_nat_unreachable")}
	}
	// The check is pinned to IPv4 on purpose: custom-mode signaling and the advertised STUN
	// invite are IPv4, so a dual-stack socket could measure IPv6 (which is NAT-free and would
	// read as "cone") while the actual session traverses a strict IPv4 NAT. Measuring the same
	// family as the session is the only way the cone/symmetric verdict stays truthful.
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: 0})
	if err != nil {
		return contracts.NatCheckResult{Kind: "unknown", Message: strPtr("multiplayer_nat_unreachable")}
	}
	defer func() { _ = conn.Close() }()
	// Both mappings must come from this one socket: the comparison is only meaningful when the
	// local endpoint is fixed and the remote varies. The requests race instead of queueing, so a
	// rotten list costs the shared deadline rather than a timeout per dead server.
	requests := make(map[[stun.TransactionIDSize]byte]bool, natCheckAttempts)
	sent := 0
	for _, server := range servers {
		if sent >= natCheckAttempts {
			break
		}
		host, port, err := splitStunAddress(server)
		if err != nil {
			continue
		}
		raddr, err := net.ResolveUDPAddr("udp4", net.JoinHostPort(host, port))
		if err != nil {
			continue
		}
		request := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
		if _, err := conn.WriteToUDP(request.Raw, raddr); err != nil {
			continue
		}
		requests[request.TransactionID] = true
		sent++
	}
	if sent < 2 {
		return contracts.NatCheckResult{Kind: "unknown", Message: strPtr("multiplayer_nat_unreachable")}
	}
	if err := conn.SetReadDeadline(time.Now().Add(natCheckDeadline)); err != nil {
		return contracts.NatCheckResult{Kind: "unknown", Message: strPtr("multiplayer_nat_unreachable")}
	}
	var first, second *net.UDPAddr
	buffer := make([]byte, 1500)
	for second == nil {
		n, _, err := conn.ReadFromUDP(buffer)
		if err != nil {
			break
		}
		response := &stun.Message{Raw: buffer[:n]}
		if err := response.Decode(); err != nil {
			continue
		}
		// Consuming the ID stops retransmissions from counting a server twice.
		if !requests[response.TransactionID] {
			continue
		}
		delete(requests, response.TransactionID)
		var mapped stun.XORMappedAddress
		if err := mapped.GetFrom(response); err != nil {
			continue
		}
		addr := &net.UDPAddr{IP: mapped.IP, Port: mapped.Port}
		if first == nil {
			first = addr
		} else {
			second = addr
		}
	}
	if first == nil || second == nil {
		return contracts.NatCheckResult{Kind: "unknown", Message: strPtr("multiplayer_nat_unreachable")}
	}
	if first.IP.Equal(second.IP) && first.Port == second.Port {
		return contracts.NatCheckResult{Kind: "cone"}
	}
	return contracts.NatCheckResult{Kind: "symmetric", Message: strPtr("multiplayer_nat_symmetric")}
}

func strPtr(value string) *string { return &value }
