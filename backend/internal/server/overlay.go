package server

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"efttoolbox/backend/internal/gamewatch"
	"efttoolbox/backend/internal/mapper"
	contracts "efttoolbox/contracts"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type overlayHub struct {
	logWriter         *dailyLogWriter
	mu                sync.Mutex
	store             *mapStore
	status            contracts.Status
	players           map[string]contracts.PlayerState
	clients           map[chan contracts.ServerEvent]bool
	view              contracts.OverlayView
	pipe              string
	monitor           *gamewatch.Monitor
	monitorSettings   contracts.GameMonitorSettings
	monitorStatus     contracts.GameMonitorStatus
	appliedMapID      string
	detectedMapID     string
	pendingMap        string
	pendingMode       string
	sessionGeneration uint64
	browseMu          sync.Mutex
	browseStateMu     sync.Mutex
	browseActive      map[string]bool
	indexMu           sync.RWMutex
	indexes           map[string]regionIndexSnapshot
	overlapDedup      *overlapDedup
	mobile            *mobileManager
	mobileBase        http.Handler
	multiplayer       *multiplayerManager
}

type regionIndexSnapshot struct {
	basemap  string
	revision int
	index    *mapper.Index
}

type overlapKey struct {
	mapID    string
	basemap  string
	revision int
	firstID  string
	secondID string
}

type overlapDedup struct {
	mu      sync.Mutex
	entries map[overlapKey]*list.Element
	order   *list.List
}

func newOverlapDedup() *overlapDedup {
	return &overlapDedup{entries: map[overlapKey]*list.Element{}, order: list.New()}
}

func (d *overlapDedup) clearMapRevision(mapID, basemap string, revision int) {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for key, element := range d.entries {
		if key.mapID == mapID && key.basemap == basemap && key.revision != revision {
			delete(d.entries, key)
			d.order.Remove(element)
		}
	}
}

func (d *overlapDedup) clear() {
	if d == nil {
		return
	}
	d.mu.Lock()
	d.entries = map[overlapKey]*list.Element{}
	d.order.Init()
	d.mu.Unlock()
}

