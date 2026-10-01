package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	defaults "efttoolbox/backend/internal/defaults"
	contracts "efttoolbox/contracts"

	"github.com/pion/stun/v4"
	"github.com/pion/webrtc/v4"
)

// multiplayerFixture assembles the same wiring as New() for one machine without touching the
// network, so tests can drive two full instances against each other over loopback.
func multiplayerFixture(t *testing.T) (string, http.Handler, *overlayHub, *multiplayerManager) {
	root, handler, hub, manager := multiplayerFixtureWithID(t, "")
	return root, handler, hub, manager
}

func TestPeerSnapshotsSerializeConcurrentSaves(t *testing.T) {
	root := t.TempDir()
	m := &multiplayerManager{
		store:      &mapStore{root: root, files: &VersionedFileStore{root: root}},
		knownPeers: map[string]peerRecord{},
	}
	const count = 32
	var wait sync.WaitGroup
	for i := 0; i < count; i++ {
		wait.Add(1)
		go func(i int) {
			defer wait.Done()
			id := fmt.Sprintf("peer-%d", i)
			m.recordPeer(id, "player", "#123456", multiplayerRoleGuest)
		}(i)
	}
	wait.Wait()
	peers := map[string]peerRecord{}
	if err := readJSON(filepath.Join(root, "user", "multiplayer-peers.json"), &peers); err != nil {
		t.Fatal(err)
	}
	if len(peers) != count {
		t.Fatalf("saved %d peers, want %d", len(peers), count)
	}
}

func multiplayerFixtureWithID(t *testing.T, peerID string) (string, http.Handler, *overlayHub, *multiplayerManager) {
	t.Helper()
	root, store, hub := mapStoreFixture(t)
	manager := newMultiplayerManager(t.Context(), hub)
	// Leave synchronously before the TempDir cleanup runs: the ctx-driven leave races it on
	// Windows otherwise (the async goroutine can still be writing when RemoveAll walks the tree).
	t.Cleanup(func() { manager.leave() })
	if peerID != "" {
		manager.mu.Lock()
		manager.settings.PlayerId = peerID
		manager.mu.Unlock()
	}
	hub.multiplayer = manager
	store.multiplayer = manager
	store.changed = hub.changed
	mux := http.NewServeMux()
	store.register(mux)
	hub.register(mux)
	manager.register(mux)
	return root, mux, hub, manager
}

func mapStoreFixture(t *testing.T) (string, *mapStore, *overlayHub) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "upstream", "modes", "pvp", "maps"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := contracts.MapData{SchemaVersion: 1, Id: "fixture", Name: "Fixture", DefaultFloor: "ground", Projection: contracts.Projection{ViewBox: []float64{0, 0, 100, 100}, Bounds: []contracts.WorldXZ{{X: 0, Z: 0}, {X: 100, Z: 100}}}, Floors: []contracts.Floor{{Id: "ground", Name: "Ground", SvgGroups: []string{"ground"}}}, Categories: []contracts.Category{}, Markers: []contracts.BuiltinMarker{}, Tasks: []contracts.MapTask{}, Warnings: []string{}}
	data, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(root, "upstream", "modes", "pvp", "maps", "fixture_zh.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	store := &mapStore{root: root, files: &VersionedFileStore{root: root}}
	repo, err := newModeRepository(root, "pvp")
	if err != nil {
		t.Fatal(err)
	}
	store.setRepository(repo)
	hub := &overlayHub{store: store, status: contracts.Status{ProtocolVersion: "1"}, players: map[string]contracts.PlayerState{}, clients: map[chan contracts.ServerEvent]bool{}}
	return root, store, hub
}

