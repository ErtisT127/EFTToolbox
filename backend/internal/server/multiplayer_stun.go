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
	// The repository regenerates both lists on a schedule; the NAT file lists servers suited to
	// NAT-type checks and is the right peer set for the cone/symmetric comparison.
	stunListURL      = "https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_hosts.txt"
	stunNatListURL   = "https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_nat_testing_hosts.txt"
	stunListMax      = 400
	stunProbeTimeout = time.Second
	stunProbeWorkers = 12
)

func fetchStunServers() ([]string, error) {
	return fetchStunList(stunListURL)
}

func fetchStunNatServers() ([]string, error) {
	return fetchStunList(stunNatListURL)
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
	raddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, port))
	if err != nil {
		return 0, err
	}
	conn, err := net.DialUDP("udp", nil, raddr)
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

// stunMappedAddr asks a STUN server for this socket's public mapping (used by the host's STUN
// signaling socket to advertise itself).
func stunMappedAddr(conn *net.UDPConn, server string, timeout time.Duration) (*net.UDPAddr, error) {
	host, port, err := splitStunAddress(server)
	if err != nil {
		return nil, err
	}
	raddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, port))
	if err != nil {
		return nil, err
	}
	request := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	if _, err := conn.WriteToUDP(request.Raw, raddr); err != nil {
		return nil, err
	}
	if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return nil, err
	}
	buffer := make([]byte, 1500)
	for {
		n, _, err := conn.ReadFromUDP(buffer)
		if err != nil {
			return nil, err
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
			return nil, err
		}
		return &net.UDPAddr{IP: mapped.IP, Port: mapped.Port}, nil
	}
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
	conn, err := net.ListenUDP("udp", &net.UDPAddr{Port: 0})
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
		raddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, port))
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