func (d *overlapDedup) firstOccurrence(key overlapKey) bool {
	if d == nil {
		return true
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if element, ok := d.entries[key]; ok {
		d.order.MoveToFront(element)
		return false
	}
	d.entries[key] = d.order.PushFront(key)
	for d.order.Len() > 200 {
		element := d.order.Back()
		if element == nil {
			break
		}
		delete(d.entries, element.Value.(overlapKey))
		d.order.Remove(element)
	}
	return true
}

func defaultOverlaySettings() contracts.OverlaySettings {
	return contracts.OverlaySettings{
		SchemaVersion: 1, Visible: true, Shape: "square", Width: 384, Height: 384, Left: 24, Top: 24, LockAspect: true, SvgResolution: 2048,
		Opacity: ptr(defaultOpacity), Backdrop: false, SvgQualityMode: stringPtr("auto"),
		FollowCenter: true, FollowFloor: true, FollowZoom: true, TargetZoom: 2, MapZooms: []contracts.MapZoomOverride{},
		Hotkeys: contracts.OverlayHotkeys{ZoomIn: "Ctrl+Alt+Shift+PageUp", ZoomOut: "Ctrl+Alt+Shift+PageDown", FloorUp: "Alt+PageUp", FloorDown: "Alt+PageDown"},
	}
}

// The overlay's opacity is optional in the contract so that a settings file written before it
// existed can be told apart from a deliberate 0% 鈥?a required field would decode as 0 there.
const defaultOpacity = 100

func ptr(value int) *int             { return &value }
func stringPtr(value string) *string { return &value }

// Key names are physical positions, not characters: the same shortcut has to mean the same key on
// any keyboard layout, so a symbol key is spelled after its position (Minus, BracketLeft) rather
// than after what it happens to type.
var hotkeyPattern = regexp.MustCompile(`^(?:(?:Ctrl|Alt|Shift|Win)\+)*(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Insert|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$`)

func validHotkey(value string) bool {
	if value == "" {
		return true
	}
	if len(value) > 64 || !hotkeyPattern.MatchString(value) {
		return false
	}
	parts := strings.Split(value, "+")
	seen := map[string]bool{}
	for _, p := range parts {
		if seen[p] {
			return false
		}
		seen[p] = true
	}
	return true
}

type hotkeyField struct {
	name  string
	value func(*contracts.OverlayHotkeys) *string
}

// hotkeyFields is the single source of truth for which shortcuts exist and in what order. The
// overlay reports registration failures by name, so this order is part of the contract.
var hotkeyFields = []hotkeyField{
	{"toggleEdit", func(h *contracts.OverlayHotkeys) *string { return &h.ToggleEdit }},
	{"toggleVisible", func(h *contracts.OverlayHotkeys) *string { return &h.ToggleVisible }},
	{"zoomIn", func(h *contracts.OverlayHotkeys) *string { return &h.ZoomIn }},
	{"zoomOut", func(h *contracts.OverlayHotkeys) *string { return &h.ZoomOut }},
	{"floorUp", func(h *contracts.OverlayHotkeys) *string { return &h.FloorUp }},
	{"floorDown", func(h *contracts.OverlayHotkeys) *string { return &h.FloorDown }},
	{"toggleBasemap", func(h *contracts.OverlayHotkeys) *string { return &h.ToggleBasemap }},
	{"panUp", func(h *contracts.OverlayHotkeys) *string { return &h.PanUp }},
	{"panDown", func(h *contracts.OverlayHotkeys) *string { return &h.PanDown }},
	{"panLeft", func(h *contracts.OverlayHotkeys) *string { return &h.PanLeft }},
	{"panRight", func(h *contracts.OverlayHotkeys) *string { return &h.PanRight }},
}

func validHotkeyFailures(values []string) bool {
	if len(values) > len(hotkeyFields) {
		return false
	}
	seen := map[string]bool{}
	for _, value := range values {
		if seen[value] || !slices.ContainsFunc(hotkeyFields, func(f hotkeyField) bool { return f.name == value }) {
			return false
		}
		seen[value] = true
	}
	return true
}

// normalizeHotkeys validates and canonicalizes every shortcut in one pass; empty means "not
// registered". Two shortcuts may share a combination: the second one simply fails to register with
// Windows, which the overlay reports and the dashboard shows as a conflict on both fields. Refusing
// the save here would leave the two ends disagreeing about what was stored.
func normalizeHotkeys(h *contracts.OverlayHotkeys) bool {
	for _, field := range hotkeyFields {
		value := field.value(h)
		if !validHotkey(*value) {
			return false
		}
		*value = canonicalHotkey(*value)
	}
	return true
}

// roundTo keeps the digits the contract declares for a field, so a clamped value is also the value
// that gets persisted and echoed back.
func roundTo(value float64, precision int) float64 {
	scale := math.Pow(10, float64(precision))
	return math.Round(value*scale) / scale
}

func clampLimit(value float64, limit contracts.NumericLimit) float64 {
	return roundTo(math.Max(limit.Min, math.Min(limit.Max, value)), limit.Precision)
}

// Modifier order is fixed by the contract so a recorded shortcut reads the same before and after a
// save round trip (see docs/contracts.md).
var modifierOrder = []string{"Ctrl", "Alt", "Shift", "Win"}

func canonicalHotkey(value string) string {
	parts := strings.Split(value, "+")
	modifiers := parts[:len(parts)-1]
	slices.SortFunc(modifiers, func(a, b string) int {
		return slices.Index(modifierOrder, a) - slices.Index(modifierOrder, b)
	})
	return strings.Join(parts, "+")
}

func (h *overlayHub) normalize(v *contracts.OverlaySettings) bool {
	if v.SchemaVersion != 1 || !slices.Contains([]string{"square", "circle"}, v.Shape) || !slices.Contains([]int{1024, 2048, 4096, 8192}, v.SvgResolution) || !finite(v.TargetZoom) || len(v.MapZooms) > 1000 || !normalizeHotkeys(&v.Hotkeys) {
		return false
	}
	if v.SvgQualityMode == nil {
		v.SvgQualityMode = stringPtr("fixed")
	}
	if *v.SvgQualityMode != "auto" && *v.SvgQualityMode != "fixed" {
		return false
	}
	v.Width = int(clampLimit(float64(v.Width), contracts.OverlaySettingsLimits.Width))
	v.Height = int(clampLimit(float64(v.Height), contracts.OverlaySettingsLimits.Height))
	if v.Shape == "circle" {
		v.Height = v.Width
	}
	v.Left = int(clampLimit(float64(v.Left), contracts.OverlaySettingsLimits.Left))
	v.Top = int(clampLimit(float64(v.Top), contracts.OverlaySettingsLimits.Top))
	v.TargetZoom = clampLimit(v.TargetZoom, contracts.OverlaySettingsLimits.TargetZoom)
	opacity := defaultOpacity
	if v.Opacity != nil {
		opacity = int(clampLimit(float64(*v.Opacity), contracts.OverlaySettingsLimits.Opacity))
	}
	v.Opacity = &opacity
	if v.MapZooms == nil {
		v.MapZooms = []contracts.MapZoomOverride{}
	}
	seen := map[string]bool{}
	for i := range v.MapZooms {
		z := &v.MapZooms[i]
		if !finite(z.Zoom) || seen[z.MapId] {
			return false
		}
		if _, err := h.store.load(z.MapId); err != nil {
			return false
		}
		seen[z.MapId] = true
		z.Zoom = clampLimit(z.Zoom, contracts.MapZoomOverrideLimits.Zoom)
	}
	return true
}

func (h *overlayHub) settings() (contracts.OverlaySettings, error) {
	value, err := h.userSettings()
	return value.Overlay, err
}

func localRequest(w http.ResponseWriter, r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		apiError(w, 403, "origin_rejected")
		return false
	}
	host = r.Host
	if value, _, err := net.SplitHostPort(host); err == nil {
		host = value
	}
	if host != "localhost" && !net.ParseIP(host).IsLoopback() {
		apiError(w, 403, "origin_rejected")
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host != r.Host || u.Scheme != "http" {
			apiError(w, 403, "origin_rejected")
			return false
		}
	}
	return true
}

