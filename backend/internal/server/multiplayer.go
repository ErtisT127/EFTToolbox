package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	defaults "efttoolbox/backend/internal/defaults"
	contracts "efttoolbox/contracts"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
	"golang.org/x/sys/windows/registry"
)

// The multiplayer room is a star: one toolbox hosts, the others connect their Go backends via
// WebRTC DataChannels and the host relays. Positions ride an unreliable channel, everything else
// a reliable one. Liveness is judged solely by the heartbeat window below; a lost reliable message
// therefore only happens on a dying link, and a reconnect re-pushes full snapshots to repair it.
//
// Lock order is strictly hub.mu → manager mu → nothing nested, and annoMu is never held together
// with manager mu: hub.publish runs its onEvent intake while holding hub.mu, so no manager lock
// may be held across a hub.publish call.
const (
	multiplayerRoleHost  = "host"
	multiplayerRoleGuest = "guest"

	multiplayerModeCustom = "custom"
	multiplayerModeStun   = "stun"

	multiplayerMaxMembers             = 5
	multiplayerMaxRemoteDocuments     = 64
	multiplayerMaxRemoteDocumentBytes = 1 << 20
	multiplayerMaxRemoteAnnotations   = 10000

	memberStateConnected = "connected"
	memberStateUnstable  = "unstable"
	memberStateLost      = "lost"

	positionSendInterval    = 400 * time.Millisecond
	positionBufferLimit     = 64 << 10
	annotationSendDebounce  = 300 * time.Millisecond
	heartbeatInterval       = time.Second
	heartbeatMissesUnstable = 2
	heartbeatDropWindow     = 5 * time.Second
)

var regexpPeerID = regexp.MustCompile(`^[0-9a-f]{16}$`)

// errAnnotationsInvalid marks a client-caused validation failure inside the multiplayer
// annotation merge, so callers keep returning 400 instead of a save-failure 500.
var errAnnotationsInvalid = errors.New("annotations_invalid")

// errMultiplayerResetInRoom reports that multiplayer data cannot reset while a room is active.
var errMultiplayerResetInRoom = errors.New("multiplayer_reset_in_room")

// apiFailure carries a user-presentable error code (plus an optional detail token) out of the
// room lifecycle so the dashboard can render a concrete reason instead of a generic failure.
type apiFailure struct {
	status int
	code   string
	detail string
}

func (f *apiFailure) Error() string { return f.code }

func fail(status int, code string) *apiFailure { return &apiFailure{status: status, code: code} }

func failDetail(status int, code, detail string) *apiFailure {
	return &apiFailure{status: status, code: code, detail: detail}
}

type multiplayerPeer struct {
	id    string
	name  string
	color string

	pc  *webrtc.PeerConnection
	ctl *webrtc.DataChannel
	pos *webrtc.DataChannel

	lastPong  time.Time
	misses    int
	firstMiss time.Time
	unstable  bool
	rtt       time.Duration

	closeOnce sync.Once
}

func (p *multiplayerPeer) close() {
	p.closeOnce.Do(func() {
		pc := p.pc
		if pc != nil {
			go func() { _ = pc.Close() }()
		}
	})
}

// peerRecord is the persisted name/color of every machine this toolbox has shared a room with;
// the layer panel labels a departed teammate's markers from it.
type peerRecord struct {
	Name     string `json:"name"`
	Color    string `json:"color"`
	Role     string `json:"role"`
	LastSeen string `json:"lastSeen"`
}

type multiplayerManager struct {
	ctx   context.Context
	hub   *overlayHub
	store *mapStore

	lifeMu sync.Mutex // serializes host/join/leave

	settingsSaveMu sync.Mutex
	peerSaveMu     sync.Mutex

	mu         sync.Mutex
	settings   contracts.MultiplayerSettings
	knownPeers map[string]peerRecord
	role       string
	mode       string
	stunServer string
	key        string
	invite     *contracts.MultiplayerInvite
	port       int
	signal     *signalListener
	stun       *stunListener
	peers      map[string]*multiplayerPeer // registered, hello-exchanged peers by remote id
	joining    map[*multiplayerPeer]bool   // connections still waiting for their hello/roster
	roster     []contracts.MultiplayerMember
	lastStatus string

	stunServers    []string
	stunNatServers []string
	stunListMutex  sync.Mutex
	stunRefreshMu  sync.Mutex

	annoMu     sync.Mutex
	remoteDocs map[string]map[string][]contracts.Annotation
	sentOwn    map[string][]contracts.Annotation
	sentOnce   map[string]bool
	annoTimers map[string]*time.Timer

	posMu      sync.Mutex
	posPending *contracts.PlayerState
	posTimer   *time.Timer
}

func newMultiplayerManager(ctx context.Context, hub *overlayHub) *multiplayerManager {
	m := &multiplayerManager{
		ctx:        ctx,
		hub:        hub,
		store:      hub.store,
		knownPeers: map[string]peerRecord{},
		peers:      map[string]*multiplayerPeer{},
		joining:    map[*multiplayerPeer]bool{},
		remoteDocs: map[string]map[string][]contracts.Annotation{},
		sentOwn:    map[string][]contracts.Annotation{},
		sentOnce:   map[string]bool{},
		annoTimers: map[string]*time.Timer{},
	}
	m.loadSettings()
	m.loadStunList()
	go m.run()
	go func() {
		<-ctx.Done()
		m.leave()
	}()
	return m
}

func (m *multiplayerManager) run() {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.tick()
		}
	}
}

// identity: the peer id is the machine, not the name — a rejoining machine is the same player.