func localCall(handler http.Handler, method, path string, value any) *httptest.ResponseRecorder {
	var body []byte
	if value != nil {
		body, _ = json.Marshal(value)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.RemoteAddr = "127.0.0.1:1234"
	request.Host = "localhost"
	request.Header.Set("Content-Type", "application/json")
	if method == http.MethodPut {
		get := httptest.NewRequest(http.MethodGet, path, nil)
		get.RemoteAddr, get.Host = request.RemoteAddr, request.Host
		current := httptest.NewRecorder()
		handler.ServeHTTP(current, get)
		request.Header.Set("If-Match", current.Header().Get("ETag"))
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

// TestMultiplayerInvite locks the structured invite contract for both hosting modes: the share
// text is assembled on the Dashboard from these fields, so the backend must emit exactly
// "mode / host as address:port / optional stun server / key" and nothing else.
func TestMultiplayerInvite(t *testing.T) {
	_, _, _, manager := multiplayerFixture(t)
	t.Cleanup(manager.leave)

	status, failure := manager.host(contracts.MultiplayerHostRequest{Mode: multiplayerModeCustom, Address: stringPtr("127.0.0.1"), Port: "0", Key: stringPtr("testkey0000000000")})
	if failure != nil {
		t.Fatalf("custom host: %+v", failure)
	}
	invite := status.Invite
	if invite == nil {
		t.Fatal("custom status has no invite")
	}
	if invite.Mode != multiplayerModeCustom || invite.Key != "testkey0000000000" || invite.StunServer != nil {
		t.Fatalf("custom invite fields: %+v", invite)
	}
	if host, port, err := net.SplitHostPort(invite.Host); err != nil || host != "127.0.0.1" || port == "" {
		t.Fatalf("custom invite host must be address:port: %q", invite.Host)
	}
	manager.leave()

	stunServer := fakeStunServer(t, func(from *net.UDPAddr) *net.UDPAddr { return from })
	stunStatus, failure := manager.host(contracts.MultiplayerHostRequest{Mode: multiplayerModeStun, Address: stringPtr(""), Port: "0", StunServer: stringPtr(stunServer), Key: stringPtr("testkey0000000001")})
	if failure != nil {
		t.Fatalf("stun host: %+v", failure)
	}
	invite = stunStatus.Invite
	if invite == nil {
		t.Fatal("stun status has no invite")
	}
	if invite.Mode != multiplayerModeStun || invite.Key != "testkey0000000001" || invite.StunServer == nil || *invite.StunServer != stunServer {
		t.Fatalf("stun invite fields: %+v", invite)
	}
	if _, _, err := net.SplitHostPort(invite.Host); err != nil {
		t.Fatalf("stun invite host must be address:port: %q", invite.Host)
	}
}

// TestSignalRequestValidation covers the custom-mode TCP signaler: request shape, key gate,
// room capacity, and answer propagation all use the shared signal schema error codes.
func TestSignalRequestValidation(t *testing.T) {
	newListener := func(capacity bool, accept func(string) (string, *apiFailure)) *signalListener {
		return &signalListener{key: "roomkey123", capacity: func() bool { return capacity }, accept: accept}
	}
	call := func(s *signalListener, envelope any) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		body, _ := json.Marshal(envelope)
		request := httptest.NewRequest(http.MethodPost, "/signal", bytes.NewReader(body))
		s.handleSignal(response, request)
		return response
	}
	decode := func(t *testing.T, response *httptest.ResponseRecorder, key string) contracts.SignalPayloadResponse {
		t.Helper()
		var envelope signalResponse
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("signal response body: %s", response.Body.String())
		}
		var payload contracts.SignalPayloadResponse
		if err := openSignal(key, envelope.Nonce, envelope.Payload, &payload); err != nil {
			t.Fatalf("open signal response: %v", err)
		}
		return payload
	}

	accepting := newListener(true, func(offer string) (string, *apiFailure) { return "answer:" + offer, nil })
	request, _ := sealSignal("roomkey123", contracts.SignalPayloadRequest{Offer: "offer-sdp"})
	response := call(accepting, request)
	if response.Code != http.StatusOK {
		t.Fatalf("valid signal rejected: %d %s", response.Code, response.Body.String())
	}
	if body := decode(t, response, "roomkey123"); body.Answer != "answer:offer-sdp" {
		t.Fatalf("signal answer mismatch: %+v", body)
	}

	response = call(accepting, map[string]string{"nonce": "bad", "payload": "bad"})
	if response.Code != http.StatusBadRequest || decode(t, response, "roomkey123").Error != contracts.SignalErrorMultiplayerSignalInvalid {
		t.Fatalf("malformed envelope response: %d %s", response.Code, response.Body.String())
	}
	missingOffer, _ := sealSignal("roomkey123", contracts.SignalPayloadRequest{})
	response = call(accepting, missingOffer)
	if response.Code != http.StatusBadRequest || decode(t, response, "roomkey123").Error != contracts.SignalErrorMultiplayerSignalInvalid {
		t.Fatalf("missing offer response: %d %s", response.Code, response.Body.String())
	}
	wrongKey, _ := sealSignal("badkey", contracts.SignalPayloadRequest{Offer: "offer-sdp"})
	response = call(accepting, wrongKey)
	var wrongKeyReply signalResponse
	if json.Unmarshal(response.Body.Bytes(), &wrongKeyReply) != nil || response.Code != http.StatusForbidden {
		t.Fatalf("wrong key response: %d %s", response.Code, response.Body.String())
	}
	var invalidKey contracts.SignalPayloadResponse
	if err := openSignal("badkey", wrongKeyReply.Nonce, wrongKeyReply.Payload, &invalidKey); err == nil {
		t.Fatal("wrong-key caller decrypted host response")
	}
	if body := decode(t, response, "roomkey123"); body.Error != contracts.SignalErrorMultiplayerKeyInvalid {
		t.Fatalf("wrong-key error: %+v", body)
	}

	full := newListener(false, func(string) (string, *apiFailure) { return "", nil })
	response = call(full, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("full room: status %d, want 503", response.Code)
	}
	if body := decode(t, response, "roomkey123"); body.Error != contracts.SignalErrorMultiplayerRoomFull {
		t.Fatalf("full room: error %q", body.Error)
	}

	failing := newListener(true, func(string) (string, *apiFailure) {
		return "", failDetail(http.StatusForbidden, "multiplayer_key_invalid", "detail-x")
	})
	response = call(failing, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("accept failure: status %d, want 403", response.Code)
	}
	if body := decode(t, response, "roomkey123"); body.Error != contracts.SignalErrorMultiplayerKeyInvalid || body.Detail != "detail-x" {
		t.Fatalf("accept failure: %+v", body)
	}
}

// TestStunSignalValidation covers the STUN-mode UDP signaler, which consumes the same
// signalRequest schema over datagrams and replies with the same signalResponse codes.
func TestStunSignalValidation(t *testing.T) {
	stunServer := fakeStunServer(t, func(from *net.UDPAddr) *net.UDPAddr { return from })
	signaler, mapped, failure := bindStunSignaling(stunServer)
	if failure != nil {
		t.Fatalf("bind stun signaler: %+v", failure)
	}
	var accepted atomic.Bool
	listener := newStunListener(signaler, "roomkey123", func() bool { return true }, func(offer string) (string, *apiFailure) {
		accepted.Store(true)
		return "answer:" + offer, nil
	})
	t.Cleanup(listener.close)

	client, err := net.DialUDP("udp", nil, mapped)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	exchange := func(t *testing.T, envelope signalRequest) contracts.SignalPayloadResponse {
		t.Helper()
		body, _ := json.Marshal(envelope)
		if _, err := client.Write(body); err != nil {
			t.Fatal(err)
		}
		buffer := make([]byte, 4096)
		if err := client.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
			t.Fatal(err)
		}
		n, err := client.Read(buffer)
		if err != nil {
			t.Fatalf("no datagram reply: %v", err)
		}
		var response signalResponse
		if err := json.Unmarshal(buffer[:n], &response); err != nil {
			t.Fatalf("invalid response envelope: %s", buffer[:n])
		}
		var payload contracts.SignalPayloadResponse
		if err := openSignal("roomkey123", response.Nonce, response.Payload, &payload); err != nil {
			t.Fatalf("cannot open response: %v", err)
		}
		return payload
	}

	if payload := exchange(t, signalRequest{Nonce: "bad", Payload: "bad"}); payload.Error != contracts.SignalErrorMultiplayerSignalInvalid {
		t.Fatalf("malformed envelope response: %+v", payload)
	}
	request, _ := sealSignal("roomkey123", contracts.SignalPayloadRequest{Offer: "offer-sdp"})
	if payload := exchange(t, request); payload.Answer != "answer:offer-sdp" || !accepted.Load() {
		t.Fatalf("valid stun signal: %+v", payload)
	}
	wrongKey, _ := sealSignal("badkey", contracts.SignalPayloadRequest{Offer: "offer-sdp"})
	body, _ := json.Marshal(wrongKey)
	if _, err := client.Write(body); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 4096)
	if err := client.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	n, err := client.Read(buffer)
	if err != nil {
		t.Fatalf("no wrong-key reply: %v", err)
	}
	var response signalResponse
	if err := json.Unmarshal(buffer[:n], &response); err != nil {
		t.Fatalf("invalid wrong-key response: %s", buffer[:n])
	}
	var invalidKey contracts.SignalPayloadResponse
	if err := openSignal("badkey", response.Nonce, response.Payload, &invalidKey); err == nil {
		t.Fatal("wrong-key caller decrypted response")
	}
	if _, failure := signalStun(mapped.String(), "badkey", "offer-sdp"); failure == nil || failure.code != "multiplayer_key_invalid" {
		t.Fatalf("wrong-key join failure: %+v", failure)
	}
	if _, failure := signalStun(mapped.String(), "roomkey123", strings.Repeat("x", 50<<10)); failure == nil || failure.code != "multiplayer_signal_invalid" {
		t.Fatalf("oversized STUN offer failure: %+v", failure)
	}
}