// Caller holds mu. A full subscriber is disconnected, never allowed to silently lose state.
func (h *overlayHub) publish(e contracts.ServerEvent) {
	e.Status = h.status
	e.SentAt = time.Now().UTC().Format(time.RFC3339Nano)
	if e.OperationId == nil {
		id := fmt.Sprintf("backend-%d", time.Now().UnixNano())
		e.OperationId = &id
	}
	for ch := range h.clients {
		select {
		case ch <- e:
		default:
			close(ch)
			delete(h.clients, ch)
		}
	}
	if h.mobile != nil {
		h.mobile.publish(e)
	}
	if h.multiplayer != nil {
		h.multiplayer.onEvent(e)
	}
}

func (h *overlayHub) changed(kind, mapID, operationID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if kind == "calibration_changed" {
		h.invalidateCalibrationMap(mapID)
	}
	e := contracts.ServerEvent{Type: kind, MapId: &mapID, OperationId: &operationID}
	if kind == "preferences_changed" {
		var p contracts.Preferences
		if readJSON(h.store.userPath("map-preferences.json"), &p) == nil {
			normalizeMapPreferences(&p)
			e.Preferences = &p
		}
	}
	h.publish(e)
	if kind == "preferences_changed" && h.mobile != nil && e.Preferences != nil {
		h.mobile.publishFilters(e.Preferences, mapID)
	}
}

func (h *overlayHub) mobileSnapshot() contracts.ServerEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	players := make([]contracts.PlayerState, 0, len(h.players))
	for _, player := range h.players {
		players = append(players, player)
	}
	prefs := contracts.Preferences{SchemaVersion: 1, Maps: []contracts.MapPreference{}, StickerUsage: []contracts.StickerUsage{}}
	_ = readJSON(h.store.userPath("map-preferences.json"), &prefs)
	normalizeMapPreferences(&prefs)
	view := h.view
	monitorStatus := h.monitorStatus
	event := contracts.ServerEvent{Type: "snapshot", Status: h.status, SentAt: time.Now().UTC().Format(time.RFC3339Nano), Players: &players, Preferences: &prefs, OverlayView: &view, GameMonitorStatus: &monitorStatus}
	if settings, err := h.settings(); err == nil {
		event.OverlaySettings = &settings
	}
	return event
}

// Caller holds mu; an old socket must not invalidate its replacement.
func (h *overlayHub) overlayConnected() bool {
	for _, native := range h.clients {
		if native {
			return true
		}
	}
	return false
}

