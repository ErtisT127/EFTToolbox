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
	"unicode"

	defaults "efttoolbox/backend/internal/defaults"
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
	locationsMu       sync.RWMutex
	locations         map[string]map[string]string
	overlapDedup      *overlapDedup
	mobile            *mobileManager
	mobileBase        http.Handler
	multiplayer       *multiplayerManager
	// The backend owns the recognition state: what is running now and the last finished result, so
	// both the dashboard and the overlay render the same thing.
	recognitionStart *contracts.RecognitionStart
	recognition      *contracts.RecognitionResult
	recognitionAt    time.Time
}

type playerInput struct {
	PlayerId      string
	DisplayName   string
	IsSelf        bool
	MapId         string
	WorldPosition contracts.WorldPosition
	Heading       float64
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
	return defaults.UserSettings().Overlay
}

func defaultRecognitionSettings() contracts.RecognitionSettings {
	return defaults.UserSettings().Recognition
}

// The overlay's opacity is optional in the contract so that a settings file written before it
// existed can be told apart from a deliberate 0% 鈥?a required field would decode as 0 there.
const defaultOpacity = 100

func stringPtr(value string) *string { return &value }

// Key names are physical positions, not characters: the same shortcut has to mean the same key on
// any keyboard layout, so a symbol key is spelled after its position (Minus, BracketLeft) rather
// than after what it happens to type. Mouse buttons follow the same rule, so they are spelled after
// the raw input button they are (Mouse3 middle, Mouse4/Mouse5 the side buttons), not after the
// back/forward action a driver may map them to.
var hotkeyPattern = regexp.MustCompile(`^(?:(?:Ctrl|Alt|Shift|Win)\+)*(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Insert|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|WheelUp|WheelDown|Mouse3|Mouse4|Mouse5)$`)

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
// overlay reports bindings that could not be enabled by name, so this order is part of the contract.
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
	{"recognition", func(h *contracts.OverlayHotkeys) *string { return &h.Recognition }},
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
// registered". Two shortcuts may share a combination: the overlay enables the first and reports the
// later binding, which the dashboard shows as a conflict on both fields. Refusing
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
	if v.SchemaVersion != contracts.ContractSchemaVersion || !slices.Contains([]string{"square", "circle"}, v.Shape) || !slices.Contains([]int{1024, 2048, 4096, 8192}, v.SvgResolution) || !finite(v.TargetZoom) || len(v.MapZooms) > 1000 || !normalizeHotkeys(&v.Hotkeys) {
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
	for i := 0; i < len(v.MapZooms); {
		z := &v.MapZooms[i]
		if !finite(z.Zoom) || seen[z.MapId] {
			return false
		}
		seen[z.MapId] = true
		z.Zoom = clampLimit(z.Zoom, contracts.MapZoomOverrideLimits.Zoom)
		// Overrides for maps that left the catalogue are dropped, not rejected: a stale id must
		// never invalidate the whole settings file.
		if !h.store.hasMap(z.MapId) {
			v.MapZooms = append(v.MapZooms[:i], v.MapZooms[i+1:]...)
			continue
		}
		i++
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
	// The local annotation owner id rides on every event: the cast and the overlay need it for the
	// shared owner-visibility rule, and a rotated identity then propagates without an extra fetch.
	if h.multiplayer != nil {
		owner := h.multiplayer.selfID()
		e.OwnerId = &owner
	}
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

func (h *overlayHub) preferencesChanged(value contracts.Preferences, mapID, operationID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	// A manual selection counts as the applied map, so the auto-switch can
	// recognize "already switched" and only mark a pending detection consumed.
	if mapID != "" && mapID != h.appliedMapID {
		if _, err := h.store.loadFromMode(mapID, h.monitorSettings.Mode); err == nil {
			h.appliedMapID = mapID
			h.monitorStatus.MapId = mapID
			_ = h.persistAppliedMap()
		}
	}
	e := contracts.ServerEvent{Type: "preferences_changed", MapId: &mapID, OperationId: &operationID, Preferences: &value}
	h.publish(e)
	if h.mobile != nil {
		h.mobile.publishFilters(&value, mapID)
	}
}

// markerPreferencesChanged mirrors preferencesChanged for the owner-visibility lists: the cast
// page renders markers with the same hidden/shown owners as the dashboard map.
func (h *overlayHub) markerPreferencesChanged(value contracts.MarkerPreferences, operationID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	e := contracts.ServerEvent{Type: "marker_preferences_changed", OperationId: &operationID, MarkerPreferences: &value}
	h.publish(e)
	if h.mobile != nil {
		h.mobile.publishMarkerPreferences(value)
	}
}

func (h *overlayHub) mobileSnapshot() contracts.ServerEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	players := make([]contracts.PlayerState, 0, len(h.players))
	for _, player := range h.players {
		players = append(players, player)
	}
	prefs := defaults.MapPreferences()
	_ = readJSON(h.store.userPath("map-preferences.json"), &prefs)
	normalizeMapPreferences(&prefs)
	view := h.view
	monitorStatus := h.monitorStatus
	event := contracts.ServerEvent{Type: "snapshot", Status: h.status, SentAt: time.Now().UTC().Format(time.RFC3339Nano), Players: &players, Preferences: &prefs, OverlayView: &view, GameMonitorStatus: &monitorStatus}
	if h.multiplayer != nil {
		// The phone cannot read the multiplayer settings, so the roster and the local owner id it
		// needs for the shared owner-visibility rule ride on the snapshot.
		status := h.multiplayer.status()
		event.MultiplayerStatus = &status
		owner := h.multiplayer.selfID()
		event.OwnerId = &owner
	}
	// Marker preferences are global (not mode-scoped): the cast mirrors the dashboard's
	// owner-visibility filters from the same file the marker-preferences API serves.
	var markerPrefs contracts.MarkerPreferences
	if readJSON(filepath.Join(h.store.root, "user", "marker-preferences.json"), &markerPrefs) == nil && validMarkerPreferences(markerPrefs) {
		event.MarkerPreferences = &markerPrefs
	}
	if settings, err := h.settings(); err == nil {
		event.OverlaySettings = &settings
	}
	if user, err := h.userSettings(); err == nil {
		event.RecognitionSettings = &user.Recognition
		language := user.Language
		event.Language = &language
	}
	if h.recognitionStart != nil {
		event.RecognitionStart = h.recognitionStart
	}
	if h.recognition != nil {
		event.RecognitionResult = h.recognition
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
	prefs := defaults.MapPreferences()
	_ = readJSON(h.store.userPath("map-preferences.json"), &prefs)
	normalizeMapPreferences(&prefs)
	settings, settingsErr := h.settings()
	view := h.view
	monitorStatus := h.monitorStatus
	e := contracts.ServerEvent{Type: "snapshot", Status: h.status, SentAt: time.Now().UTC().Format(time.RFC3339Nano), Players: &players, Annotations: &annotations, Preferences: &prefs, OverlayView: &view, GameMonitorStatus: &monitorStatus}
	if h.multiplayer != nil {
		// The overlay applies the same owner-visibility rule as the dashboard, so its snapshot carries
		// the roster and the local owner id; live changes follow on multiplayer_changed.
		status := h.multiplayer.status()
		e.MultiplayerStatus = &status
		owner := h.multiplayer.selfID()
		e.OwnerId = &owner
	}
	// Owner visibility is global (not mode-scoped); the overlay renders the same owner lists the
	// dashboard's layer panel edits.
	var markerPrefs contracts.MarkerPreferences
	if readJSON(filepath.Join(h.store.root, "user", "marker-preferences.json"), &markerPrefs) == nil && validMarkerPreferences(markerPrefs) {
		e.MarkerPreferences = &markerPrefs
	}
	if settingsErr == nil {
		e.OverlaySettings = &settings
	}
	if user, err := h.userSettings(); err == nil {
		e.RecognitionSettings = &user.Recognition
	}
	if h.recognitionStart != nil {
		e.RecognitionStart = h.recognitionStart
	}
	if h.recognition != nil {
		e.RecognitionResult = h.recognition
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
				err = errors.New("mode_repository_unavailable")
			}
			dataError(w, err)
			return
		}
		jsonResponse(w, contracts.OverlayBootstrap{SchemaVersion: contracts.ContractSchemaVersion, MapDirectory: filepath.Join(mapRoot, "maps"), AssetDirectory: filepath.Join(root, "upstream", "assets"), TileDirectory: filepath.Join(root, "upstream", "tiles"), TileManifestFile: filepath.Join(root, "upstream", "tiles", "manifest.json"), PreferencesFile: h.store.userPath("map-preferences.json"), MarkerPreferencesFile: filepath.Join(root, "user", "marker-preferences.json"), AnnotationsDirectory: filepath.Join(h.store.userRoot(), "maps"), OverlaySettingsFile: filepath.Join(root, "user", "user-settings.json"), StickersFile: filepath.Join(root, "upstream", "stickers.json"), WebsocketPath: "/ws", LogPipeName: h.pipe})
	})
	mux.HandleFunc("GET /api/user-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		value, revision, etag, err := ReadVersionedRepair(h.store.files, filepath.Join("user", "user-settings.json"), defaultUserSettings(), func(value *contracts.UserSettings) error {
			if _, code := h.prepareUserSettings(value, false); code != "" {
				return errors.New(code)
			}
			return nil
		})
		if err != nil {
			apiError(w, http.StatusInternalServerError, "user_settings_invalid")
			return
		}
		versionedJSONResponse(w, value, revision, etag)
	})
	mux.HandleFunc("POST /api/data/reset-user-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		value, revision, etag, err := h.resetUserSettings(operationID(r))
		if err != nil {
			apiError(w, http.StatusInternalServerError, "user_settings_reset_failed")
			return
		}
		versionedJSONResponse(w, value, revision, etag)
	})
	mux.HandleFunc("PUT /api/user-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		expected, ok := requireRevision(w, r)
		if !ok {
			return
		}
		var value contracts.UserSettings
		if !decodeUpdate(w, r, &value) {
			return
		}
		saved, revision, etag, err := h.applyUserSettingsUpdate(expected, func(current *contracts.UserSettings) error {
			*current = value
			return nil
		}, operationID(r), true, true)
		if errors.Is(err, errRevisionConflict) {
			versionedConflict(w, revision, etag)
			return
		}
		if err != nil {
			if code := userSettingsErrorCode(err); code != "" {
				apiError(w, http.StatusBadRequest, code)
			} else {
				dataError(w, err)
			}
			return
		}
		versionedJSONResponse(w, saved, revision, etag)
	})
	mux.HandleFunc("GET /api/overlay-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		v, revision, etag, err := ReadVersionedRepair(h.store.files, filepath.Join("user", "user-settings.json"), defaultUserSettings(), func(value *contracts.UserSettings) error {
			if _, code := h.prepareUserSettings(value, false); code != "" {
				return errors.New(code)
			}
			return nil
		})
		if err != nil {
			apiError(w, http.StatusInternalServerError, "user_settings_invalid")
			return
		}
		versionedJSONResponse(w, v.Overlay, revision, etag)
	})
	mux.HandleFunc("PUT /api/overlay-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		expected, ok := requireRevision(w, r)
		if !ok {
			return
		}
		var v contracts.OverlaySettings
		if !decodeUpdate(w, r, &v) {
			return
		}
		current, revision, etag, err := h.applyUserSettingsUpdate(expected, func(current *contracts.UserSettings) error {
			current.Overlay = v
			return nil
		}, operationID(r), true, false)
		if errors.Is(err, errRevisionConflict) {
			versionedConflict(w, revision, etag)
			return
		}
		if err != nil {
			if code := userSettingsErrorCode(err); code != "" {
				apiError(w, http.StatusBadRequest, code)
			} else {
				dataError(w, err)
			}
			return
		}
		versionedJSONResponse(w, current.Overlay, revision, etag)
	})
	mux.HandleFunc("GET /api/recognition-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		value, revision, etag, err := ReadVersionedRepair(h.store.files, filepath.Join("user", "user-settings.json"), defaultUserSettings(), func(value *contracts.UserSettings) error {
			if _, code := h.prepareUserSettings(value, false); code != "" {
				return errors.New(code)
			}
			return nil
		})
		if err != nil {
			apiError(w, http.StatusInternalServerError, "user_settings_invalid")
			return
		}
		versionedJSONResponse(w, value.Recognition, revision, etag)
	})
	mux.HandleFunc("PUT /api/recognition-settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		expected, ok := requireRevision(w, r)
		if !ok {
			return
		}
		var value contracts.RecognitionSettings
		if !decodeUpdate(w, r, &value) || !normalizeRecognition(&value) {
			apiError(w, http.StatusBadRequest, "recognition_settings_invalid")
			return
		}
		current, revision, etag, err := h.applyUserSettingsUpdate(expected, func(current *contracts.UserSettings) error {
			current.Recognition = value
			return nil
		}, operationID(r), true, false)
		if errors.Is(err, errRevisionConflict) {
			versionedConflict(w, revision, etag)
			return
		}
		if err != nil {
			if code := userSettingsErrorCode(err); code != "" {
				apiError(w, http.StatusBadRequest, code)
			} else {
				dataError(w, err)
			}
			return
		}
		versionedJSONResponse(w, current.Recognition, revision, etag)
	})
	mux.HandleFunc("POST /api/recognition/request", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var value contracts.RecognitionRequest
		if !decodeUpdate(w, r, &value) || value.RequestId == "" || len(value.ImageData) > 16<<20 {
			apiError(w, http.StatusBadRequest, "recognition_request_invalid")
			return
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		if !h.view.Connected {
			apiError(w, http.StatusServiceUnavailable, "overlay_unavailable")
			return
		}
		h.startRecognitionLocked(value.RequestId, operationID(r))
		h.logRecognition("info", "recognition_request", fmt.Sprintf("imageBytes=%d", len(value.ImageData)))
		h.publish(contracts.ServerEvent{Type: "recognition_request", RecognitionRequest: &value, OperationId: operationID(r)})
		jsonResponse(w, value)
	})
	// A hotkey capture starts in the overlay, so it announces itself here to clear the previous
	// result and put both displays into their loading state.
	mux.HandleFunc("POST /api/recognition/started", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var value contracts.RecognitionStart
		if !decodeUpdate(w, r, &value) || value.RequestId == "" {
			apiError(w, http.StatusBadRequest, "recognition_request_invalid")
			return
		}
		h.mu.Lock()
		h.startRecognitionLocked(value.RequestId, operationID(r))
		h.mu.Unlock()
		jsonResponse(w, value)
	})
	mux.HandleFunc("DELETE /api/recognition-result", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		h.mu.Lock()
		if requestID := r.URL.Query().Get("requestId"); requestID != "" {
			started := h.recognitionStart != nil && h.recognitionStart.RequestId == requestID
			result := h.recognition != nil && h.recognition.RequestId == requestID
			if !started && !result {
				h.mu.Unlock()
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		h.recognition = nil
		h.recognitionStart = nil
		h.recognitionAt = time.Time{}
		h.publish(contracts.ServerEvent{Type: "recognition_cleared", OperationId: operationID(r)})
		h.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	// The overlay asks for the items its OCR text could be before it spends any pixels on the icon
	// check, so short-name priority and the noise filter stay in one place.
	mux.HandleFunc("POST /api/recognition/candidates", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var value contracts.RecognitionCandidateRequest
		if !decodeUpdate(w, r, &value) || len(value.Texts) > 128 {
			apiError(w, http.StatusBadRequest, "recognition_request_invalid")
			return
		}
		user, err := h.userSettings()
		if err != nil {
			dataError(w, err)
			return
		}
		catalog, ok := recognitionCatalog(h.store, mapLang(user.Language))
		if !ok {
			apiError(w, http.StatusNotFound, "items_not_available")
			return
		}
		jsonResponse(w, contracts.RecognitionCandidates{Candidates: recognitionCandidates(catalog, value.Texts, user.Recognition)})
	})
	mux.HandleFunc("POST /api/recognition/result", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var value contracts.RecognitionResult
		if !decodeUpdate(w, r, &value) || value.RequestId == "" || len(value.ImageData) > 16<<20 || len(value.OcrText) > 128 || len(value.Rows) > 256 {
			apiError(w, http.StatusBadRequest, "recognition_result_invalid")
			return
		}
		settings := defaultRecognitionSettings()
		locale := "zh"
		if user, settingsErr := h.userSettings(); settingsErr == nil {
			settings = user.Recognition
			locale = mapLang(user.Language)
		}
		value.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
		value.Rows = enrichRecognitionRows(h.store, value, settings, locale)
		h.mu.Lock()
		if h.recognitionStart == nil || h.recognitionStart.RequestId != value.RequestId {
			h.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.recognition = &value
		h.recognitionAt = time.Now()
		h.recognitionStart = nil
		h.publish(contracts.ServerEvent{Type: "recognition_result", RecognitionResult: &value, OperationId: operationID(r)})
		h.mu.Unlock()
		level := "info"
		if value.Error != "" {
			level = "warn"
		}
		h.logRecognition(level, "recognition_result", fmt.Sprintf("texts=%d rows=%d template=%s error=%q", len(value.OcrText), len(value.Rows), recognitionTemplateSummary(value.Rows), value.Error))
		jsonResponse(w, value)
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
}

// Recognition spans two processes, so an accepted request and its result each leave one line in the
// daily log instead of only existing as a dashboard notice.
func (h *overlayHub) logRecognition(level, event, message string) {
	if h.logWriter == nil {
		return
	}
	if err := h.logWriter.write(clientLog{Level: level, Component: "recognition", Event: event, Message: message}); err != nil {
		log.Printf("write recognition log: %v", err)
	}
}

// A run starts by clearing what the last one produced: both displays show the empty/loading state
// until the new result lands, so nothing on screen belongs to an older capture.
func (h *overlayHub) startRecognitionLocked(requestId string, operationID *string) {
	previous := h.recognitionAt
	h.recognition = nil
	h.recognitionAt = time.Time{}
	h.recognitionStart = &contracts.RecognitionStart{RequestId: requestId}
	h.publish(contracts.ServerEvent{Type: "recognition_started", RecognitionStart: h.recognitionStart, OperationId: operationID})
	age := "none"
	if !previous.IsZero() {
		age = time.Since(previous).Round(time.Second).String()
	}
	h.logRecognition("info", "recognition_started", fmt.Sprintf("clearedResultAge=%s", age))
}

// The items catalog the mode's recognition runs against, in the interface language: the reader
// screenshots the game they play, so the text being matched and the names it shows are that
// language too. Prices and picture paths are locale-independent.
func recognitionCatalog(store *mapStore, locale string) (contracts.ItemsCatalog, bool) {
	var catalog contracts.ItemsCatalog
	mode := "pvp"
	if repo := store.repository(); repo != nil {
		mode = repo.mode
	}
	if readJSON(filepath.Join(store.root, "upstream", "items", mode, "items_"+locale+".json"), &catalog) != nil {
		return catalog, false
	}
	return catalog, true
}

func enrichRecognitionRows(store *mapStore, result contracts.RecognitionResult, settings contracts.RecognitionSettings, locale string) []contracts.RecognitionRow {
	catalog, ok := recognitionCatalog(store, locale)
	if !ok {
		return result.Rows
	}
	byId := make(map[string]contracts.ItemsCatalogItem, len(catalog.Items))
	for _, item := range catalog.Items {
		byId[item.Id] = item
	}
	rows := make([]contracts.RecognitionRow, 0, len(result.Rows))
	seen := map[string]bool{}
	// Rows the overlay already resolved carry the icon score it measured; the catalog still supplies
	// the name, the picture and both prices.
	for _, row := range result.Rows {
		item, known := byId[row.Id]
		if !known || seen[item.Id] {
			continue
		}
		seen[item.Id] = true
		rows = append(rows, recognitionRow(item, row.OcrConfidence, row.TemplateConfidence))
	}
	// The icon check resolves every text itself — including the ones it deliberately drops in strict
	// mode — so its verdict must not be undone by matching those texts by name again.
	if result.RowsResolved {
		return sortRecognitionRows(rows)
	}
	for _, text := range result.OcrText {
		query := normalizeRecognitionText(text)
		if !usableRecognitionQuery(query, settings.OcrMinLength) {
			continue
		}
		index, score := matchRecognitionItem(catalog.Items, query, settings.NameSimilarity)
		if index < 0 {
			continue
		}
		item := catalog.Items[index]
		// Two OCR lines can name the same item; the first one keeps the row.
		if seen[item.Id] {
			continue
		}
		seen[item.Id] = true
		rows = append(rows, recognitionRow(item, score, 0))
	}
	return sortRecognitionRows(rows)
}

func sortRecognitionRows(rows []contracts.RecognitionRow) []contracts.RecognitionRow {
	slices.SortStableFunc(rows, func(a, b contracts.RecognitionRow) int {
		ap, bp := maxRecognitionPrice(a), maxRecognitionPrice(b)
		if ap != bp {
			if ap > bp {
				return -1
			}
			return 1
		}
		return strings.Compare(a.Name, b.Name)
	})
	return rows
}

func recognitionRow(item contracts.ItemsCatalogItem, ocrConfidence, templateConfidence float64) contracts.RecognitionRow {
	return contracts.RecognitionRow{Id: item.Id, Name: item.Name, Image: item.Image, TraderPrice: item.TraderPrice, Trader: item.Trader, FleaPrice: item.FleaPrice, OcrConfidence: ocrConfidence, TemplateConfidence: templateConfidence}
}

// The icon scores of one result, so tuning a threshold does not need the panel on screen.
func recognitionTemplateSummary(rows []contracts.RecognitionRow) string {
	if len(rows) == 0 {
		return "none"
	}
	minimum, maximum, total := rows[0].TemplateConfidence, rows[0].TemplateConfidence, 0.0
	for _, row := range rows {
		minimum = math.Min(minimum, row.TemplateConfidence)
		maximum = math.Max(maximum, row.TemplateConfidence)
		total += row.TemplateConfidence
	}
	return fmt.Sprintf("min=%.2f avg=%.2f max=%.2f", minimum, total/float64(len(rows)), maximum)
}

// The candidate shortlist the overlay's icon check starts from: every item the text resembles at
// least as much as the name threshold, best first, capped at the configured limit.
func recognitionCandidates(catalog contracts.ItemsCatalog, texts []string, settings contracts.RecognitionSettings) [][]contracts.RecognitionCandidate {
	limit := settings.CandidateLimit
	result := make([][]contracts.RecognitionCandidate, 0, len(texts))
	for _, text := range texts {
		candidates := []contracts.RecognitionCandidate{}
		query := normalizeRecognitionText(text)
		if usableRecognitionQuery(query, settings.OcrMinLength) {
			type scored struct {
				item  contracts.ItemsCatalogItem
				score float64
			}
			matches := make([]scored, 0, limit*4)
			for _, item := range catalog.Items {
				score := recognitionItemScore(item, query)
				if score >= settings.NameSimilarity {
					matches = append(matches, scored{item: item, score: score})
				}
			}
			slices.SortStableFunc(matches, func(a, b scored) int {
				if a.score != b.score {
					if a.score > b.score {
						return -1
					}
					return 1
				}
				return strings.Compare(a.item.Name, b.item.Name)
			})
			for index, match := range matches {
				if index >= limit {
					break
				}
				candidates = append(candidates, contracts.RecognitionCandidate{Id: match.item.Id, Name: match.item.Name, ShortName: match.item.ShortName, Image: match.item.Image, TraderPrice: match.item.TraderPrice, FleaPrice: match.item.FleaPrice, Similarity: match.score})
			}
		}
		result = append(result, candidates)
	}
	return result
}

// An OCR dump also carries counters, separators and stray glyphs: "50/50" or "392/400" are not item
// names, and a string that short can sit inside a long name by accident.
func usableRecognitionQuery(query string, minLength int) bool {
	letters := false
	for _, r := range query {
		if unicode.IsLetter(r) {
			letters = true
			break
		}
	}
	return letters && len([]rune(query)) >= minLength
}

// A screenshot names an item the way the game's own grid does, so the short name is the first key to
// try; the full name covers the tooltips. Whichever of the two scores higher wins, and the short
// name takes the tie.
func matchRecognitionItem(items []contracts.ItemsCatalogItem, query string, threshold float64) (int, float64) {
	index, score := -1, 0.0
	for i, item := range items {
		candidate := recognitionItemScore(item, query)
		if candidate > score {
			index, score = i, candidate
		}
	}
	if score < threshold {
		return -1, 0
	}
	return index, score
}

// How well one item answers the text: its short name first, the full name as the fallback.
func recognitionItemScore(item contracts.ItemsCatalogItem, query string) float64 {
	short := recognitionSimilarity(query, normalizeRecognitionText(item.ShortName))
	name := recognitionSimilarity(query, normalizeRecognitionText(item.Name))
	if short >= name {
		return short
	}
	return name
}

// OCR separates words differently from the catalog ("MP-133 12铅径" against "MP-133 12 铅径"), so
// the comparison runs on letters and digits alone.
func normalizeRecognitionText(value string) string {
	value = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), "-", " "))
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return r
		}
		return -1
	}, value)
}

