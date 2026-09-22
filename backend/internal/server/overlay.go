package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"efttoolbox/backend/internal/gamewatch"
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
// existed can be told apart from a deliberate 0% — a required field would decode as 0 there.
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
	var v contracts.OverlaySettings
	data, err := os.ReadFile(filepath.Join(h.store.root, "user", "overlay-settings.json"))
	if errors.Is(err, os.ErrNotExist) {
		return defaultOverlaySettings(), nil
	}
	if err != nil {
		return v, err
	}
	if len(data) > 8<<20 {
		return v, errors.New("saved overlay settings exceed size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&v); err != nil {
		return v, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return v, errors.New("multiple saved overlay settings values")
	}
	if !h.normalize(&v) {
		return v, errors.New("invalid saved overlay settings")
	}
	return v, nil
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
}

func (h *overlayHub) changed(kind, mapID, operationID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	e := contracts.ServerEvent{Type: kind, MapId: &mapID, OperationId: &operationID}
	if kind == "preferences_changed" {
		var p contracts.Preferences
		if readJSON(h.store.userPath("map-preferences.json"), &p) == nil {
			e.Preferences = &p
		}
	}
	h.publish(e)
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
		jsonResponse(w, contracts.OverlayBootstrap{SchemaVersion: 1, MapDirectory: filepath.Join(mapRoot, "maps"), AssetDirectory: filepath.Join(root, "upstream", "assets"), TileDirectory: filepath.Join(root, "upstream", "tiles"), TileManifestFile: filepath.Join(root, "upstream", "tiles", "manifest.json"), PreferencesFile: h.store.userPath("map-preferences.json"), AnnotationsDirectory: filepath.Join(h.store.userRoot(), "maps"), OverlaySettingsFile: filepath.Join(root, "user", "overlay-settings.json"), WebsocketPath: "/ws", LogPipeName: h.pipe})
	})
	mux.HandleFunc("GET /api/overlay-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		v, err := h.settings()
		if err != nil {
			dataError(w, err)
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
		if !h.normalize(&v) {
			apiError(w, 400, "overlay_settings_invalid")
			return
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		if err := h.store.saveGlobal("overlay-settings.json", v); err != nil {
			dataError(w, err)
			return
		}
		h.publish(contracts.ServerEvent{Type: "overlay_settings", OverlaySettings: &v, OperationId: operationID(r)})
		jsonResponse(w, v)
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
		if !validPoint(v.Center) || !finite(v.Zoom) || v.Zoom < zoom.Min || v.Zoom > zoom.Max || len(v.Error) > 1024 || !validHotkeyFailures(v.HotkeyFailed) {
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

func validPoint(p contracts.Point) bool {
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
		!validPoint(contracts.Point{X: v.X, Y: v.Z}) || !finite(v.Heading) || math.Abs(v.Heading) > 1e7 ||
		!slices.ContainsFunc(m.Floors, func(f contracts.Floor) bool { return f.Id == v.FloorId }) {
		return contracts.PlayerState{}, errors.New("player_invalid")
	}
	a := m.Projection.Rotation * math.Pi / 180
	c, s := math.Cos(a), math.Sin(a)
	rotate := func(x, y float64) (float64, float64) { return x*c - y*s, x*s + y*c }
	b := m.Projection.Bounds
	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, p := range []contracts.Point{b[0], b[1], {X: b[0].X, Y: b[1].Y}, {X: b[1].X, Y: b[0].Y}} {
		px, py := rotate(p.X, p.Y)
		minX, maxX = math.Min(minX, px), math.Max(maxX, px)
		minY, maxY = math.Min(minY, py), math.Max(maxY, py)
	}
	project := func(x, y float64) contracts.Point {
		px, py := rotate(x, y)
		box := m.Projection.ViewBox
		return contracts.Point{X: box[0] + (px-minX)/(maxX-minX)*box[2], Y: box[1] + (maxY-py)/(maxY-minY)*box[3]}
	}
	p := project(v.X, v.Z)
	angle := v.Heading * math.Pi / 180
	q := project(v.X+math.Sin(angle), v.Z+math.Cos(angle))
	if !validPoint(p) || !validPoint(q) {
		return contracts.PlayerState{}, errors.New("player_invalid")
	}
	heading := math.Mod(math.Atan2(q.X-p.X, -(q.Y-p.Y))*180/math.Pi+360, 360)
	return contracts.PlayerState{PlayerId: v.PlayerId, DisplayName: v.DisplayName, IsSelf: v.IsSelf, MapId: v.MapId, FloorId: v.FloorId, Position: p, Heading: heading}, nil
}
