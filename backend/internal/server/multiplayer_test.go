package server

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	contracts "efttoolbox/contracts"

	"github.com/pion/stun/v4"
)

// multiplayerFixture assembles the same wiring as New() for one machine without touching the
// network, so tests can drive two full instances against each other over loopback.
func multiplayerFixture(t *testing.T) (string, http.Handler, *overlayHub, *multiplayerManager) {
	root, handler, hub, manager := multiplayerFixtureWithID(t, "")
	return root, handler, hub, manager
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
	if err := os.WriteFile(filepath.Join(root, "upstream", "modes", "pvp", "maps", "fixture.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	store := &mapStore{root: root}
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

func TestShareText(t *testing.T) {
	custom := buildShareText(multiplayerModeCustom, "192.168.1.5:47990", "", "abcd1234abcd1234")
	for _, want := range []string{
		shareHeader,
		"模式: 局域网",
		"房主: 192.168.1.5:47990",
		"密码: abcd1234abcd1234",
	} {
		if !strings.Contains(custom, want) {
			t.Fatalf("custom share text missing %q: %s", want, custom)
		}
	}
	if strings.Contains(custom, "房间") || strings.Contains(custom, "STUN:") {
		t.Fatalf("custom share text has stale lines: %s", custom)
	}

	stun := buildShareText(multiplayerModeStun, "203.0.113.7:51240", "stun.l.google.com:19302", "efefefefefefefef")
	for _, want := range []string{
		"模式: STUN",
		"房主: 203.0.113.7:51240",
		"STUN: stun.l.google.com:19302",
		"密码: efefefefefefefef",
	} {
		if !strings.Contains(stun, want) {
			t.Fatalf("stun share text missing %q: %s", want, stun)
		}
	}
}

func TestStunListParsing(t *testing.T) {
	// A fake always-online-stun endpoint: hostname entries, a stun: prefix, junk and duplicates.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("stun.example.com:3478\nexample.org:3478\nstun:paired.example.net:3478\nnot a host\nstun.example.com:3478\n# comment\n\ndead.example:port\n"))
	}))
	defer func() { server.Close() }()

	servers, err := fetchStunList(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"stun.example.com:3478", "example.org:3478", "paired.example.net:3478"}
	if len(servers) != len(want) {
		t.Fatalf("parsed %v", servers)
	}
	for index, entry := range want {
		if servers[index] != entry {
			t.Fatalf("parsed %v, want %v", servers, want)
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

func fakeStunServer(t *testing.T, mapped func(from *net.UDPAddr) *net.UDPAddr) string {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
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
	hello := mustJSON(wireHello{PeerID: "aaaaaaaaaaaaaaaa", Name: "Late", Color: "#d4a24e"})
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
	_, hostHandler, hostHub, hostManager := multiplayerFixtureWithID(t, "aaaaaaaaaaaaaaaa")
	_, guestHandler, guestHub, guestManager := multiplayerFixtureWithID(t, "bbbbbbbbbbbbbbbb")

	status, failure := hostManager.host(contracts.MultiplayerHostRequest{Mode: multiplayerModeCustom, Address: stringPtr("127.0.0.1"), Port: "0", Key: stringPtr("testkey0000000000")})
	if failure != nil {
		t.Fatalf("host: %+v", failure)
	}
	guestStatus, failure := guestManager.join(contracts.MultiplayerJoinRequest{Mode: multiplayerModeCustom, Address: stringPtr("127.0.0.1"), Port: stringPtr(strconv.Itoa(*status.Port)), Key: "testkey0000000000"})
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
	hostHub.mu.Lock()
	self := contracts.PlayerState{PlayerId: "self", DisplayName: "房主", Color: "#d4a24e", IsSelf: true, MapId: "fixture", WorldPosition: contracts.WorldPosition{X: 10, Y: 20, Z: 3}, MapPosition: contracts.MapPoint{X: 1, Y: 2}, Resolution: contracts.LocationResolution{Status: "skipped", Candidates: []string{}}, Heading: 90}
	hostHub.players["self"] = self
	hostHub.mu.Unlock()
	hostHub.publish(contracts.ServerEvent{Type: "player_upsert", Player: &self})
	waitFor(t, 5*time.Second, func() bool {
		guestHub.mu.Lock()
		defer guestHub.mu.Unlock()
		player, ok := guestHub.players[hostID]
		return ok && player.WorldPosition.X == 10 && player.IsSelf == false && player.Color == "#d4a24e"
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
	if _, failure := guestManager.join(contracts.MultiplayerJoinRequest{Mode: multiplayerModeCustom, Address: stringPtr("127.0.0.1"), Port: stringPtr(strconv.Itoa(*status.Port)), Key: "testkey0000000000"}); failure != nil {
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