func derivePeerID() string {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Cryptography`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	guid, _, err := key.GetStringValue("MachineGuid")
	_ = key.Close()
	if err != nil || guid == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(guid))
	return hex.EncodeToString(sum[:8])
}

func validMultiplayerSettings(value contracts.MultiplayerSettings) bool {
	if value.SchemaVersion != contracts.ContractSchemaVersion || !regexpPeerID.MatchString(value.PlayerId) || len(value.PlayerName) > 40 || !hexColor.MatchString(value.PlayerColor) {
		return false
	}
	if value.LastMode != nil && *value.LastMode != multiplayerModeCustom && *value.LastMode != multiplayerModeStun {
		return false
	}
	if value.LastPort != nil && *value.LastPort != "auto" {
		if port, err := strconv.Atoi(*value.LastPort); err != nil || port < 1 || port > 65535 {
			return false
		}
	}
	for _, field := range []*string{value.LastAddress, value.LastKey, value.LastStun} {
		if field != nil && len(*field) > 200 {
			return false
		}
	}
	return true
}

// textValue reads an optional request string field, trimming surrounding whitespace.
func textValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func (m *multiplayerManager) settingsPath() string {
	return filepath.Join(m.store.root, "user", "multiplayer.json")
}

// identityFile persists the derived peer id. The id is anchored to the machine GUID but mixed
// with a per-install random salt: two installs on one machine (e.g. isolated test instances)
// are distinct players, while a rejoining install keeps its identity.
type identityFile struct {
	PeerID string `json:"peerId"`
}

func (m *multiplayerManager) identityPath() string {
	return filepath.Join(m.store.root, "user", "multiplayer-id.json")
}

func newIdentity() identityFile {
	base := derivePeerID()
	if base == "" {
		base = randomToken16()
	}
	sum := sha256.Sum256([]byte(base + ":" + randomToken16()))
	return identityFile{PeerID: hex.EncodeToString(sum[:8])}
}

func (m *multiplayerManager) loadSettings() {
	value := defaults.MultiplayerSettings()
	if data, err := os.ReadFile(m.settingsPath()); err == nil {
		var loaded contracts.MultiplayerSettings
		if json.Unmarshal(data, &loaded) == nil && validMultiplayerSettings(loaded) {
			value = loaded
		}
	}
	var identity identityFile
	_ = readJSON(m.identityPath(), &identity)
	if !regexpPeerID.MatchString(identity.PeerID) {
		identity = newIdentity()
		// Best effort: a fresh install persists its identity immediately; failure only delays
		// stability to the first settings save.
		if err := m.store.saveGlobal("multiplayer-id.json", identity); err != nil {
			log.Printf("multiplayer identity persist: %v", err)
		}
	}
	value.PlayerId = identity.PeerID
	if value.PlayerName == "" {
		value.PlayerName = "玩家-" + value.PlayerId[:4]
	}
	if value.PlayerColor == "" {
		value.PlayerColor = defaults.MultiplayerSettings().PlayerColor
	}
	m.mu.Lock()
	m.settings = value
	m.knownPeers = m.readPeersFile()
	m.mu.Unlock()
}

func (m *multiplayerManager) resetData() error {
	m.lifeMu.Lock()
	defer m.lifeMu.Unlock()
	m.settingsSaveMu.Lock()
	defer m.settingsSaveMu.Unlock()
	m.peerSaveMu.Lock()
	defer m.peerSaveMu.Unlock()
	m.stunRefreshMu.Lock()
	defer m.stunRefreshMu.Unlock()
	m.mu.Lock()
	if m.role != "" {
		m.mu.Unlock()
		return errMultiplayerResetInRoom
	}
	m.mu.Unlock()

	identity := newIdentity()
	settings := defaults.MultiplayerSettings()
	settings.PlayerId = identity.PeerID
	settings.PlayerName = "玩家-" + identity.PeerID[:4]
	peers := map[string]peerRecord{}
	servers, natServers := defaults.StunServers(), defaults.StunNatServers()
	if err := m.store.saveGlobal("multiplayer-id.json", identity); err != nil {
		return err
	}
	if err := m.store.saveGlobal("multiplayer.json", settings); err != nil {
		return err
	}
	if err := m.store.saveGlobal("multiplayer-peers.json", peers); err != nil {
		return err
	}
	if err := m.store.saveGlobal("multiplayer-stun.json", stunCache{SchemaVersion: contracts.ContractSchemaVersion, Servers: servers, NatServers: natServers}); err != nil {
		return err
	}
	m.mu.Lock()
	m.settings = settings
	m.knownPeers = peers
	m.mu.Unlock()
	m.stunListMutex.Lock()
	m.stunServers = servers
	m.stunNatServers = natServers
	m.stunListMutex.Unlock()
	m.publishStatus()
	return nil
}

func (m *multiplayerManager) saveSettings(value contracts.MultiplayerSettings) error {
	m.settingsSaveMu.Lock()
	defer m.settingsSaveMu.Unlock()
	m.mu.Lock()
	value.PlayerId = m.settings.PlayerId
	m.mu.Unlock()
	if !validMultiplayerSettings(value) {
		return errors.New("multiplayer_settings_invalid")
	}
	if err := m.store.saveGlobal("multiplayer.json", value); err != nil {
		return err
	}
	m.mu.Lock()
	m.settings = value
	m.mu.Unlock()
	return nil
}

func (m *multiplayerManager) currentSettings() contracts.MultiplayerSettings {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.settings
}

func (m *multiplayerManager) selfID() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.settings.PlayerId
}

func (m *multiplayerManager) selfColor() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.settings.PlayerColor
}

// peers.json keeps departed teammates' name/color for the layer panel labels.

func (m *multiplayerManager) peersPath() string {
	return filepath.Join(m.store.root, "user", "multiplayer-peers.json")
}

func (m *multiplayerManager) readPeersFile() map[string]peerRecord {
	peers := map[string]peerRecord{}
	_ = readJSON(m.peersPath(), &peers)
	return peers
}

func (m *multiplayerManager) recordPeer(id, name, color, role string) {
	if id == "" || name == "" {
		return
	}
	m.peerSaveMu.Lock()
	defer m.peerSaveMu.Unlock()
	m.mu.Lock()
	m.knownPeers[id] = peerRecord{Name: name, Color: color, Role: role, LastSeen: time.Now().UTC().Format(time.RFC3339Nano)}
	snapshot := make(map[string]peerRecord, len(m.knownPeers))
	for key, value := range m.knownPeers {
		snapshot[key] = value
	}
	m.mu.Unlock()
	if err := m.store.saveGlobal("multiplayer-peers.json", snapshot); err != nil {
		log.Printf("multiplayer peers persist: %v", err)
	}
}

// room lifecycle

func (m *multiplayerManager) host(req contracts.MultiplayerHostRequest) (contracts.MultiplayerStatus, *apiFailure) {
	m.lifeMu.Lock()
	defer m.lifeMu.Unlock()
	m.mu.Lock()
	if m.role != "" {
		m.mu.Unlock()
		return contracts.MultiplayerStatus{}, fail(http.StatusConflict, "multiplayer_already_in_room")
	}
	m.mu.Unlock()

	mode := req.Mode
	if mode != multiplayerModeCustom && mode != multiplayerModeStun {
		return contracts.MultiplayerStatus{}, fail(http.StatusBadRequest, "multiplayer_mode_invalid")
	}
	key := textValue(req.Key)
	if len(key) > 100 {
		return contracts.MultiplayerStatus{}, fail(http.StatusBadRequest, "multiplayer_key_invalid")
	}
	if key == "" {
		key = randomToken16()
	}
	address := textValue(req.Address)
	port := strings.TrimSpace(req.Port)
	stunServer := textValue(req.StunServer)

	var (
		listener net.Listener
		udpConn  *net.UDPConn
		bindIP   net.IP
		bindPort int
		mapped   *net.UDPAddr
		lf       *apiFailure
	)
	switch mode {
	case multiplayerModeCustom:
		bindIP = net.ParseIP(address)
		if bindIP == nil || bindIP.To4() == nil {
			return contracts.MultiplayerStatus{}, fail(http.StatusBadRequest, "multiplayer_address_invalid")
		}
		listener, bindPort, lf = bindRoomSockets(bindIP, port)
		if lf != nil {
			return contracts.MultiplayerStatus{}, lf
		}
	case multiplayerModeStun:
		if stunServer == "" {
			return contracts.MultiplayerStatus{}, fail(http.StatusBadRequest, "multiplayer_stun_required")
		}
		udpConn, mapped, lf = bindStunSignaling(stunServer)
		if lf != nil {
			return contracts.MultiplayerStatus{}, lf
		}
		bindPort = udpConn.LocalAddr().(*net.UDPAddr).Port
	}

	invite := &contracts.MultiplayerInvite{Key: key, Mode: mode}
	if mode == multiplayerModeStun {
		// The STUN signaler receives packets on the NAT-mapped public socket, so the invite
		// advertises the mapped address; appending the local bind port again would be unjoinable.
		invite.Host = net.JoinHostPort(mapped.IP.String(), strconv.Itoa(mapped.Port))
		// Status reports the advertised endpoint, not the local ephemeral bind port.
		bindPort = mapped.Port
	} else {
		invite.Host = net.JoinHostPort(bindIP.String(), strconv.Itoa(bindPort))
	}
	if stunServer != "" {
		invite.StunServer = &stunServer
	}

	m.mu.Lock()
	if mode == multiplayerModeCustom {
		m.signal = newSignalListener(listener, key, m.capacityAvailable, m.acceptGuest)
	} else {
		m.stun = newStunListener(udpConn, key, m.capacityAvailable, m.acceptGuest)
	}
	m.role = multiplayerRoleHost
	m.mode = mode
	m.stunServer = stunServer
	m.key = key
	m.invite = invite
	m.port = bindPort
	m.roster = nil
	m.mu.Unlock()
	m.resetAnnotationSync()

	m.persistLastUsed(mode, address, port, key, stunServer)
	m.publishStatus()
	return m.status(), nil
}

func (m *multiplayerManager) persistLastUsed(mode, address, port, key, stunServer string) {
	// This background update must merge with the current file contents. Reading the
	// in-memory snapshot here could overwrite a concurrent conditional REST update.
	m.settingsSaveMu.Lock()
	defer m.settingsSaveMu.Unlock()
	value, _, _, err := m.store.files.Mutate(filepath.Join("user", "multiplayer.json"), defaults.MultiplayerSettings(), func(raw any) error {
		settings, ok := raw.(*contracts.MultiplayerSettings)
		if !ok {
			return errors.New("multiplayer_settings_invalid")
		}
		m.mu.Lock()
		settings.PlayerId = m.settings.PlayerId
		m.mu.Unlock()
		settings.LastMode = stringPtr(mode)
		settings.LastAddress = stringPtr(address)
		settings.LastPort = stringPtr(port)
		settings.LastKey = stringPtr(key)
		settings.LastStun = stringPtr(stunServer)
		if !validMultiplayerSettings(*settings) {
			return errors.New("multiplayer_settings_invalid")
		}
		return nil
	})
	if err != nil {
		return
	}
	if settings, ok := value.(*contracts.MultiplayerSettings); ok {
		m.mu.Lock()
		m.settings = *settings
		m.mu.Unlock()
	}
}

func (m *multiplayerManager) capacityAvailable() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.role == multiplayerRoleHost && len(m.peers)+len(m.joining) < multiplayerMaxMembers-1
}

func (m *multiplayerManager) join(req contracts.MultiplayerJoinRequest) (contracts.MultiplayerStatus, *apiFailure) {
	m.lifeMu.Lock()
	defer m.lifeMu.Unlock()
	m.mu.Lock()
	if m.role != "" {
		m.mu.Unlock()
		return contracts.MultiplayerStatus{}, fail(http.StatusConflict, "multiplayer_already_in_room")
	}
	m.mu.Unlock()

	mode, address, port, stunServer, key := req.Mode, textValue(req.Address), textValue(req.Port), textValue(req.StunServer), strings.TrimSpace(req.Key)
	if mode != multiplayerModeCustom && mode != multiplayerModeStun || key == "" || len(key) > 100 {
		return contracts.MultiplayerStatus{}, fail(http.StatusBadRequest, "multiplayer_share_invalid")
	}
	switch mode {
	case multiplayerModeCustom:
		ip := net.ParseIP(address)
		value, err := strconv.Atoi(port)
		if ip == nil || ip.To4() == nil || err != nil || value < 1 || value > 65535 {
			return contracts.MultiplayerStatus{}, fail(http.StatusBadRequest, "multiplayer_share_invalid")
		}
	case multiplayerModeStun:
		// The STUN invite carries the host's public address as ip:port.
		host, _, splitErr := net.SplitHostPort(address)
		if stunServer == "" || splitErr != nil || net.ParseIP(host) == nil {
			return contracts.MultiplayerStatus{}, fail(http.StatusBadRequest, "multiplayer_share_invalid")
		}
	}

	pc, ctl, pos, lf := m.dial(mode, address, port, stunServer, key)
	if lf != nil {
		return contracts.MultiplayerStatus{}, lf
	}

	peer := &multiplayerPeer{pc: pc, ctl: ctl, pos: pos, lastPong: time.Now()}
	wirePeer(peer, m.handleCtlMessage, m.handlePosMessage)

	m.mu.Lock()
	if m.role != "" {
		// A concurrent lifecycle op won the race; back out cleanly.
		m.mu.Unlock()
		peer.close()
		return contracts.MultiplayerStatus{}, fail(http.StatusConflict, "multiplayer_already_in_room")
	}
	m.role = multiplayerRoleGuest
	m.mode = mode
	m.stunServer = stunServer
	m.key = key
	m.roster = nil
	m.mu.Unlock()
	m.resetAnnotationSync()

	// Handlers on a just-opened channel may attach a beat after the peer's first frame would
	// land, so the hello is retried until the roster acknowledges registration; the full own
	// state (markers, position) is pushed only once the host has answered.
	go m.greetHost(peer)
	m.publishStatus()
	return m.status(), nil
}

func (m *multiplayerManager) greetHost(peer *multiplayerPeer) {
	for attempt := 0; attempt < 10; attempt++ {
		m.mu.Lock()
		registered := peer.id != ""
		m.mu.Unlock()
		if registered || peer.ctl == nil || peer.ctl.ReadyState() != webrtc.DataChannelStateOpen {
			return
		}
		m.sendHello(peer)
		time.Sleep(400 * time.Millisecond)
	}
}

func (m *multiplayerManager) leave() {
	m.lifeMu.Lock()
	defer m.lifeMu.Unlock()
	m.mu.Lock()
	if m.role == "" {
		m.mu.Unlock()
		return
	}
	peers := m.peers
	joining := m.joining
	signal := m.signal
	stun := m.stun
	m.role = ""
	m.mode = ""
	m.stunServer = ""
	m.key = ""
	m.invite = nil
	m.port = 0
	m.signal = nil
	m.stun = nil
	m.peers = map[string]*multiplayerPeer{}
	m.joining = map[*multiplayerPeer]bool{}
	m.roster = nil
	m.mu.Unlock()

	if signal != nil {
		signal.close()
	}
	if stun != nil {
		stun.close()
	}
	bye := mustJSON(wireEnvelope{Type: contracts.WireTypeBye})
	for _, peer := range peers {
		sendWire(peer, bye)
		peer.close()
	}
	for peer := range joining {
		peer.close()
	}

	removed := make([]string, 0, len(peers))
	for id := range peers {
		removed = append(removed, id)
	}
	m.clearRemoteState(removed)
	m.publishStatus()
}

func (m *multiplayerManager) kick(peerID string) *apiFailure {
	peerID = strings.TrimSpace(peerID)
	if !regexpPeerID.MatchString(peerID) {
		return fail(http.StatusBadRequest, "multiplayer_peer_invalid")
	}
	m.mu.Lock()
	role := m.role
	_, exists := m.peers[peerID]
	m.mu.Unlock()
	if role != multiplayerRoleHost {
		return fail(http.StatusForbidden, "multiplayer_kick_forbidden")
	}
	if !exists {
		return fail(http.StatusNotFound, "multiplayer_peer_not_found")
	}
	m.dropPeer(peerID, "kicked")
	return nil
}

// clearRemoteState runs whenever this machine stops being in a room: remote players and foreign
// markers leave the local files, per the room-dissolution rule. User visibility preferences are
// never touched here.
func (m *multiplayerManager) clearRemoteState(peerIDs []string) {
	selfID := m.selfID()
	for _, id := range peerIDs {
		if id == selfID {
			continue
		}
		m.hub.removeRemotePlayer(id)
	}
	m.posMu.Lock()
	if m.posTimer != nil {
		m.posTimer.Stop()
		m.posTimer = nil
	}
	m.posPending = nil
	m.posMu.Unlock()

	var touched []string
	m.annoMu.Lock()
	for id, timer := range m.annoTimers {
		timer.Stop()
		delete(m.annoTimers, id)
	}
	m.remoteDocs = map[string]map[string][]contracts.Annotation{}
	m.sentOwn = map[string][]contracts.Annotation{}
	m.sentOnce = map[string]bool{}
	for _, path := range m.annotationFiles() {
		mapID := annotationMapID(path)
		if mapID == "" {
			continue
		}
		if m.stripForeignAnnotationsLocked(mapID) {
			touched = append(touched, mapID)
		}
	}
	m.annoMu.Unlock()
	for _, mapID := range touched {
		m.hub.changed("annotations_changed", mapID, fmt.Sprintf("multiplayer-leave-%d", time.Now().UnixNano()))
	}
}

// heartbeat tick: ping every peer, judge the 2s/5s windows, keep the host roster flowing.

// evaluateHeartbeat applies the single-window timeout rule: one missed tick records the window
// start, two consecutive misses flag the peer unstable, and no reply for 5s since the first miss
// drops it. Any pong resets everything. Returns true when the peer must be dropped.
func (p *multiplayerPeer) evaluateHeartbeat(now time.Time) bool {
	if now.Sub(p.lastPong) > heartbeatInterval+250*time.Millisecond {
		if p.firstMiss.IsZero() {
			p.firstMiss = now
		}
		p.misses++
		if p.misses >= heartbeatMissesUnstable {
			p.unstable = true
		}
		return now.Sub(p.firstMiss) >= heartbeatDropWindow
	}
	p.misses = 0
	p.unstable = false
	p.firstMiss = time.Time{}
	return false
}

func (m *multiplayerManager) tick() {
	m.mu.Lock()
	if m.role == "" {
		m.mu.Unlock()
		return
	}
	now := time.Now()
	var dropped []string
	for id, peer := range m.peers {
		m.sendPingLocked(peer, now)
		if peer.evaluateHeartbeat(now) {
			dropped = append(dropped, id)
		}
	}
	var rosterFrame []byte
	if m.role == multiplayerRoleHost {
		rosterFrame = mustJSON(wireEnvelope{Type: contracts.WireTypeRoster, Data: mustJSON(wireRoster{Members: m.rosterMembersLocked()})})
	}
	m.mu.Unlock()

	for _, id := range dropped {
		m.dropPeer(id, "heartbeat_timeout")
	}
	if rosterFrame != nil {
		m.broadcastCtl(rosterFrame)
	}
	m.publishStatus()
}

func (m *multiplayerManager) sendPingLocked(peer *multiplayerPeer, now time.Time) {
	if peer.ctl == nil || peer.ctl.ReadyState() != webrtc.DataChannelStateOpen {
		return
	}
	sendWire(peer, mustJSON(wireEnvelope{Type: contracts.WireTypePing, Data: mustJSON(wirePing{T: now.UnixMilli()})}))
}

// dropPeer removes one peer. For a guest whose peer is the host this ends the whole room, since
// the host dying disconnects everyone by definition.
func (m *multiplayerManager) dropPeer(id, reason string) {
	m.dropPeerIf(id, reason, nil)
}

func (m *multiplayerManager) dropPeerIf(id, reason string, expected *multiplayerPeer) {
	m.mu.Lock()
	peer := m.peers[id]
	if expected != nil && peer != expected {
		m.mu.Unlock()
		return
	}
	if peer != nil {
		delete(m.peers, id)
	} else {
		for candidate := range m.joining {
			if candidate.id == id && (expected == nil || candidate == expected) {
				peer = candidate
				delete(m.joining, candidate)
				break
			}
		}
	}
	if peer == nil {
		m.mu.Unlock()
		return
	}
	role := m.role
	name, color := peer.name, peer.color
	m.mu.Unlock()

	log.Printf("multiplayer peer dropped: id=%s reason=%s", id, reason)
	peer.close()
	if id != m.selfID() {
		m.hub.removeRemotePlayer(id)
	}
	if role == multiplayerRoleHost {
		m.recordPeer(id, name, color, multiplayerRoleGuest)
	}
	if role == multiplayerRoleGuest {
		// Our only peer was the host; the room is over for us.
		m.leave()
		return
	}
	m.broadcastRoster()
	m.publishStatus()
}

// status & roster

func latencyPointer(rtt time.Duration) *int {
	if rtt <= 0 {
		return nil
	}
	// Quantize to 10ms so the 1s roster tick does not churn the /ws feed with jitter alone.
	quantized := int(rtt.Round(10*time.Millisecond) / time.Millisecond)
	return &quantized
}

func (m *multiplayerManager) rosterMembersLocked() []contracts.MultiplayerMember {
	members := []contracts.MultiplayerMember{{
		PeerId: m.settings.PlayerId, Name: m.settings.PlayerName, Color: m.settings.PlayerColor,
		Role: multiplayerRoleHost, State: memberStateConnected,
	}}
	for _, peer := range m.peers {
		if peer.id == "" {
			continue
		}
		members = append(members, contracts.MultiplayerMember{
			PeerId: peer.id, Name: peer.name, Color: peer.color, Role: multiplayerRoleGuest,
			LatencyMs: latencyPointer(peer.rtt),
			State:     memberStateFor(peer),
		})
	}
	return members
}

func memberStateFor(peer *multiplayerPeer) string {
	if peer.unstable {
		return memberStateUnstable
	}
	return memberStateConnected
}

func (m *multiplayerManager) status() contracts.MultiplayerStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	status := contracts.MultiplayerStatus{Enabled: m.role != ""}
	if m.role == "" {
		return status
	}
	role, mode := m.role, m.mode
	status.Role = &role
	status.Mode = &mode
	if m.role == multiplayerRoleHost {
		port := m.port
		status.Invite = m.invite
		status.Port = &port
	}
	self := contracts.MultiplayerMember{
		PeerId: m.settings.PlayerId, Name: m.settings.PlayerName, Color: m.settings.PlayerColor,
		Role: m.role, State: memberStateConnected,
	}
	if m.role == multiplayerRoleGuest {
		for _, peer := range m.peers {
			self.LatencyMs = latencyPointer(peer.rtt)
			if peer.unstable {
				self.State = memberStateUnstable
			}
		}
	}
	status.Self = &self

	members := []contracts.MultiplayerMember{}
	if m.role == multiplayerRoleHost {
		members = m.rosterMembersLocked()[1:]
	} else {
		for _, member := range m.roster {
			if member.PeerId == m.settings.PlayerId {
				continue
			}
			members = append(members, member)
		}
	}
	status.Members = &members

	known := []contracts.MultiplayerMember{}
	for id, record := range m.knownPeers {
		if id == m.settings.PlayerId || slices.ContainsFunc(members, func(member contracts.MultiplayerMember) bool { return member.PeerId == id }) {
			continue
		}
		known = append(known, contracts.MultiplayerMember{PeerId: id, Name: record.Name, Color: record.Color, Role: record.Role, State: memberStateLost})
	}
	status.Known = &known
	return status
}

// publishStatus pushes multiplayer_changed over the existing /ws fan-out only when the rendered
// status actually differs, so an idle room costs nothing and a busy one stays around 1/s.
func (m *multiplayerManager) publishStatus() {
	status := m.status()
	data, err := json.Marshal(status)
	if err != nil {
		return
	}
	m.mu.Lock()
	if string(data) == m.lastStatus {
		m.mu.Unlock()
		return
	}
	m.lastStatus = string(data)
	m.mu.Unlock()
	m.hub.mu.Lock()
	m.hub.publish(contracts.ServerEvent{Type: "multiplayer_changed", MultiplayerStatus: &status})
	m.hub.mu.Unlock()
}

// hub event intake

func (m *multiplayerManager) onEvent(event contracts.ServerEvent) {
	if event.Type == "multiplayer_changed" {
		return
	}
	m.mu.Lock()
	role := m.role
	m.mu.Unlock()
	if role == "" {
		return
	}
	if event.Type == "player_upsert" && event.Player != nil && event.Player.IsSelf {
		m.schedulePosition(event.Player)
		return
	}
	if event.Type == "annotations_changed" && event.MapId != nil {
		m.scheduleAnnotationSend(*event.MapId)
	}
}

// positions: latest-wins throttle on an unreliable channel; a frame is always expendable.

type wirePos = contracts.WirePos

func (m *multiplayerManager) schedulePosition(player *contracts.PlayerState) {
	m.posMu.Lock()
	m.posPending = player
	if m.posTimer != nil {
		m.posMu.Unlock()
		return
	}
	m.posTimer = time.AfterFunc(positionSendInterval, m.flushPosition)
	m.posMu.Unlock()
}

func (m *multiplayerManager) flushPosition() {
	m.posMu.Lock()
	player := m.posPending
	m.posPending = nil
	m.posTimer = nil
	m.posMu.Unlock()
	if player == nil {
		return
	}
	frame := mustJSON(wireEnvelope{Type: contracts.WireTypePos, Data: mustJSON(wirePos{
		PeerId: m.selfID(), MapId: player.MapId,
		X: player.WorldPosition.X, Y: player.WorldPosition.Y, Z: player.WorldPosition.Z,
		Heading: player.Heading,
	})})
	m.broadcastPos(frame)
}

func (m *multiplayerManager) sendSelfPosition(peer *multiplayerPeer) {
	m.hub.mu.Lock()
	self, ok := m.hub.players["self"]
	m.hub.mu.Unlock()
	if !ok {
		return
	}
	frame := mustJSON(wireEnvelope{Type: contracts.WireTypePos, Data: mustJSON(wirePos{
		PeerId: m.selfID(), MapId: self.MapId,
		X: self.WorldPosition.X, Y: self.WorldPosition.Y, Z: self.WorldPosition.Z,
		Heading: self.Heading,
	})})
	sendWire(peer, frame, "pos")
}

func (m *multiplayerManager) handlePosMessage(peer *multiplayerPeer, data []byte) {
	// Position frames ride the same JSON envelope as control frames, one level nested.
	var envelope wireEnvelope
	if json.Unmarshal(data, &envelope) != nil || envelope.Type != contracts.WireTypePos {
		log.Printf("multiplayer position rejected: peer=%s reason=envelope_invalid", safePeerLogID(peer.id))
		return
	}
	var frame wirePos
	if json.Unmarshal(envelope.Data, &frame) != nil {
		log.Printf("multiplayer position rejected: peer=%s reason=payload_invalid", safePeerLogID(peer.id))
		return
	}
	if frame.MapId == "" || len(frame.MapId) > 100 || !safeID.MatchString(frame.MapId) ||
		!finite(frame.X) || !finite(frame.Y) || !finite(frame.Z) || math.Abs(frame.X) > 1e7 || math.Abs(frame.Y) > 1e7 || math.Abs(frame.Z) > 1e7 || !finite(frame.Heading) || math.Abs(frame.Heading) > 1e7 {
		log.Printf("multiplayer position rejected: peer=%s reason=values_invalid map=%s", safePeerLogID(peer.id), frame.MapId)
		return
	}
	m.mu.Lock()
	role, selfID := m.role, m.settings.PlayerId
	m.mu.Unlock()
	if role == "" || frame.PeerId == selfID {
		return
	}
	if role == multiplayerRoleHost {
		// The host attributes a position frame to the connection it arrived on.
		frame.PeerId = peer.id
		m.relayPos(peer, frame)
	}
	name, color := peer.name, peer.color
	if role == multiplayerRoleGuest {
		name, color = m.rosterIdentity(frame.PeerId, name, color)
	}
	m.hub.applyRemotePlayer(frame.PeerId, name, color, frame.MapId, contracts.WorldPosition{X: frame.X, Y: frame.Y, Z: frame.Z}, frame.Heading)
}

func safePeerLogID(id string) string {
	if len(id) > 64 {
		return id[:64]
	}
	return id
}

func (m *multiplayerManager) relayPos(from *multiplayerPeer, frame wirePos) {
	m.broadcastPosExcept(from, mustJSON(wireEnvelope{Type: contracts.WireTypePos, Data: mustJSON(frame)}))
}

func (m *multiplayerManager) rosterIdentity(id, fallbackName, fallbackColor string) (string, string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, member := range m.roster {
		if member.PeerId == id {
			return member.Name, member.Color
		}
	}
	return fallbackName, fallbackColor
}

// annotations: per-owner full documents; every receiver keeps its own authoritative copy of its
// own markers and treats foreign owners' documents as replaceable cache.

func (m *multiplayerManager) annotationFiles() []string {
	paths, _ := filepath.Glob(filepath.Join(m.store.userRoot(), "maps", "*.annotations.json"))
	return paths
}

func annotationMapID(path string) string {
	base := filepath.Base(path)
	if !strings.HasSuffix(base, ".annotations.json") {
		return ""
	}
	return strings.TrimSuffix(base, ".annotations.json")
}

func filterOwn(items []contracts.Annotation, selfID string) []contracts.Annotation {
	own := []contracts.Annotation{}
	for _, item := range items {
		if item.OwnerId == selfID {
			own = append(own, item)
		}
	}
	return own
}

// canonicalAnnotations orders items deterministically so change detection can compare documents.
func canonicalAnnotations(items []contracts.Annotation) []contracts.Annotation {
	sorted := slices.Clone(items)
	slices.SortFunc(sorted, func(a, b contracts.Annotation) int {
		if a.OwnerId != b.OwnerId {
			return strings.Compare(a.OwnerId, b.OwnerId)
		}
		return strings.Compare(a.Id, b.Id)
	})
	return sorted
}

func equalAnnotations(a, b []contracts.Annotation) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Id != b[i].Id || a[i].OwnerId != b[i].OwnerId || a[i].FloorId != b[i].FloorId || a[i].Kind != b[i].Kind || a[i].Color != b[i].Color || a[i].Text != b[i].Text || a[i].Emoji != b[i].Emoji || a[i].ImageId != b[i].ImageId || a[i].Width != b[i].Width || a[i].TextSize != b[i].TextSize || len(a[i].Points) != len(b[i].Points) {
			return false
		}
		for j := range a[i].Points {
			if a[i].Points[j] != b[i].Points[j] {
				return false
			}
		}
	}
	return true
}

func (m *multiplayerManager) resetAnnotationSync() {
	m.annoMu.Lock()
	for id, timer := range m.annoTimers {
		timer.Stop()
		delete(m.annoTimers, id)
	}
	m.remoteDocs = map[string]map[string][]contracts.Annotation{}
	m.sentOwn = map[string][]contracts.Annotation{}
	m.sentOnce = map[string]bool{}
	m.annoMu.Unlock()
}

// readAnnotationsFile treats a file that no longer validates as empty: ownerId is part of the
// contract now, and a pre-multiplayer file has no markers worth keeping.
func (m *multiplayerManager) readAnnotationsFile(mapID string) []contracts.Annotation {
	var doc contracts.Annotations
	if readJSON(filepath.Join(m.store.userRoot(), "maps", mapID+".annotations.json"), &doc) != nil || doc.SchemaVersion != contracts.ContractSchemaVersion {
		return []contracts.Annotation{}
	}
	for _, item := range doc.Items {
		if item.OwnerId == "" || len(item.OwnerId) > 100 {
			return []contracts.Annotation{}
		}
	}
	return doc.Items
}

func (m *multiplayerManager) scheduleAnnotationSend(mapID string) {
	m.annoMu.Lock()
	if m.annoTimers[mapID] != nil {
		m.annoMu.Unlock()
		return
	}
	mapIDRef := mapID
	m.annoTimers[mapID] = time.AfterFunc(annotationSendDebounce, func() { m.flushAnnotations(mapIDRef) })
	m.annoMu.Unlock()
}

func (m *multiplayerManager) flushAnnotations(mapID string) {
	m.annoMu.Lock()
	delete(m.annoTimers, mapID)
	own := canonicalAnnotations(filterOwn(m.readAnnotationsFile(mapID), m.selfID()))
	if m.sentOnce[mapID] && equalAnnotations(m.sentOwn[mapID], own) {
		m.annoMu.Unlock()
		return
	}
	m.sentOwn[mapID] = own
	m.sentOnce[mapID] = true
	frame := mustJSON(wireEnvelope{Type: contracts.WireTypeAnnotations, Data: mustJSON(wireAnnotations{OwnerId: m.selfID(), MapId: mapID, Items: own})})
	m.annoMu.Unlock()
	m.broadcastCtl(frame)
}

func (m *multiplayerManager) pushOwnDocsToPeer(peer *multiplayerPeer) {
	selfID := m.selfID()
	for _, path := range m.annotationFiles() {
		mapID := annotationMapID(path)
		if mapID == "" {
			continue
		}
		own := canonicalAnnotations(filterOwn(m.readAnnotationsFile(mapID), selfID))
		m.annoMu.Lock()
		m.sentOwn[mapID] = own
		m.sentOnce[mapID] = true
		m.annoMu.Unlock()
		sendWire(peer, mustJSON(wireEnvelope{Type: contracts.WireTypeAnnotations, Data: mustJSON(wireAnnotations{OwnerId: selfID, MapId: mapID, Items: own})}))
	}
}

// applyLocalAnnotations is the single write path for the dashboard's PUT: incoming items are
// authoritative only for the local owner; foreign owners always come from the sync cache.
func (m *multiplayerManager) applyLocalAnnotations(repo *modeRepository, mapID string, mapData contracts.MapData, incoming contracts.Annotations, expected string) (contracts.Annotations, string, string, error) {
	for _, item := range incoming.Items {
		if item.OwnerId == "" || len(item.OwnerId) > 100 || !safeID.MatchString(item.OwnerId) {
			return incoming, "", "", errors.New("annotations_invalid")
		}
	}
	selfID := m.selfID()
	m.annoMu.Lock()
	if repo == nil {
		m.annoMu.Unlock()
		return incoming, "", "", errors.New("mode_repository_unavailable")
	}
	path := filepath.Join("user", "modes", repo.mode, "maps", mapID+".annotations.json")
	fallback := contracts.Annotations{SchemaVersion: contracts.ContractSchemaVersion, Items: []contracts.Annotation{}}
	value, revision, etag, err := m.store.files.CompareAndMutate(path, expected, &fallback, func(raw any) error {
		doc := raw.(*contracts.Annotations)
		doc.Items = canonicalAnnotations(append(filterOwn(incoming.Items, selfID), m.allRemoteLocked(mapID)...))
		if !validAnnotations(*doc, mapData) {
			return errAnnotationsInvalid
		}
		return nil
	})
	m.annoMu.Unlock()
	if err != nil {
		if errors.Is(err, errRevisionConflict) {
			return incoming, revision, etag, err
		}
		if errors.Is(err, errAnnotationsInvalid) {
			return incoming, "", "", err
		}
		log.Printf("multiplayer annotations save: %v", err)
		return incoming, "", "", errors.New("annotations_save_failed")
	}
	return *value.(*contracts.Annotations), revision, etag, nil
}

func (m *multiplayerManager) allRemoteLocked(mapID string) []contracts.Annotation {
	merged := []contracts.Annotation{}
	owners := make([]string, 0, len(m.remoteDocs[mapID]))
	for owner := range m.remoteDocs[mapID] {
		owners = append(owners, owner)
	}
	slices.Sort(owners)
	for _, owner := range owners {
		merged = append(merged, m.remoteDocs[mapID][owner]...)
	}
	return merged
}

// applyRemoteAnnotations caches a foreign owner's document and rewrites the local file so the
// overlay (which reads annotations from disk) and cast pick it up through the normal channels.
func (m *multiplayerManager) applyRemoteAnnotations(ownerID, mapID string, items []contracts.Annotation) bool {
	if ownerID == "" || len(ownerID) > 100 || !safeID.MatchString(ownerID) || mapID == "" || len(mapID) > 100 || !safeID.MatchString(mapID) || items == nil || len(items) > multiplayerMaxRemoteAnnotations {
		log.Printf("multiplayer annotations rejected: owner=%s map=%s reason=envelope_invalid", safePeerLogID(ownerID), safePeerLogID(mapID))
		return false
	}
	for _, item := range items {
		if item.OwnerId != ownerID {
			log.Printf("multiplayer annotations rejected: owner=%s map=%s reason=owner_mismatch", safePeerLogID(ownerID), safePeerLogID(mapID))
			return false
		}
	}
	_, mapErr := m.store.load(mapID)
	m.annoMu.Lock()
	var documentCount int
	for _, owners := range m.remoteDocs {
		documentCount += len(owners)
	}
	owners := m.remoteDocs[mapID]
	previous, existed := owners[ownerID]
	if !existed && documentCount >= multiplayerMaxRemoteDocuments {
		log.Printf("multiplayer annotations rejected: owner=%s map=%s reason=document_limit", safePeerLogID(ownerID), safePeerLogID(mapID))
		m.annoMu.Unlock()
		return false
	}
	if owners == nil {
		owners = map[string][]contracts.Annotation{}
		m.remoteDocs[mapID] = owners
	}
	m.remoteDocs[mapID][ownerID] = items
	saved := mapErr == nil && m.rewriteAnnotationsLocked(mapID)
	if !saved && mapErr == nil {
		if existed {
			owners[ownerID] = previous
		} else {
			delete(owners, ownerID)
			if len(owners) == 0 {
				delete(m.remoteDocs, mapID)
			}
		}
	}
	m.annoMu.Unlock()
	if saved {
		m.hub.changed("annotations_changed", mapID, fmt.Sprintf("multiplayer-%d", time.Now().UnixNano()))
	}
	return saved || mapErr != nil
}

func (m *multiplayerManager) rewriteAnnotationsLocked(mapID string) bool {
	mapData, err := m.store.load(mapID)
	if err != nil {
		// Unknown map locally: keep the cache so a later join can still sync it.
		return false
	}
	doc := contracts.Annotations{SchemaVersion: contracts.ContractSchemaVersion, Items: canonicalAnnotations(append(filterOwn(m.readAnnotationsFile(mapID), m.selfID()), m.allRemoteLocked(mapID)...))}
	if !validAnnotations(doc, mapData) {
		log.Printf("multiplayer annotations merge invalid: map=%s", mapID)
		return false
	}
	if err := m.store.save(filepath.Join("maps", mapID+".annotations.json"), doc); err != nil {
		log.Printf("multiplayer annotations save: %v", err)
		return false
	}
	return true
}

func (m *multiplayerManager) stripForeignAnnotationsLocked(mapID string) bool {
	mapData, err := m.store.load(mapID)
	if err != nil {
		return false
	}
	doc := contracts.Annotations{SchemaVersion: contracts.ContractSchemaVersion, Items: filterOwn(m.readAnnotationsFile(mapID), m.selfID())}
	if !validAnnotations(doc, mapData) {
		return false
	}
	if err := m.store.save(filepath.Join("maps", mapID+".annotations.json"), doc); err != nil {
		log.Printf("multiplayer annotations cleanup: %v", err)
		return false
	}
	return true
}

// snapshot: everything a fresh member needs — the host's own markers plus every cached foreign
// document, plus current positions so standing players are visible without waiting for movement.

func (m *multiplayerManager) sendSnapshot(peer *multiplayerPeer) {
	selfID := m.selfID()
	for _, path := range m.annotationFiles() {
		mapID := annotationMapID(path)
		if mapID == "" {
			continue
		}
		own := canonicalAnnotations(filterOwn(m.readAnnotationsFile(mapID), selfID))
		m.annoMu.Lock()
		m.sentOwn[mapID] = own
		m.sentOnce[mapID] = true
		var remote []wireAnnotations
		for ownerID, items := range m.remoteDocs[mapID] {
			remote = append(remote, wireAnnotations{OwnerId: ownerID, MapId: mapID, Items: items})
		}
		m.annoMu.Unlock()
		sendWire(peer, mustJSON(wireEnvelope{Type: contracts.WireTypeAnnotations, Data: mustJSON(wireAnnotations{OwnerId: selfID, MapId: mapID, Items: own})}))
		for _, doc := range remote {
			sendWire(peer, mustJSON(wireEnvelope{Type: contracts.WireTypeAnnotations, Data: mustJSON(doc)}))
		}
	}
}

// wire frames

type wireEnvelope = contracts.WireEnvelope
type wireHello = contracts.WireHello
type wireRoster = contracts.WireRoster
type wireAnnotations = contracts.WireAnnotations
type wirePing = contracts.WirePing

func mustJSON(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return data
}

func sendWire(peer *multiplayerPeer, data []byte, channels ...string) {
	channel := peer.ctl
	if len(channels) > 0 && channels[0] == "pos" {
		channel = peer.pos
	}
	if channel == nil || channel.ReadyState() != webrtc.DataChannelStateOpen {
		return
	}
	if err := channel.SendText(string(data)); err != nil {
		log.Printf("multiplayer send: %v", err)
	}
}

func (m *multiplayerManager) broadcastCtl(frame []byte) {
	m.mu.Lock()
	peers := make([]*multiplayerPeer, 0, len(m.peers))
	for _, peer := range m.peers {
		peers = append(peers, peer)
	}
	m.mu.Unlock()
	for _, peer := range peers {
		sendWire(peer, frame)
	}
}

func (m *multiplayerManager) broadcastCtlExcept(except *multiplayerPeer, frame []byte) {
	m.mu.Lock()
	peers := make([]*multiplayerPeer, 0, len(m.peers))
	for _, peer := range m.peers {
		if peer == except {
			continue
		}
		peers = append(peers, peer)
	}
	m.mu.Unlock()
	for _, peer := range peers {
		sendWire(peer, frame)
	}
}

func (m *multiplayerManager) broadcastPos(frame []byte) {
	m.broadcastPosExcept(nil, frame)
}

func (m *multiplayerManager) broadcastPosExcept(except *multiplayerPeer, frame []byte) {
	m.mu.Lock()
	peers := make([]*multiplayerPeer, 0, len(m.peers))
	for _, peer := range m.peers {
		if peer == except {
			continue
		}
		peers = append(peers, peer)
	}
	m.mu.Unlock()
	for _, peer := range peers {
		if peer.pos != nil && peer.pos.BufferedAmount() > positionBufferLimit {
			continue
		}
		sendWire(peer, frame, "pos")
	}
}

func (m *multiplayerManager) broadcastRoster() {
	m.mu.Lock()
	if m.role != multiplayerRoleHost {
		m.mu.Unlock()
		return
	}
	frame := mustJSON(wireEnvelope{Type: contracts.WireTypeRoster, Data: mustJSON(wireRoster{Members: m.rosterMembersLocked()})})
	m.mu.Unlock()
	m.broadcastCtl(frame)
}

// control-plane message handling, shared by both roles

func (m *multiplayerManager) handleCtlMessage(peer *multiplayerPeer, envelope wireEnvelope) {
	switch envelope.Type {
	case contracts.WireTypeHello:
		m.handleHello(peer, envelope.Data)
	case contracts.WireTypeRoster:
		var roster wireRoster
		if json.Unmarshal(envelope.Data, &roster) != nil {
			return
		}
		m.mu.Lock()
		if m.role != multiplayerRoleGuest {
			m.mu.Unlock()
			return
		}
		m.roster = roster.Members
		registered := false
		if peer.id == "" {
			for _, member := range roster.Members {
				if member.Role == multiplayerRoleHost {
					peer.id = member.PeerId
				}
			}
			if peer.id != "" {
				delete(m.joining, peer)
				m.peers[peer.id] = peer
				registered = true
			}
		}
		m.mu.Unlock()
		if registered {
			// The host is now fully registered and its handlers attached: push the full own
			// state so the host can relay it immediately.
			m.pushOwnDocsToPeer(peer)
			m.sendSelfPosition(peer)
		}
		m.publishStatus()
	case contracts.WireTypeAnnotations:
		var doc wireAnnotations
		if len(envelope.Data) > multiplayerMaxRemoteDocumentBytes || json.Unmarshal(envelope.Data, &doc) != nil || doc.MapId == "" || len(doc.MapId) > 100 || !safeID.MatchString(doc.MapId) || doc.OwnerId == "" || len(doc.OwnerId) > 100 || !safeID.MatchString(doc.OwnerId) || doc.Items == nil || len(doc.Items) > multiplayerMaxRemoteAnnotations {
			return
		}
		m.mu.Lock()
		role, selfID := m.role, m.settings.PlayerId
		m.mu.Unlock()
		if role == "" {
			return
		}
		ownerID := doc.OwnerId
		if role == multiplayerRoleHost {
			// The host attributes the document to the connection it arrived on.
			ownerID = peer.id
		} else if ownerID == selfID {
			return
		}
		if !m.applyRemoteAnnotations(ownerID, doc.MapId, doc.Items) {
			return
		}
		if role == multiplayerRoleHost {
			relay := mustJSON(wireEnvelope{Type: contracts.WireTypeAnnotations, Data: mustJSON(wireAnnotations{OwnerId: ownerID, MapId: doc.MapId, Items: doc.Items})})
			m.broadcastCtlExcept(peer, relay)
		}
	case contracts.WireTypePing:
		var ping wirePing
		if json.Unmarshal(envelope.Data, &ping) != nil {
			return
		}
		sendWire(peer, mustJSON(wireEnvelope{Type: contracts.WireTypePong, Data: mustJSON(wirePing{T: ping.T})}))
	case contracts.WireTypePong:
		var ping wirePing
		if json.Unmarshal(envelope.Data, &ping) != nil {
			return
		}
		m.mu.Lock()
		peer.rtt = time.Since(time.UnixMilli(ping.T))
		peer.lastPong = time.Now()
		peer.misses = 0
		peer.unstable = false
		peer.firstMiss = time.Time{}
		m.mu.Unlock()
	case contracts.WireTypeBye:
		m.dropPeer(peer.id, "bye")
	default:
		sendWire(peer, mustJSON(wireEnvelope{Type: contracts.WireTypeError, Data: mustJSON("multiplayer_peer_invalid")}))
		peer.close()
	}
}

func (m *multiplayerManager) handleHello(peer *multiplayerPeer, data []byte) {
	var hello wireHello
	if json.Unmarshal(data, &hello) != nil || !regexpPeerID.MatchString(hello.PeerId) || len(hello.Name) > 40 || !hexColor.MatchString(hello.Color) {
		sendWire(peer, mustJSON(wireEnvelope{Type: contracts.WireTypeError, Data: mustJSON("multiplayer_peer_invalid")}))
		peer.close()
		return
	}
	m.mu.Lock()
	if m.role != multiplayerRoleHost {
		m.mu.Unlock()
		return
	}
	previous := m.peers[hello.PeerId]
	if previous == nil && len(m.peers) >= multiplayerMaxMembers-1 {
		m.mu.Unlock()
		sendWire(peer, mustJSON(wireEnvelope{Type: contracts.WireTypeError, Data: mustJSON("multiplayer_room_full")}))
		peer.close()
		return
	}
	if previous != nil && previous != peer {
		// The same machine rejoining replaces its stale connection.
		delete(m.peers, hello.PeerId)
		previous.close()
	}
	delete(m.joining, peer)
	peer.id, peer.name, peer.color = hello.PeerId, hello.Name, hello.Color
	m.peers[peer.id] = peer
	m.mu.Unlock()

	log.Printf("multiplayer peer joined: id=%s name=%s", peer.id, peer.name)
	m.recordPeer(peer.id, peer.name, peer.color, multiplayerRoleGuest)
	m.broadcastRoster()
	m.sendSnapshot(peer)
	m.publishStatus()
}

// peer connection plumbing

func (m *multiplayerManager) newPeerConnection(mode, stunServer string) (*webrtc.PeerConnection, error) {
	engine := webrtc.SettingEngine{}
	// Plain host candidates: a LAN/VPN tool must not depend on mDNS name resolution.
	engine.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(engine))
	config := webrtc.Configuration{}
	if mode == multiplayerModeStun && stunServer != "" {
		config.ICEServers = []webrtc.ICEServer{{URLs: []string{"stun:" + strings.TrimPrefix(stunServer, "stun:")}}}
	}
	return api.NewPeerConnection(config)
}

// wirePeer installs message routing for both channels; frames are JSON envelopes keyed by type.
func wirePeer(peer *multiplayerPeer, onCtl func(*multiplayerPeer, wireEnvelope), onPos func(*multiplayerPeer, []byte)) {
	if peer.ctl != nil {
		peer.ctl.OnMessage(func(msg webrtc.DataChannelMessage) {
			var envelope wireEnvelope
			if json.Unmarshal(msg.Data, &envelope) == nil {
				onCtl(peer, envelope)
			}
		})
	}
	if peer.pos != nil {
		peer.pos.OnMessage(func(msg webrtc.DataChannelMessage) {
			onPos(peer, msg.Data)
		})
	}
}

func (m *multiplayerManager) sendHello(peer *multiplayerPeer) {
	m.mu.Lock()
	hello := wireHello{PeerId: m.settings.PlayerId, Name: m.settings.PlayerName, Color: m.settings.PlayerColor}
	m.mu.Unlock()
	sendWire(peer, mustJSON(wireEnvelope{Type: contracts.WireTypeHello, Data: mustJSON(hello)}))
}

// acceptGuest runs on the signaling path: it builds the host-side peer connection and returns the
// answer SDP. Channel handlers are attached before the remote description so no early frame is lost.
func (m *multiplayerManager) acceptGuest(offerSDP string) (string, *apiFailure) {
	peer := &multiplayerPeer{lastPong: time.Now()}
	m.mu.Lock()
	if m.role != multiplayerRoleHost {
		m.mu.Unlock()
		return "", fail(http.StatusConflict, "multiplayer_not_hosting")
	}
	if len(m.peers)+len(m.joining) >= multiplayerMaxMembers-1 {
		m.mu.Unlock()
		return "", fail(http.StatusServiceUnavailable, "multiplayer_room_full")
	}
	mode, stunServer := m.mode, m.stunServer
	m.joining[peer] = true
	m.mu.Unlock()

	pc, err := m.newPeerConnection(mode, stunServer)
	if err != nil {
		m.mu.Lock()
		delete(m.joining, peer)
		m.mu.Unlock()
		return "", fail(http.StatusInternalServerError, "multiplayer_connection_failed")
	}
	peer.pc = pc
	pc.OnDataChannel(func(ch *webrtc.DataChannel) {
		switch ch.Label() {
		case "ctl":
			peer.ctl = ch
		case "pos":
			peer.pos = ch
		default:
			return
		}
		wirePeer(peer, m.handleCtlMessage, m.handlePosMessage)
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			m.dropPeerIf(peer.id, "connection_"+state.String(), peer)
		}
	})
	answer, lf := answerOffer(pc, offerSDP)
	if lf != nil {
		m.mu.Lock()
		delete(m.joining, peer)
		m.mu.Unlock()
		peer.close()
		return "", lf
	}
	return answer, nil
}

// dial drives the joining side end-to-end: offer, signaling exchange, answer, and a bounded wait
// for the connection (and both data channels) to come up.
func (m *multiplayerManager) dial(mode, address, port, stunServer, key string) (*webrtc.PeerConnection, *webrtc.DataChannel, *webrtc.DataChannel, *apiFailure) {
	pc, err := m.newPeerConnection(mode, stunServer)
	if err != nil {
		return nil, nil, nil, fail(http.StatusInternalServerError, "multiplayer_connection_failed")
	}
	ordered := true
	unordered := false
	var retries uint16
	ctl, err := pc.CreateDataChannel("ctl", &webrtc.DataChannelInit{Ordered: &ordered})
	if err != nil {
		_ = pc.Close()
		return nil, nil, nil, fail(http.StatusInternalServerError, "multiplayer_connection_failed")
	}
	pos, err := pc.CreateDataChannel("pos", &webrtc.DataChannelInit{Ordered: &unordered, MaxRetransmits: &retries})
	if err != nil {
		_ = pc.Close()
		return nil, nil, nil, fail(http.StatusInternalServerError, "multiplayer_connection_failed")
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		_ = pc.Close()
		return nil, nil, nil, fail(http.StatusInternalServerError, "multiplayer_connection_failed")
	}
	gatherDone := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		_ = pc.Close()
		return nil, nil, nil, fail(http.StatusInternalServerError, "multiplayer_connection_failed")
	}
	select {
	case <-gatherDone:
	case <-time.After(5 * time.Second):
		_ = pc.Close()
		return nil, nil, nil, fail(http.StatusGatewayTimeout, "multiplayer_signaling_timeout")
	}

	var answerSDP string
	var lf *apiFailure
	if mode == multiplayerModeCustom {
		answerSDP, lf = signalCustom(address, port, key, pc.LocalDescription().SDP)
	} else {
		answerSDP, lf = signalStun(address, key, pc.LocalDescription().SDP)
	}
	if lf != nil {
		_ = pc.Close()
		return nil, nil, nil, lf
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answerSDP}); err != nil {
		_ = pc.Close()
		return nil, nil, nil, fail(http.StatusBadRequest, "multiplayer_share_invalid")
	}
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		state := pc.ConnectionState()
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			_ = pc.Close()
			return nil, nil, nil, fail(http.StatusGatewayTimeout, "multiplayer_connection_failed")
		}
		if state == webrtc.PeerConnectionStateConnected && ctl.ReadyState() == webrtc.DataChannelStateOpen && pos.ReadyState() == webrtc.DataChannelStateOpen {
			return pc, ctl, pos, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = pc.Close()
	return nil, nil, nil, fail(http.StatusGatewayTimeout, "multiplayer_connection_failed")
}

// REST surface

func apiErrorDetail(w http.ResponseWriter, status int, code, detail string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	body := contracts.ErrorBody{Code: code}
	if detail != "" {
		body.Detail = &detail
	}
	_ = json.NewEncoder(w).Encode(body)
}

func writeFailure(w http.ResponseWriter, failure *apiFailure) {
	apiErrorDetail(w, failure.status, failure.code, failure.detail)
}

// stunCachePath persists downloaded STUN lists so a refresh carries into later launches and the
// embedded snapshot stays the offline floor.
type stunCache struct {
	SchemaVersion int      `json:"schemaVersion"`
	Servers       []string `json:"servers"`
	NatServers    []string `json:"natServers"`
}

func (m *multiplayerManager) stunCachePath() string {
	return filepath.Join(m.store.root, "user", "multiplayer-stun.json")
}

// loadStunList seeds the in-memory lists: a previously downloaded cache wins over the embedded
// snapshot, and the manager never talks to the network on startup.
func (m *multiplayerManager) loadStunList() {
	var cache stunCache
	if readJSON(m.stunCachePath(), &cache) == nil && cache.SchemaVersion == contracts.ContractSchemaVersion &&
		len(cache.Servers) > 0 && len(cache.NatServers) > 0 {
		m.stunServers = cache.Servers
		m.stunNatServers = cache.NatServers
	}
	if len(m.stunServers) == 0 {
		m.stunServers = defaults.StunServers()
	}
	if len(m.stunNatServers) == 0 {
		m.stunNatServers = defaults.StunNatServers()
	}
}

func (m *multiplayerManager) saveStunList(servers, natServers []string) {
	m.stunListMutex.Lock()
	m.stunServers = servers
	m.stunNatServers = natServers
	m.stunListMutex.Unlock()
	if err := m.store.saveGlobal("multiplayer-stun.json", stunCache{SchemaVersion: contracts.ContractSchemaVersion, Servers: servers, NatServers: natServers}); err != nil {
		log.Printf("multiplayer stun cache persist: %v", err)
	}
}

func (m *multiplayerManager) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/multiplayer/settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		value, revision, etag, err := ReadVersioned(m.store.files, filepath.Join("user", "multiplayer.json"), m.currentSettings())
		if err != nil {
			apiError(w, http.StatusInternalServerError, "multiplayer_settings_invalid")
			return
		}
		versionedJSONResponse(w, value, revision, etag)
	})
	mux.HandleFunc("PUT /api/multiplayer/settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		expected, ok := requireRevision(w, r)
		if !ok {
			return
		}
		var value contracts.MultiplayerSettings
		if !decodeUpdate(w, r, &value) {
			return
		}
		m.settingsSaveMu.Lock()
		defer m.settingsSaveMu.Unlock()
		m.mu.Lock()
		value.PlayerId = m.settings.PlayerId
		m.mu.Unlock()
		if !validMultiplayerSettings(value) {
			apiError(w, http.StatusBadRequest, "multiplayer_settings_invalid")
			return
		}
		revision, etag, err := m.store.files.Update(filepath.Join("user", "multiplayer.json"), expected, defaults.MultiplayerSettings(), value, nil)
		if errors.Is(err, errRevisionConflict) {
			versionedConflict(w, revision, etag)
			return
		}
		if err != nil {
			log.Printf("multiplayer settings save: %v", err)
			apiError(w, http.StatusInternalServerError, "multiplayer_settings_save_failed")
			return
		}
		m.mu.Lock()
		m.settings = value
		m.mu.Unlock()
		m.publishStatus()
		versionedJSONResponse(w, m.currentSettings(), revision, etag)
	})
	mux.HandleFunc("GET /api/multiplayer/status", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		jsonResponse(w, m.status())
	})
	mux.HandleFunc("GET /api/multiplayer/interfaces", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		jsonResponse(w, contracts.MobileInterfaces{Addresses: localInterfaces()})
	})
	mux.HandleFunc("POST /api/multiplayer/host", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var body contracts.MultiplayerHostRequest
		if !decodeUpdate(w, r, &body) {
			return
		}
		status, failure := m.host(body)
		if failure != nil {
			writeFailure(w, failure)
			return
		}
		jsonResponse(w, status)
	})
	mux.HandleFunc("POST /api/multiplayer/join", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var body contracts.MultiplayerJoinRequest
		if !decodeUpdate(w, r, &body) {
			return
		}
		status, failure := m.join(body)
		if failure != nil {
			writeFailure(w, failure)
			return
		}
		jsonResponse(w, status)
	})
	mux.HandleFunc("POST /api/multiplayer/leave", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		m.leave()
		jsonResponse(w, m.status())
	})
	mux.HandleFunc("POST /api/multiplayer/kick", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var body contracts.MultiplayerKickRequest
		if !decodeUpdate(w, r, &body) {
			return
		}
		if failure := m.kick(body.PeerId); failure != nil {
			writeFailure(w, failure)
			return
		}
		jsonResponse(w, m.status())
	})
	mux.HandleFunc("GET /api/multiplayer/stun/servers", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		jsonResponse(w, contracts.StunServerList{Servers: m.currentStunServers()})
	})
	mux.HandleFunc("POST /api/multiplayer/stun/refresh", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		m.stunRefreshMu.Lock()
		defer m.stunRefreshMu.Unlock()
		servers, err := fetchStunServers()
		if err != nil {
			log.Printf("multiplayer stun refresh: %v", err)
			apiError(w, http.StatusBadGateway, "multiplayer_stun_refresh_failed")
			return
		}
		// The NAT-testing list is refreshed alongside so both checks stay on current data.
		natServers := m.currentStunNatServers()
		if fetched, err := fetchStunNatServers(); err == nil {
			natServers = fetched
		}
		m.saveStunList(servers, natServers)
		jsonResponse(w, contracts.StunServerList{Servers: slices.Clone(servers)})
	})
	mux.HandleFunc("POST /api/multiplayer/stun/probe", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var body contracts.StunProbeRequest
		if !decodeUpdate(w, r, &body) {
			return
		}
		if len(body.Servers) > 400 {
			apiError(w, http.StatusBadRequest, "multiplayer_stun_probe_invalid")
			return
		}
		jsonResponse(w, probeStunServers(body.Servers))
	})
	mux.HandleFunc("POST /api/multiplayer/nat-check", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		jsonResponse(w, natCheck(m.currentStunNatServers()))
	})
}

func (m *multiplayerManager) currentStunServers() []string {
	m.stunListMutex.Lock()
	defer m.stunListMutex.Unlock()
	return slices.Clone(m.stunServers)
}

func (m *multiplayerManager) currentStunNatServers() []string {
	m.stunListMutex.Lock()
	defer m.stunListMutex.Unlock()
	return slices.Clone(m.stunNatServers)
}