func recognitionSimilarity(a, b string) float64 {
	if a == "" || b == "" {
		return 0
	}
	if a == b {
		return 1
	}
	shorter, longer := a, b
	if len([]rune(a)) > len([]rune(b)) {
		shorter, longer = b, a
	}
	if len([]rune(shorter)) >= 3 && strings.Contains(longer, shorter) {
		return 0.86
	}
	// Nothing contains anything: score the characters the two share, which is what a dropped or
	// added separator leaves to go on.
	shared := 0
	remaining := map[rune]int{}
	for _, r := range b {
		remaining[r]++
	}
	for _, r := range a {
		if remaining[r] > 0 {
			remaining[r]--
			shared++
		}
	}
	return 2 * float64(shared) / float64(len([]rune(a))+len([]rune(b)))
}

func maxRecognitionPrice(row contracts.RecognitionRow) int {
	var price int
	if row.TraderPrice != nil && *row.TraderPrice > price {
		price = *row.TraderPrice
	}
	if row.FleaPrice != nil && *row.FleaPrice > price {
		price = *row.FleaPrice
	}
	return price
}

func validPoint(p contracts.MapPoint) bool {
	return finite(p.X) && finite(p.Y) && math.Abs(p.X) <= 1e7 && math.Abs(p.Y) <= 1e7
}