func TestStunKeepaliveRefreshesMapping(t *testing.T) {
	oldInterval := stunKeepaliveInterval
	stunKeepaliveInterval = 20 * time.Millisecond
	defer func() { stunKeepaliveInterval = oldInterval }()
	requests := make(chan struct{}, 8)
	stunServer := fakeStunServerObserved(t, "udp", net.IPv4(127, 0, 0, 1), func(from *net.UDPAddr) *net.UDPAddr { return from }, func() {
		requests <- struct{}{}
	})
	signaler, _, failure := bindStunSignaling(stunServer)
	if failure != nil {
		t.Fatalf("bind stun signaler: %+v", failure)
	}
	select {
	case <-requests: // initial mapping probe
	case <-time.After(time.Second):
		t.Fatal("initial BindingRequest was not received")
	}
	listener := newStunListener(signaler, "roomkey123", func() bool { return true }, func(string) (string, *apiFailure) { return "", nil })
	for range 2 {
		select {
		case <-requests:
		case <-time.After(time.Second):
			listener.close()
			t.Fatal("keepalive BindingRequest was not received")
		}
	}
	closed := make(chan struct{})
	go func() { listener.close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("stun signaler close blocked")
	}
}

func TestJoiningPeerTimeout(t *testing.T) {
	oldTimeout := joinTimeout
	joinTimeout = 100 * time.Millisecond
	defer func() { joinTimeout = oldTimeout }()
	_, _, _, manager := multiplayerFixture(t)
	manager.mu.Lock()
	manager.role = multiplayerRoleHost
	manager.mode = multiplayerModeCustom
	manager.mu.Unlock()
	guest, err := manager.newPeerConnection(multiplayerModeCustom, "")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = guest.Close() }()
	ordered := true
	if _, err := guest.CreateDataChannel("ctl", &webrtc.DataChannelInit{Ordered: &ordered}); err != nil {
		t.Fatal(err)
	}
	unordered := false
	if _, err := guest.CreateDataChannel("pos", &webrtc.DataChannelInit{Ordered: &unordered}); err != nil {
		t.Fatal(err)
	}
	offer, err := guest.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(guest)
	if err := guest.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	if _, failure := manager.acceptGuest(guest.LocalDescription().SDP); failure != nil {
		t.Fatalf("accept offer: %+v", failure)
	}
	waitFor(t, time.Second, func() bool {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		return len(manager.joining) == 0
	})
}

func TestJoiningPeerTimeoutRejectsLateHello(t *testing.T) {
	_, _, _, manager := multiplayerFixture(t)
	manager.mu.Lock()
	manager.role = multiplayerRoleHost
	peer := &multiplayerPeer{id: "0123456789abcdef"}
	manager.joining[peer] = true
	manager.mu.Unlock()

	manager.dropPeerIf("", "join_timeout", peer)
	manager.handleHello(peer, mustJSON(wireHello{PeerId: peer.id, Name: "late", Color: "#123456"}))

	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.peers) != 0 || len(manager.joining) != 0 {
		t.Fatalf("late hello restored timed-out peer: peers=%d joining=%d", len(manager.peers), len(manager.joining))
	}
}

func TestPeerRoundTripTimeUsesSelectedCandidatePair(t *testing.T) {
	report := webrtc.StatsReport{
		"pair": webrtc.ICECandidatePairStats{
			State:                webrtc.StatsICECandidatePairStateSucceeded,
			Nominated:            true,
			CurrentRoundTripTime: 0.127,
		},
	}
	rtt, ok := peerRoundTripTime(report)
	if !ok || rtt != 127*time.Millisecond {
		t.Fatalf("peer RTT = %v, %v; want 127ms", rtt, ok)
	}
	if _, ok := peerRoundTripTime(webrtc.StatsReport{"transport": webrtc.TransportStats{}}); ok {
		t.Fatal("missing selected candidate pair returned an RTT")
	}
}