func (h *overlayHub) websocket(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer closeWebSocket(conn)
	readCtx := conn.CloseRead(context.Background())
	h.mu.Lock()
	players := make([]contracts.PlayerState, 0, len(h.players))
	for _, p := range h.players {
		players = append(players, p)
	}
	annotations := []contracts.SharedAnnotation{}
	prefs := contracts.Preferences{SchemaVersion: 1, Maps: []contracts.MapPreference{}, StickerUsage: []contracts.StickerUsage{}}
	_ = readJSON(h.store.userPath("map-preferences.json"), &prefs)
	normalizeMapPreferences(&prefs)
	settings, settingsErr := h.settings()
	view := h.view
	monitorStatus := h.monitorStatus
	e := contracts.ServerEvent{Type: "snapshot", Status: h.status, SentAt: time.Now().UTC().Format(time.RFC3339Nano), Players: &players, Annotations: &annotations, Preferences: &prefs, OverlayView: &view, GameMonitorStatus: &monitorStatus}
	if settingsErr == nil {
		e.OverlaySettings = &settings
	}
	ch := make(chan contracts.ServerEvent, 64)
	h.clients[ch] = r.URL.Query().Get("client") == "overlay"
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, ch)
		if r.URL.Query().Get("client") == "overlay" {
			h.view.Connected = h.overlayConnected()
			view := h.view
			h.publish(contracts.ServerEvent{Type: "overlay_status", OverlayView: &view})
		}
		h.mu.Unlock()
	}()
	send := func(e contracts.ServerEvent) error {
		writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		return wsjson.Write(writeCtx, conn, e)
	}
	if send(e) != nil {
		return
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-readCtx.Done():
			return
		case e, ok := <-ch:
			if !ok || send(e) != nil {
				return
			}
		case <-ticker.C:
			if send(contracts.ServerEvent{Type: "heartbeat", Status: h.status, SentAt: time.Now().UTC().Format(time.RFC3339Nano)}) != nil {
				return
			}
		}
	}
}

func closeWebSocket(conn *websocket.Conn) {
	done := make(chan struct{})
	go func() {
		_ = conn.Close(websocket.StatusNormalClosure, "server shutting down")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		_ = conn.CloseNow()
	}
}