// applyRemotePlayer projects a teammate's world position with the LOCAL calibration and feeds it
// into the same player fan-out the dashboard, overlay and cast already consume. Players on maps
// this machine does not have are still stored (raw world coordinates); rendering filters by map.
// Projection runs OUTSIDE hub.mu: projectPlayer re-enters it via currentBasemap.
func (h *overlayHub) applyRemotePlayer(playerID, displayName, color, mapID string, world contracts.WorldPosition, heading float64) {
	if !safeID.MatchString(playerID) || len(playerID) > 100 {
		return
	}
	input := playerInput{PlayerId: playerID, DisplayName: displayName, IsSelf: false, MapId: mapID, WorldPosition: world, Heading: heading}
	player, err := h.projectPlayer(input)
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

// projectPlayer is shared by the screenshot watcher and multiplayer remote updates.
func (h *overlayHub) projectPlayer(v playerInput) (contracts.PlayerState, error) {
	repo := h.store.repository()
	m, err := h.store.loadFromRepository(v.MapId, repo, "zh")
	if err != nil {
		return contracts.PlayerState{}, errors.New("player_invalid")
	}
	return h.projectPlayerOnMode(m, repo.mode, v)
}

func (h *overlayHub) projectPlayerOnMode(m contracts.MapData, mode string, v playerInput) (contracts.PlayerState, error) {
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
		snapshot = h.regionIndex(m.Id, h.currentBasemap(m, mode))
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
	return defaults.MultiplayerSettings().PlayerColor
}

func (h *overlayHub) currentBasemap(m contracts.MapData, mode string) string {
	h.mu.Lock()
	connected := h.overlayConnected()
	view := h.view
	h.mu.Unlock()
	if connected && view.MapId == m.Id && validBasemap(view.Basemap) {
		return view.Basemap
	}
	var preferences contracts.Preferences
	if mode != "" && readJSON(filepath.Join(h.store.root, "user", "modes", mode, "map-preferences.json"), &preferences) == nil {
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