// TestStunListenerOutlivesProbeDeadline confirms the signaling path remains live after the
// initial mapping probe has completed on the shared UDP socket.
func TestStunListenerOutlivesProbeDeadline(t *testing.T) {
	stunServer := fakeStunServer(t, func(from *net.UDPAddr) *net.UDPAddr { return from })
	signaler, mapped, failure := bindStunSignaling(stunServer)
	if failure != nil {
		t.Fatalf("bind stun signaling: %+v", failure)
	}
	listener := newStunListener(signaler, "roomkey123", func() bool { return true }, func(offer string) (string, *apiFailure) {
		return "answer:" + offer, nil
	})
	t.Cleanup(listener.close)

	time.Sleep(3200 * time.Millisecond)
	client, err := net.DialUDP("udp", nil, mapped)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	request, _ := sealSignal("roomkey123", contracts.SignalPayloadRequest{Offer: "offer-sdp"})
	body, _ := json.Marshal(request)
	if _, err := client.Write(body); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 4096)
	if err := client.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	n, err := client.Read(buffer)
	if err != nil {
		t.Fatalf("no stun signal reply after probe deadline: %v", err)
	}
	var response signalResponse
	var decode contracts.SignalPayloadResponse
	if json.Unmarshal(buffer[:n], &response) != nil || openSignal("roomkey123", response.Nonce, response.Payload, &decode) != nil || decode.Answer != "answer:offer-sdp" {
		t.Fatalf("unexpected stun signal reply: %s", buffer[:n])
	}
}

// TestUnknownWireTypeRejectsPeer locks the wire envelope contract: only the schema-declared
// frame types are accepted, and an unknown type must not mutate room state.
func TestUnknownWireTypeRejectsPeer(t *testing.T) {
	_, _, hub, manager := multiplayerFixture(t)
	_ = hub
	manager.mu.Lock()
	manager.role = multiplayerRoleHost
	manager.peers["aaaaaaaaaaaaaaaa"] = &multiplayerPeer{id: "aaaaaaaaaaaaaaaa"}
	manager.mu.Unlock()

	manager.handleCtlMessage(&multiplayerPeer{}, wireEnvelope{Type: "mystery", Data: mustJSON(map[string]string{"x": "y"})})
	manager.handleCtlMessage(&multiplayerPeer{}, wireEnvelope{Type: strings.ToUpper(contracts.WireTypePos)})

	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.peers) != 1 || manager.roster != nil || manager.role != multiplayerRoleHost {
		t.Fatalf("unknown wire type mutated room state: peers=%d roster=%v role=%q", len(manager.peers), manager.roster, manager.role)
	}
}

func TestRemoteAnnotationCacheRejectsInvalidAndExcessDocuments(t *testing.T) {
	_, _, _, manager := multiplayerFixture(t)
	invalid := []contracts.Annotation{{Id: "bad", FloorId: "missing"}}
	if manager.applyRemoteAnnotations("peer-id", "fixture", invalid) {
		t.Fatal("invalid annotations were accepted")
	}
	if len(manager.remoteDocs) != 0 {
		t.Fatal("invalid annotations remained cached")
	}
	for i := range multiplayerMaxRemoteDocuments {
		mapID := "remote-map-" + strconv.Itoa(i)
		if !manager.applyRemoteAnnotations("peer-id", mapID, []contracts.Annotation{}) {
			t.Fatalf("valid remote document %d was rejected", i)
		}
	}
	if manager.applyRemoteAnnotations("peer-id", "overflow", []contracts.Annotation{}) {
		t.Fatal("remote document cache exceeded its limit")
	}
	if manager.applyRemoteAnnotations("peer-id", "../invalid", []contracts.Annotation{}) {
		t.Fatal("invalid map id was accepted")
	}
}

func TestStunListParsing(t *testing.T) {
	// A fake always-online-stun endpoint: hostname entries, a stun: prefix, junk, duplicates, and
	// bracketed IPv6 literals (the IP list format).
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("stun.example.com:3478\nexample.org:3478\nstun:paired.example.net:3478\nnot a host\nstun.example.com:3478\n# comment\n\ndead.example:port\n[2001:db8::1]:3478\n[2001:db8::1]:3478\n[2001:db8::2]:443\n"))
	}))
	defer func() { server.Close() }()

	servers, err := fetchStunList(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"stun.example.com:3478", "example.org:3478", "paired.example.net:3478", "[2001:db8::1]:3478", "[2001:db8::2]:443"}
	if len(servers) != len(want) {
		t.Fatalf("parsed %v", servers)
	}
	for index, entry := range want {
		if servers[index] != entry {
			t.Fatalf("parsed %v, want %v", servers, want)
		}
	}
}

// TestStunNetworkPicksFamily locks the family rule every STUN socket shares: bracketed IPv6 uses
// udp6, while hostnames and IPv4 literals stay on udp4 so a name that also has AAAA records cannot
// silently move a session onto IPv6.
func TestStunNetworkPicksFamily(t *testing.T) {
	for endpoint, want := range map[string]string{
		"[2001:db8::1]:3478":  "udp6",
		"[::1]:3478":          "udp6",
		"203.0.113.7:3478":    "udp4",
		"stun.example.com:34": "udp4",
	} {
		if got := stunNetwork(endpoint); got != want {
			t.Fatalf("stunNetwork(%q) = %q, want %q", endpoint, got, want)
		}
	}
}

func TestPortSelection(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	occupied := listener.Addr().(*net.TCPAddr).Port

	_, _, failure := bindRoomSockets(net.ParseIP("127.0.0.1"), strconv.Itoa(occupied))
	if failure == nil || failure.code != "multiplayer_port_in_use" || failure.detail != strconv.Itoa(occupied) {
		t.Fatalf("occupied port: %+v", failure)
	}
	zeroListener, _, zeroFailure := bindRoomSockets(net.ParseIP("127.0.0.1"), "0")
	if zeroFailure != nil {
		t.Fatalf("port 0 should mean auto: %+v", zeroFailure)
	}
	if zeroListener != nil {
		_ = zeroListener.Close()
	}

	tcpListener, port, failure := bindRoomSockets(net.ParseIP("127.0.0.1"), "")
	if failure != nil {
		t.Fatalf("empty port should mean auto: %+v", failure)
	}
	defer func() { _ = tcpListener.Close() }()
	if port < 1 || port > 65535 {
		t.Fatalf("auto port out of range: %d", port)
	}
}