func (h *overlayHub) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/overlay/bootstrap", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		root, err := filepath.Abs(h.store.root)
		if err != nil {
			dataError(w, err)
			return
		}
		mapRoot, err := filepath.Abs(h.store.activeUpstream())
		if err != nil || h.store.repository() == nil {
			if err == nil {
				err = errors.New("mode repository unavailable")
			}
			dataError(w, err)
			return
		}
		jsonResponse(w, contracts.OverlayBootstrap{SchemaVersion: 1, MapDirectory: filepath.Join(mapRoot, "maps"), AssetDirectory: filepath.Join(root, "upstream", "assets"), TileDirectory: filepath.Join(root, "upstream", "tiles"), TileManifestFile: filepath.Join(root, "upstream", "tiles", "manifest.json"), PreferencesFile: h.store.userPath("map-preferences.json"), AnnotationsDirectory: filepath.Join(h.store.userRoot(), "maps"), OverlaySettingsFile: filepath.Join(root, "user", "user-settings.json"), StickersFile: filepath.Join(root, "upstream", "stickers.json"), WebsocketPath: "/ws", LogPipeName: h.pipe})
	})
	mux.HandleFunc("GET /api/user-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		value, err := h.userSettings()
		if err != nil {
			if code := userSettingsErrorCode(err); code != "" {
				apiError(w, http.StatusInternalServerError, code)
			} else {
				apiError(w, http.StatusInternalServerError, "request_failed")
			}
			return
		}
		jsonResponse(w, value)
	})
	mux.HandleFunc("POST /api/data/reset-user-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		value := defaultUserSettings()
		if err := h.applyUserSettings(value, operationID(r), true, true); err != nil {
			apiError(w, http.StatusInternalServerError, "user_settings_reset_failed")
			return
		}
		jsonResponse(w, value)
	})
	mux.HandleFunc("PUT /api/user-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var value contracts.UserSettings
		if !decodeUpdate(w, r, &value) {
			return
		}
		if _, code := h.prepareUserSettings(&value, true); code != "" {
			apiError(w, http.StatusBadRequest, code)
			return
		}
		if err := h.applyUserSettings(value, operationID(r), true, true); err != nil {
			if code := userSettingsErrorCode(err); code != "" {
				apiError(w, http.StatusBadRequest, code)
			} else {
				dataError(w, err)
			}
			return
		}
		jsonResponse(w, value)
	})
	mux.HandleFunc("GET /api/overlay-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		v, err := h.settings()
		if err != nil {
			if code := userSettingsErrorCode(err); code != "" {
				apiError(w, http.StatusInternalServerError, code)
			} else {
				dataError(w, err)
			}
			return
		}
		jsonResponse(w, v)
	})
	mux.HandleFunc("PUT /api/overlay-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var v contracts.OverlaySettings
		if !decodeUpdate(w, r, &v) {
			return
		}
		current, err := h.userSettings()
		if err != nil {
			dataError(w, err)
			return
		}
		current.Overlay = v
		if _, code := h.prepareUserSettings(&current, false); code != "" {
			apiError(w, 400, "overlay_settings_invalid")
			return
		}
		if err := h.applyUserSettings(current, operationID(r), true, false); err != nil {
			dataError(w, err)
			return
		}
		jsonResponse(w, current.Overlay)
	})
	mux.HandleFunc("GET /api/overlay/state", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		jsonResponse(w, h.view)
	})
	mux.HandleFunc("PUT /api/overlay/state", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var v contracts.OverlayView
		if !decodeUpdate(w, r, &v) {
			return
		}
		zoom := contracts.OverlayViewLimits.Zoom
		if !validBasemap(v.Basemap) || !validPoint(v.Center) || !finite(v.Zoom) || v.Zoom < zoom.Min || v.Zoom > zoom.Max || len(v.Error) > 1024 || !validHotkeyFailures(v.HotkeyFailed) {
			apiError(w, 400, "overlay_settings_invalid")
			return
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		v.Connected = h.overlayConnected()
		h.view = v
		h.publish(contracts.ServerEvent{Type: "overlay_status", OverlayView: &v})
		jsonResponse(w, v)
	})
	mux.HandleFunc("POST /api/overlay/command", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var v contracts.OverlayCommand
		if !decodeUpdate(w, r, &v) {
			return
		}
		if !slices.Contains([]string{"edit", "visible", "view", "hotkeys"}, v.Kind) || v.Center != nil && !validPoint(*v.Center) || v.Zoom != nil && (!finite(*v.Zoom) || *v.Zoom < contracts.OverlayViewLimits.Zoom.Min || *v.Zoom > contracts.OverlayViewLimits.Zoom.Max) || (v.Kind != "view" && v.Enabled == nil) {
			apiError(w, 400, "overlay_settings_invalid")
			return
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		if v.FloorId != nil {
			m, err := h.store.load(h.view.MapId)
			if err != nil || !slices.ContainsFunc(m.Floors, func(f contracts.Floor) bool { return f.Id == *v.FloorId }) {
				apiError(w, 400, "map_unknown")
				return
			}
		}
		if !h.view.Connected {
			apiError(w, http.StatusServiceUnavailable, "overlay_unavailable")
			return
		}
		h.publish(contracts.ServerEvent{Type: "overlay_command", OverlayCommand: &v, OperationId: operationID(r)})
		jsonResponse(w, v)
	})
	mux.HandleFunc("POST /api/dev/player", h.upsertPlayer)
	mux.HandleFunc("DELETE /api/dev/player/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !h.allowPlayer(w, r) {
			return
		}
		id := r.PathValue("id")
		if !safeID.MatchString(id) || len(id) > 100 {
			apiError(w, 400, "player_invalid")
			return
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		delete(h.players, id)
		h.publish(contracts.ServerEvent{Type: "player_remove", PlayerId: &id, OperationId: operationID(r)})
		jsonResponse(w, contracts.ErrorBody{Code: "ok"})
	})
}

func validPoint(p contracts.MapPoint) bool {
	return finite(p.X) && finite(p.Y) && math.Abs(p.X) <= 1e7 && math.Abs(p.Y) <= 1e7
}
func (h *overlayHub) allowPlayer(w http.ResponseWriter, r *http.Request) bool {
	if !localRequest(w, r) {
		return false
	}
	s, err := h.settings()
	if err != nil || !s.DevPlayerEnabled {
		apiError(w, 403, "dev_disabled")
		return false
	}
	return true
}