func TestHeartbeatWindow(t *testing.T) {
	base := time.Now()
	peer := &multiplayerPeer{lastPong: base}

	if peer.evaluateHeartbeat(base.Add(1300 * time.Millisecond)) {
		t.Fatal("single miss dropped early")
	}
	if peer.evaluateHeartbeat(base.Add(2300 * time.Millisecond)) {
		t.Fatal("two misses dropped early")
	}
	if !peer.unstable {
		t.Fatal("two misses did not flag unstable")
	}
	if !peer.evaluateHeartbeat(base.Add(6300 * time.Millisecond)) {
		t.Fatal("5s window did not drop")
	}

	peer = &multiplayerPeer{lastPong: base}
	peer.evaluateHeartbeat(base.Add(1300 * time.Millisecond))
	peer.lastPong = base.Add(1300 * time.Millisecond) // a pong arrives within the window
	if peer.evaluateHeartbeat(base.Add(2300 * time.Millisecond)) {
		t.Fatal("recovered peer dropped")
	}
	if peer.unstable {
		t.Fatal("recovered peer still unstable")
	}
}

// TestStunSignalingIPv6 locks the IPv6 STUN path: bindStunSignaling picks udp6 from the bracketed
// address, the mapping comes back as ::1, and signalStun reaches the listener on the same family.
func TestStunSignalingIPv6(t *testing.T) {
	stunServer := fakeStunServerOn(t, "udp6", net.ParseIP("::1"), func(from *net.UDPAddr) *net.UDPAddr { return from })
	signaler, mapped, failure := bindStunSignaling(stunServer)
	if failure != nil {
		t.Skipf("IPv6 loopback STUN unavailable: %+v", failure)
	}
	if mapped.IP.To4() != nil {
		t.Fatalf("STUN mapping is not IPv6: %v", mapped)
	}
	listener := newStunListener(signaler, "roomkey123", func() bool { return true }, func(offer string) (string, *apiFailure) {
		return "answer:" + offer, nil
	})
	t.Cleanup(listener.close)

	answer, failure := signalStun(mapped.String(), "roomkey123", "offer-sdp")
	if failure != nil {
		t.Fatalf("signal stun over IPv6: %+v", failure)
	}
	if answer != "answer:offer-sdp" {
		t.Fatalf("unexpected answer: %q", answer)
	}
}

// TestHostJoinLoopbackIPv6 covers the custom-mode IPv6 path on ::1: the invite carries a bracketed
// IPv6 address and the guest reaches the host, so the unicast validation, tcp listener, and
// host:port formatting are all exercised without a real IPv6 LAN.
func TestHostJoinLoopbackIPv6(t *testing.T) {
	_, _, _, hostManager := multiplayerFixtureWithID(t, "cccccccccccccccc")
	_, _, _, guestManager := multiplayerFixtureWithID(t, "dddddddddddddddd")

	status, failure := hostManager.host(contracts.MultiplayerHostRequest{Mode: multiplayerModeCustom, Address: stringPtr("::1"), Port: "0", Key: stringPtr("testkey0000000002")})
	if failure != nil {
		t.Skipf("IPv6 loopback unavailable: %+v", failure)
	}
	if status.Invite == nil {
		t.Fatal("IPv6 host has no invite")
	}
	if host, _, err := net.SplitHostPort(status.Invite.Host); err != nil || host != "::1" {
		t.Fatalf("invite host must be bracketed IPv6: %q", status.Invite.Host)
	}
	guestStatus, failure := guestManager.join(contracts.MultiplayerJoinRequest{Mode: multiplayerModeCustom, Address: net.JoinHostPort("::1", strconv.Itoa(*status.Port)), Key: "testkey0000000002"})
	if failure != nil {
		t.Skipf("IPv6 loopback ICE unavailable: %+v", failure)
	}
	if !guestStatus.Enabled {
		t.Fatal("guest status not enabled after IPv6 join")
	}
	guestID := guestStatus.Self.PeerId
	waitFor(t, 5*time.Second, func() bool {
		members := hostManager.status().Members
		return members != nil && len(*members) == 1 && (*members)[0].PeerId == guestID
	})
}

// TestHostJoinStunEndpoint exercises the structured STUN invite through the public join path.
// In particular, join splits the invite into host and port before dial must put them back
// together for the UDP signaling socket.
func TestHostJoinStunEndpoint(t *testing.T) {
	_, _, _, hostManager := multiplayerFixtureWithID(t, "eeeeeeeeeeeeeeee")
	_, _, _, guestManager := multiplayerFixtureWithID(t, "ffffffffffffffff")
	stunServer := fakeStunServer(t, func(from *net.UDPAddr) *net.UDPAddr { return from })

	status, failure := hostManager.host(contracts.MultiplayerHostRequest{
		Mode:       multiplayerModeStun,
		StunServer: stringPtr(stunServer),
		Key:        stringPtr("testkey0000000003"),
	})
	if failure != nil {
		t.Skipf("STUN host unavailable: %+v", failure)
	}
	if status.Invite == nil || status.Invite.StunServer == nil {
		t.Fatal("STUN host did not return a complete invite")
	}

	guestStatus, failure := guestManager.join(contracts.MultiplayerJoinRequest{
		Mode:       multiplayerModeStun,
		Address:    status.Invite.Host,
		StunServer: status.Invite.StunServer,
		Key:        status.Invite.Key,
	})
	if failure != nil {
		if failure.code == "multiplayer_share_invalid" {
			t.Fatalf("STUN join lost the invite port: %+v", failure)
		}
		t.Skipf("STUN ICE unavailable: %+v", failure)
	}
	if !guestStatus.Enabled {
		t.Fatal("guest status not enabled after STUN join")
	}
}

func TestParseJoinEndpoint(t *testing.T) {
	tests := []struct {
		name  string
		input string
		host  string
		port  string
		ok    bool
	}{
		{name: "ipv4", input: "127.0.0.1:1234", host: "127.0.0.1", port: "1234", ok: true},
		{name: "ipv6", input: "[::1]:1234", host: "::1", port: "1234", ok: true},
		{name: "bare ipv6", input: "::1:1234"},
		{name: "missing port", input: "127.0.0.1"},
		{name: "zero port", input: "127.0.0.1:0"},
		{name: "port overflow", input: "127.0.0.1:65536"},
		{name: "hostname", input: "localhost:1234"},
		{name: "link-local", input: "[fe80::1]:1234"},
		{name: "zone", input: "[fe80::1%12]:1234"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			host, port, ok := parseJoinEndpoint(test.input)
			if ok != test.ok || host != test.host || port != test.port {
				t.Fatalf("parseJoinEndpoint(%q) = (%q, %q, %v), want (%q, %q, %v)", test.input, host, port, ok, test.host, test.port, test.ok)
			}
		})
	}
}

func fakeRFC5780Server(t *testing.T, changeSource, includeOther bool) string {
	t.Helper()
	primary, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	alternate, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 2)})
	if err != nil {
		_ = primary.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = primary.Close()
		_ = alternate.Close()
	})
	go func() {
		buffer := make([]byte, 1500)
		for {
			n, from, err := primary.ReadFromUDP(buffer)
			if err != nil {
				return
			}
			message := &stun.Message{Raw: append([]byte(nil), buffer[:n]...)}
			if message.Decode() != nil || message.Type != stun.BindingRequest {
				continue
			}
			response := &stun.Message{TransactionID: message.TransactionID}
			if err := stun.BindingSuccess.AddTo(response); err != nil {
				continue
			}
			if err := (stun.XORMappedAddress{IP: from.IP, Port: from.Port}).AddTo(response); err != nil {
				continue
			}
			if includeOther {
				other := alternate.LocalAddr().(*net.UDPAddr)
				otherAddress := stun.OtherAddress{IP: other.IP, Port: other.Port}
				if err := otherAddress.AddTo(response); err != nil {
					continue
				}
			}
			response.Encode()
			writer := primary
			if changeSource {
				if value, err := message.Get(stun.AttrChangeRequest); err == nil && bytes.Equal(value, []byte{0, 0, 0, 6}) {
					writer = alternate
				}
			}
			_, _ = writer.WriteToUDP(response.Raw, from)
		}
	}()
	return primary.LocalAddr().String()
}

func fakeStunServer(t *testing.T, mapped func(from *net.UDPAddr) *net.UDPAddr) string {
	t.Helper()
	return fakeStunServerObserved(t, "udp", net.IPv4(127, 0, 0, 1), mapped, nil)
}

func fakeStunServerOn(t *testing.T, network string, ip net.IP, mapped func(from *net.UDPAddr) *net.UDPAddr) string {
	t.Helper()
	return fakeStunServerObserved(t, network, ip, mapped, nil)
}

func fakeStunServerObserved(t *testing.T, network string, ip net.IP, mapped func(from *net.UDPAddr) *net.UDPAddr, onRequest func()) string {
	t.Helper()
	conn, err := net.ListenUDP(network, &net.UDPAddr{IP: ip})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	go func() {
		buffer := make([]byte, 1500)
		for {
			n, from, err := conn.ReadFromUDP(buffer)
			if err != nil {
				return
			}
			message := &stun.Message{Raw: append([]byte(nil), buffer[:n]...)}
			if message.Decode() != nil || message.Type != stun.BindingRequest {
				continue
			}
			if onRequest != nil {
				onRequest()
			}
			source := mapped(from)
			// Echo the request's transaction id: the probe matches on it.
			response := &stun.Message{TransactionID: message.TransactionID}
			if err := stun.BindingSuccess.AddTo(response); err != nil {
				continue
			}
			if err := (stun.XORMappedAddress{IP: source.IP, Port: source.Port}).AddTo(response); err != nil {
				continue
			}
			response.Encode()
			_, _ = conn.WriteToUDP(response.Raw, from)
		}
	}()
	return conn.LocalAddr().String()
}

func TestNatCheck(t *testing.T) {
	// Loopback has no NAT: both servers see the same source, which reads as cone.
	honest := fakeStunServer(t, func(from *net.UDPAddr) *net.UDPAddr { return from })
	liar := fakeStunServer(t, func(from *net.UDPAddr) *net.UDPAddr {
		return &net.UDPAddr{IP: net.IPv4(10, 9, 8, 7), Port: from.Port + 1}
	})

	if result := compareNAT([]string{honest, honest}); result.Kind != "cone" {
		t.Fatalf("honest pair: %+v", result)
	}
	if result := compareNAT([]string{honest, liar}); result.Kind != "symmetric" {
		t.Fatalf("liar pair: %+v", result)
	}
	if result := compareNAT([]string{honest, "127.0.0.1:1"}); result.Kind != "unknown" {
		t.Fatalf("unreachable pair: %+v", result)
	}
}

func TestNATFilteringRequiresRFC5780ChangedSource(t *testing.T) {
	working := fakeRFC5780Server(t, true, true)
	if endpointIndependent, supported := probeNATFilteringServer(working, time.Now().Add(time.Second)); !endpointIndependent || !supported {
		t.Fatalf("RFC 5780 server was not accepted: endpointIndependent=%t supported=%t", endpointIndependent, supported)
	}

	ignored := fakeRFC5780Server(t, false, true)
	if endpointIndependent, supported := probeNATFilteringServer(ignored, time.Now().Add(time.Second)); endpointIndependent || !supported {
		t.Fatalf("server ignoring CHANGE-REQUEST was accepted: endpointIndependent=%t supported=%t", endpointIndependent, supported)
	}

	unsupported := fakeRFC5780Server(t, true, false)
	if endpointIndependent, supported := probeNATFilteringServer(unsupported, time.Now().Add(time.Second)); endpointIndependent || supported {
		t.Fatalf("server without OTHER-ADDRESS was accepted: endpointIndependent=%t supported=%t", endpointIndependent, supported)
	}
}

func TestRoomCapacityAtHello(t *testing.T) {
	_, _, hub, manager := multiplayerFixture(t)
	_ = hub
	manager.mu.Lock()
	manager.role = multiplayerRoleHost
	for index := 0; index < multiplayerMaxMembers-1; index++ {
		manager.peers[strconv.Itoa(index)] = &multiplayerPeer{id: strconv.Itoa(index)}
	}
	manager.mu.Unlock()

	pending := &multiplayerPeer{lastPong: time.Now()}
	hello := mustJSON(wireHello{PeerId: "aaaaaaaaaaaaaaaa", Name: "Late", Color: "#d4a24e"})
	manager.handleCtlMessage(pending, wireEnvelope{Type: "hello", Data: hello})
	manager.mu.Lock()
	count := len(manager.peers)
	manager.mu.Unlock()
	if count != multiplayerMaxMembers-1 {
		t.Fatalf("over-capacity hello accepted: %d peers", count)
	}
}