func (h *overlayHub) upsertPlayer(w http.ResponseWriter, r *http.Request) {
	if !h.allowPlayer(w, r) {
		return
	}
	var v contracts.DevPlayer
	if !decodeUpdate(w, r, &v) {
		return
	}
	player, err := h.projectPlayer(v)
	if err != nil {
		apiError(w, 400, "player_invalid")
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if v.IsSelf {
		for id, old := range h.players {
			if id != v.PlayerId && old.IsSelf {
				old.IsSelf = false
				h.players[id] = old
				h.publish(contracts.ServerEvent{Type: "player_upsert", Player: &old})
			}
		}
	}
	h.players[v.PlayerId] = player
	h.publish(contracts.ServerEvent{Type: "player_upsert", Player: &player, OperationId: operationID(r)})
	jsonResponse(w, player)
}

// applyRemotePlayer projects a teammate's world position with the LOCAL calibration and feeds it
// into the same player fan-out the dashboard, overlay and cast already consume. Players on maps
// this machine does not have are still stored (raw world coordinates); rendering filters by map.
// Projection runs OUTSIDE hub.mu: projectPlayerOnMap re-enters it via currentBasemap.
func (h *overlayHub) applyRemotePlayer(playerID, displayName, color, mapID string, world contracts.WorldPosition, heading float64) {
	if !safeID.MatchString(playerID) || len(playerID) > 100 {
		return
	}
	dev := contracts.DevPlayer{PlayerId: playerID, DisplayName: displayName, IsSelf: false, MapId: mapID, WorldPosition: world, Heading: heading}
	player, err := h.projectPlayer(dev)
	if err != nil {
		player = contracts.PlayerState{
			PlayerId: playerID, DisplayName: displayName, Color: color, IsSelf: false,
			MapId: mapID, WorldPosition: world, Heading: heading,
			Resolution: contracts.LocationResolution{Status: "unresolved", Candidates: []string{}},
		}
	} else {
		player.Color = color
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.players[playerID] = player
	h.publish(contracts.ServerEvent{Type: "player_upsert", Player: &player})
}

func (h *overlayHub) removeRemotePlayer(playerID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.players[playerID]; !ok {
		return
	}
	delete(h.players, playerID)
	h.publish(contracts.ServerEvent{Type: "player_remove", PlayerId: &playerID})
}

func operationID(r *http.Request) *string { id := r.Header.Get("X-Operation-ID"); return &id }

// projectPlayer is shared by the development injection endpoint and the production screenshot
// watcher. The watcher intentionally bypasses the DevPlayerEnabled gate, but uses the same map
// validation and projection math.
func (h *overlayHub) projectPlayer(v contracts.DevPlayer) (contracts.PlayerState, error) {
	m, err := h.store.load(v.MapId)
	if err != nil {
		return contracts.PlayerState{}, errors.New("player_invalid")
	}
	return h.projectPlayerOnMap(m, v)
}

func (h *overlayHub) projectPlayerOnMap(m contracts.MapData, v contracts.DevPlayer) (contracts.PlayerState, error) {
	if !safeID.MatchString(v.PlayerId) || len(v.PlayerId) > 100 || len(v.DisplayName) > 200 ||
		!finite(v.WorldPosition.X) || !finite(v.WorldPosition.Y) || !finite(v.WorldPosition.Z) || math.Abs(v.WorldPosition.X) > 1e7 || math.Abs(v.WorldPosition.Y) > 1e7 || math.Abs(v.WorldPosition.Z) > 1e7 || !finite(v.Heading) || math.Abs(v.Heading) > 1e7 {
		return contracts.PlayerState{}, errors.New("player_invalid")
	}
	p := mapper.Project(m, v.WorldPosition)
	angle := v.Heading * math.Pi / 180
	q := mapper.Project(m, contracts.WorldPosition{X: v.WorldPosition.X + math.Sin(angle), Y: v.WorldPosition.Y, Z: v.WorldPosition.Z + math.Cos(angle)})
	if !validPoint(p) || !validPoint(q) {
		return contracts.PlayerState{}, errors.New("player_invalid")
	}
	heading := math.Mod(math.Atan2(q.X-p.X, -(q.Y-p.Y))*180/math.Pi+360, 360)
	followFloor := true
	if settings, err := h.settings(); err == nil {
		followFloor = settings.FollowFloor
	}
	var snapshot regionIndexSnapshot
	if followFloor {
		snapshot = h.regionIndex(m.Id, h.currentBasemap(m))
	}
	resolution, overlaps := mapper.ResolveWithDiagnostics(snapshot.index, v.WorldPosition, followFloor)
	for _, pair := range overlaps {
		if h.overlapDedup != nil && !h.overlapDedup.firstOccurrence(overlapKey{mapID: m.Id, basemap: snapshot.basemap, revision: snapshot.revision, firstID: pair.FirstID, secondID: pair.SecondID}) {
			continue
		}
		if h.logWriter != nil {
			if err := h.logWriter.write(clientLog{
				Level:     "warn",
				Component: "mapper",
				Event:     "region_overlap",
				Message:   fmt.Sprintf("map=%s basemap=%s revision=%d regions=%s,%s", m.Id, snapshot.basemap, snapshot.revision, pair.FirstID, pair.SecondID),
			}); err != nil {
				log.Printf("write region overlap log: %v", err)
			}
		}
	}
	return contracts.PlayerState{PlayerId: v.PlayerId, DisplayName: v.DisplayName, Color: h.selfColor(), IsSelf: v.IsSelf, MapId: v.MapId, WorldPosition: v.WorldPosition, MapPosition: p, Resolution: resolution, Heading: heading}, nil
}

// selfColor is the identity color every locally produced player state carries; the multiplayer
// manager owns the persisted choice.
func (h *overlayHub) selfColor() string {
	if h.multiplayer != nil {
		if color := h.multiplayer.selfColor(); color != "" {
			return color
		}
	}
	return defaultPlayerColor
}

func (h *overlayHub) currentBasemap(m contracts.MapData) string {
	h.mu.Lock()
	connected := h.overlayConnected()
	view := h.view
	h.mu.Unlock()
	if connected && view.MapId == m.Id && validBasemap(view.Basemap) {
		return view.Basemap
	}
	var preferences contracts.Preferences
	if readJSON(h.store.userPath("map-preferences.json"), &preferences) == nil {
		normalizeMapPreferences(&preferences)
		if preferences.SelectedMap == m.Id {
			for _, preference := range preferences.Maps {
				if preference.MapId == m.Id && validBasemap(preference.Basemap) {
					return preference.Basemap
				}
			}
		}
	}
	if m.SvgUrl != "" {
		return "svg"
	}
	return "tiles"
}

func (h *overlayHub) regionIndex(mapID, basemap string) regionIndexSnapshot {
	key := mapID + ":" + basemap
	h.indexMu.RLock()
	snapshot, ok := h.indexes[key]
	h.indexMu.RUnlock()
	if ok {
		return snapshot
	}
	doc, err := h.store.readCalibrationDocument(mapID, basemap)
	if err != nil {
		doc = emptyCalibrationDocument(mapID, basemap)
	} else if mapData, err := h.store.load(mapID); err != nil || !mapper.ValidDocument(doc, mapData) {
		log.Printf("calibration index: invalid document for map %q", mapID)
		doc = emptyCalibrationDocument(mapID, basemap)
	}
	snapshot = regionIndexSnapshot{basemap: basemap, revision: doc.Revision, index: mapper.Build(doc.Regions)}
	h.indexMu.Lock()
	if h.indexes == nil {
		h.indexes = map[string]regionIndexSnapshot{}
	}
	if current, exists := h.indexes[key]; exists {
		h.indexMu.Unlock()
		return current
	}
	h.indexes[key] = snapshot
	h.indexMu.Unlock()
	if h.overlapDedup != nil {
		h.overlapDedup.clearMapRevision(mapID, basemap, snapshot.revision)
	}
	return snapshot
}

func (h *overlayHub) invalidateCalibrationMap(mapID string) {
	h.indexMu.Lock()
	for key := range h.indexes {
		if strings.HasPrefix(key, mapID+":") {
			delete(h.indexes, key)
		}
	}
	h.indexMu.Unlock()
	if h.overlapDedup != nil {
		h.overlapDedup.clear()
	}
}

func (h *overlayHub) invalidateCalibrationIndexes() {
	h.indexMu.Lock()
	h.indexes = map[string]regionIndexSnapshot{}
	h.indexMu.Unlock()
	if h.overlapDedup != nil {
		h.overlapDedup.clear()
	}
}