// TestHostJoinLoopbackSync covers the core cross-machine behavior on loopback: roster exchange,
// position relay, annotation merge, and the leave/rejoin marker lifecycle rules.
func TestHostJoinLoopbackSync(t *testing.T) {
	hostRoot, hostHandler, hostHub, hostManager := multiplayerFixtureWithID(t, "aaaaaaaaaaaaaaaa")
	guestRoot, guestHandler, guestHub, guestManager := multiplayerFixtureWithID(t, "bbbbbbbbbbbbbbbb")
	for _, root := range []string{hostRoot, guestRoot} {
		path := filepath.Join(root, "upstream", "modes", "pvp", "maps", "fixture_zh.json")
		var data contracts.MapData
		if err := readJSON(path, &data); err != nil {
			t.Fatal(err)
		}
		data.Projection.Rotation = 37
		encoded, err := json.Marshal(data)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	status, failure := hostManager.host(contracts.MultiplayerHostRequest{Mode: multiplayerModeCustom, Address: stringPtr("127.0.0.1"), Port: "0", Key: stringPtr("testkey0000000000")})
	if failure != nil {
		t.Fatalf("host: %+v", failure)
	}
	guestStatus, failure := guestManager.join(contracts.MultiplayerJoinRequest{Mode: multiplayerModeCustom, Address: net.JoinHostPort("127.0.0.1", strconv.Itoa(*status.Port)), Key: "testkey0000000000"})
	if failure != nil {
		t.Fatalf("join: %+v", failure)
	}
	if !guestStatus.Enabled {
		t.Fatal("guest status not enabled after join")
	}
	hostID := status.Self.PeerId
	guestID := guestStatus.Self.PeerId
	waitFor(t, 5*time.Second, func() bool {
		members := hostManager.status().Members
		return members != nil && len(*members) == 1 && (*members)[0].PeerId == guestID
	})

	// Position: the host's self player is relayed and projected on the guest with the guest's
	// own calibration (map fixture exists on both sides).
	self, err := hostHub.projectPlayer(playerInput{
		PlayerId: "self", DisplayName: "房主", IsSelf: true, MapId: "fixture",
		WorldPosition: contracts.WorldPosition{X: 10, Y: 20, Z: 3}, Heading: 90,
	})
	if err != nil {
		t.Fatalf("project host player: %v", err)
	}
	self.Color = "#d4a24e"
	hostHub.mu.Lock()
	hostHub.players["self"] = self
	hostHub.mu.Unlock()
	hostHub.publish(contracts.ServerEvent{Type: "player_upsert", Player: &self})
	waitFor(t, 5*time.Second, func() bool {
		guestHub.mu.Lock()
		defer guestHub.mu.Unlock()
		player, ok := guestHub.players[hostID]
		return ok && player.WorldPosition.X == 10 && player.IsSelf == false && player.Color == "#d4a24e" &&
			player.WorldHeading == self.WorldHeading && math.Abs(player.Heading-self.Heading) < 0.001
	})

	// Annotation: the guest draws a marker; the host's file gains it under the guest's owner id.
	owner := multiplayerOwnerID(t, guestHandler)
	doc := contracts.Annotations{SchemaVersion: 1, Items: []contracts.Annotation{{Id: "guest-mark", OwnerId: owner, FloorId: "ground", Kind: "marker", Points: []contracts.MapPoint{{X: 5, Y: 5}}, Color: "#5FD3C4", Width: 3, TextSize: 15}}}
	if response := localCall(guestHandler, "PUT", "/api/maps/fixture/annotations", doc); response.Code != 200 {
		t.Fatalf("guest annotation put: %s", response.Body.String())
	}
	waitFor(t, 5*time.Second, func() bool {
		response := localCall(hostHandler, "GET", "/api/maps/fixture/annotations", nil)
		return response.Code == 200 && strings.Contains(response.Body.String(), `"ownerId":"`+guestID+`"`)
	})

	// The guest leaving keeps its markers on the host (data stays, panel hides it by default);
	// the host dissolving the room afterwards cleans all foreign markers.
	guestManager.leave()
	waitFor(t, 5*time.Second, func() bool {
		members := hostManager.status().Members
		return members != nil && len(*members) == 0
	})
	if response := localCall(hostHandler, "GET", "/api/maps/fixture/annotations", nil); !strings.Contains(response.Body.String(), "guest-mark") {
		t.Fatalf("guest markers were cleaned while room alive: %s", response.Body.String())
	}

	// Same-player rejoin: the guest re-pushes its full document and is visible again.
	if _, failure := guestManager.join(contracts.MultiplayerJoinRequest{Mode: multiplayerModeCustom, Address: net.JoinHostPort("127.0.0.1", strconv.Itoa(*status.Port)), Key: "testkey0000000000"}); failure != nil {
		t.Fatalf("rejoin: %+v", failure)
	}
	waitFor(t, 5*time.Second, func() bool {
		members := hostManager.status().Members
		return members != nil && len(*members) == 1 && (*members)[0].PeerId == guestID
	})

	hostManager.leave()
	waitFor(t, 5*time.Second, func() bool {
		response := localCall(hostHandler, "GET", "/api/maps/fixture/annotations", nil)
		return response.Code == 200 && !strings.Contains(response.Body.String(), "guest-mark")
	})
	guestHub.mu.Lock()
	_, hostStillThere := guestHub.players[hostID]
	guestHub.mu.Unlock()
	if hostStillThere {
		t.Fatal("guest still holds the host player after dissolution")
	}
}

func TestMarkerPreferences(t *testing.T) {
	_, handler, _, _ := multiplayerFixture(t)
	response := localCall(handler, "GET", "/api/marker-preferences", nil)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"hiddenOwners":[]`) {
		t.Fatalf("marker preferences default: %s", response.Body.String())
	}
	payload := contracts.MarkerPreferences{SchemaVersion: 1, HiddenOwners: []string{"aaaaaaaaaaaaaaaa"}, ShownOwners: []string{"bbbbbbbbbbbbbbbb"}}
	if response := localCall(handler, "PUT", "/api/marker-preferences", payload); response.Code != 200 {
		t.Fatalf("marker preferences put: %s", response.Body.String())
	}
	if response := localCall(handler, "GET", "/api/marker-preferences", nil); !strings.Contains(response.Body.String(), "aaaaaaaaaaaaaaaa") {
		t.Fatalf("marker preferences lost: %s", response.Body.String())
	}
	duplicate := contracts.MarkerPreferences{SchemaVersion: 1, HiddenOwners: []string{"a", "a"}, ShownOwners: []string{}}
	if response := localCall(handler, "PUT", "/api/marker-preferences", duplicate); response.Code != 400 {
		t.Fatalf("duplicate owner accepted: %s", response.Body.String())
	}
}

func TestMultiplayerDataResetRestoresDefaultsAndRotatesIdentity(t *testing.T) {
	root, handler, _, manager := multiplayerFixture(t)
	oldID := manager.selfID()
	settings := manager.currentSettings()
	settings.PlayerName = "Changed"
	settings.PlayerColor = "#123456"
	if err := manager.saveSettings(settings); err != nil {
		t.Fatal(err)
	}
	manager.recordPeer("aaaaaaaaaaaaaaaa", "Known", "#123456", multiplayerRoleGuest)
	manager.saveStunList([]string{"custom.example:3478"}, []string{"203.0.113.7:3478"}, []string{"203.0.113.8:3478"})

	response := localCall(handler, "POST", "/api/data/reset/multiplayer", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("multiplayer reset failed: %d %s", response.Code, response.Body.String())
	}
	settings = manager.currentSettings()
	if settings.PlayerId == oldID || settings.PlayerName != "玩家-"+settings.PlayerId[:4] || settings.PlayerColor != defaults.MultiplayerSettings().PlayerColor {
		t.Fatalf("multiplayer settings were not reset: %+v", settings)
	}
	if len(manager.knownPeers) != 0 {
		t.Fatalf("known peers were not reset: %+v", manager.knownPeers)
	}
	if got := manager.currentStunHostServers(); len(got) != len(defaults.StunHostServers()) || got[0] != defaults.StunHostServers()[0] {
		t.Fatalf("STUN host servers were not reset: %v", got)
	}
	if got := manager.currentStunIPServers(); len(got) != len(defaults.StunIPServers()) || got[0] != defaults.StunIPServers()[0] {
		t.Fatalf("STUN IP servers were not reset: %v", got)
	}
	if got := manager.currentStunNatServers(); len(got) != len(defaults.StunNatServers()) || got[0] != defaults.StunNatServers()[0] {
		t.Fatalf("NAT servers were not reset: %v", got)
	}
	var identity identityFile
	if err := readJSON(filepath.Join(root, "user", "multiplayer-id.json"), &identity); err != nil || identity.PeerID != settings.PlayerId {
		t.Fatalf("identity file was not reset: %+v %v", identity, err)
	}
}

func TestMultiplayerSettingsPutUsesInMemoryFallbackOnFirstSave(t *testing.T) {
	_, handler, _, manager := multiplayerFixture(t)
	settings := manager.currentSettings()
	settings.PlayerName = "First save"

	response := localCall(handler, http.MethodPut, "/api/multiplayer/settings", settings)
	if response.Code != http.StatusOK {
		t.Fatalf("first multiplayer settings save failed: %d %s", response.Code, response.Body.String())
	}
	if got := manager.currentSettings().PlayerName; got != settings.PlayerName {
		t.Fatalf("settings name = %q, want %q", got, settings.PlayerName)
	}
}

func TestMultiplayerDataResetIsRejectedInRoom(t *testing.T) {
	_, handler, _, manager := multiplayerFixture(t)
	oldID := manager.selfID()
	manager.mu.Lock()
	manager.role = multiplayerRoleHost
	manager.mu.Unlock()
	response := localCall(handler, "POST", "/api/data/reset/multiplayer", nil)
	if response.Code != http.StatusConflict || manager.selfID() != oldID {
		t.Fatalf("in-room reset was not rejected: %d %s", response.Code, response.Body.String())
	}
}

func TestResetAnnotationsClearsMultiplayerCache(t *testing.T) {
	_, _, _, manager := multiplayerFixture(t)
	item := contracts.Annotation{Id: "remote-mark", OwnerId: "aaaaaaaaaaaaaaaa", FloorId: "ground", Kind: "marker", Points: []contracts.MapPoint{{X: 5, Y: 5}}, Color: "#5FD3C4", Width: 3, TextSize: 15}
	if !manager.applyRemoteAnnotations(item.OwnerId, "fixture", []contracts.Annotation{item}) {
		t.Fatal("remote annotation was not applied")
	}
	if err := manager.store.resetAnnotations(); err != nil {
		t.Fatal(err)
	}
	if len(manager.remoteDocs) != 0 {
		t.Fatalf("remote annotation cache survived reset: %+v", manager.remoteDocs)
	}
	var document contracts.Annotations
	if err := readJSON(filepath.Join(manager.store.userRoot(), "maps", "fixture.annotations.json"), &document); err != nil || len(document.Items) != 0 {
		t.Fatalf("annotation document was not reset: %+v %v", document, err)
	}
}

func TestMapPreferenceResetClearsAppliedMap(t *testing.T) {
	_, store, _ := mapStoreFixture(t)
	if err := os.MkdirAll(store.userRoot(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := store.saveTo(store.userRoot(), "game-monitor-state.json", gameMonitorState{SchemaVersion: 1, MapID: "fixture"}); err != nil {
		t.Fatal(err)
	}
	if err := store.resetMapPreferences(); err != nil {
		t.Fatal(err)
	}
	var state gameMonitorState
	if err := readJSON(filepath.Join(store.userRoot(), "game-monitor-state.json"), &state); err != nil || state.MapID != "" {
		t.Fatalf("applied map survived reset: %+v %v", state, err)
	}
}
