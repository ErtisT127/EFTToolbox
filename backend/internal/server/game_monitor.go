package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"efttoolbox/backend/internal/gamewatch"
	contracts "efttoolbox/contracts"

	"github.com/ncruces/zenity"
)

func defaultGameMonitorSettings() contracts.GameMonitorSettings {
	directory := ""
	if home, err := os.UserHomeDir(); err == nil {
		directory = filepath.Join(home, "Documents", "Escape From Tarkov", "Screenshots")
	}
	return contracts.GameMonitorSettings{SchemaVersion: 1, ScreenshotDirectory: directory, Mode: string(gamewatch.ModePVP), AutoMapSwitch: true}
}

func validGameMonitorSettings(value contracts.GameMonitorSettings) bool {
	return value.SchemaVersion == 1 && gamewatch.ValidMode(gamewatch.Mode(value.Mode)) && len(value.ScreenshotDirectory) < 4096 && len(value.LogDirectory) < 4096
}

func loadGameMonitorSettings(root string) contracts.GameMonitorSettings {
	value, err := readUserSettings(root)
	if err != nil {
		return defaultGameMonitorSettings()
	}
	return value.GameMonitor
}

type gameMonitorState struct {
	SchemaVersion int    `json:"schemaVersion"`
	MapID         string `json:"mapId"`
}

func (h *overlayHub) loadAppliedMap() string {
	var state gameMonitorState
	if readJSON(h.store.userPath("game-monitor-state.json"), &state) == nil && state.SchemaVersion == 1 {
		if _, err := h.store.load(state.MapID); err == nil {
			return state.MapID
		}
	}
	var prefs contracts.Preferences
	if readJSON(h.store.userPath("map-preferences.json"), &prefs) == nil {
		if _, err := h.store.load(prefs.SelectedMap); err == nil {
			return prefs.SelectedMap
		}
	}
	return ""
}

func (h *overlayHub) persistAppliedMap() error {
	return h.store.save("game-monitor-state.json", gameMonitorState{SchemaVersion: 1, MapID: h.appliedMapID})
}

func (h *overlayHub) monitorConfig() gamewatch.Config {
	h.mu.Lock()
	defer h.mu.Unlock()
	return gamewatch.Config{ScreenshotDirectory: h.monitorSettings.ScreenshotDirectory, LogDirectory: h.monitorSettings.LogDirectory, DeleteScreenshots: h.monitorSettings.DeleteScreenshots, AutoMapSwitch: h.monitorSettings.AutoMapSwitch}
}

func (h *overlayHub) startGameMonitor(ctx context.Context) {
	settings := loadGameMonitorSettings(h.store.root)
	h.monitorSettings = settings
	repo, err := newModeRepository(h.store.root, settings.Mode)
	if err == nil {
		h.store.setRepository(repo)
	}
	h.appliedMapID = h.loadAppliedMap()
	h.monitorStatus = contracts.GameMonitorStatus{SchemaVersion: 1, Mode: settings.Mode, MapId: h.appliedMapID, ScreenshotWatching: settings.ScreenshotDirectory != "", LogWatching: settings.LogDirectory != ""}
	h.monitor = gamewatch.New(gamewatch.Callbacks{Diagnostic: h.monitorDiagnostic, Screenshot: h.acceptScreenshot, Log: h.acceptLog, SessionChanged: h.monitorSessionChanged, Activity: h.monitorActivity})
	h.monitor.Apply(h.monitorConfig())
	go h.monitor.Run(ctx)
}

func (h *overlayHub) monitorActivity(kind string, at time.Time) {
	h.mu.Lock()
	switch kind {
	case "screenshot":
		h.monitorStatus.LastScreenshotAt = at.UTC().Format(time.RFC3339Nano)
		h.monitorStatus.ScreenshotWatching = h.monitorSettings.ScreenshotDirectory != ""
	case "log":
		h.monitorStatus.LastLogAt = at.UTC().Format(time.RFC3339Nano)
	}
	h.publish(contracts.ServerEvent{Type: "game_monitor_changed", GameMonitorStatus: &h.monitorStatus})
	h.mu.Unlock()
}

func (h *overlayHub) monitorSessionChanged(generation uint64) {
	h.mu.Lock()
	initialized := h.sessionGeneration != 0
	h.sessionGeneration = generation
	h.detectedMapID = ""
	h.pendingMap = ""
	h.pendingMode = ""
	if initialized {
		h.publish(contracts.ServerEvent{Type: "game_monitor_changed", GameMonitorStatus: &h.monitorStatus})
	}
	h.mu.Unlock()
}

func (h *overlayHub) acceptLog(event gamewatch.LogEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if event.Generation != 0 && event.Generation != h.sessionGeneration {
		return
	}
	// Log events only identify candidates. They become authoritative after a
	// position update succeeds, so historical logs cannot lock the UI.
	if event.Mode != "" && string(event.Mode) != h.monitorSettings.Mode {
		h.pendingMode = string(event.Mode)
	}
	if event.Map != "" {
		name := strings.TrimSuffix(filepath.Base(event.Map), filepath.Ext(event.Map))
		mode := h.monitorSettings.Mode
		if h.pendingMode != "" {
			mode = h.pendingMode
		}
		if event.Mode != "" {
			mode = string(event.Mode)
		}
		candidate := h.resolveLocationForMode(name, mode)
		if _, err := h.store.loadFromMode(candidate, mode); err == nil {
			h.detectedMapID, h.pendingMap = candidate, candidate
		} else {
			h.monitorDiagnostic("warn", "map_candidate_rejected", fmt.Sprintf("Map %q resolved to %q in mode %q: %v", name, candidate, mode, err))
		}
	}
	if !event.InitialRead {
		h.monitorStatus.Mode = h.monitorSettings.Mode
		h.monitorStatus.LogWatching = h.monitorSettings.LogDirectory != ""
		h.publish(contracts.ServerEvent{Type: "game_monitor_changed", GameMonitorStatus: &h.monitorStatus})
	}
}

func (h *overlayHub) resolveLocationForMode(name, mode string) string {
	var locations map[string]string
	if repo, err := newModeRepository(h.store.root, mode); err == nil && readJSON(filepath.Join(repo.root, "locations.json"), &locations) == nil {
		for _, candidate := range locationCandidates(name) {
			if id := locations[candidate]; id != "" {
				return id
			}
		}
	}
	return name
}

func locationCandidates(name string) []string {
	name = strings.TrimSpace(name)
	candidates := []string{name}
	if !strings.HasSuffix(strings.ToLower(name), "_preset") {
		return candidates
	}
	base := name[:len(name)-len("_preset")]
	candidates = append(candidates, base)
	for {
		separator := strings.LastIndexByte(base, '_')
		if separator < 0 {
			break
		}
		base = base[:separator]
		candidates = append(candidates, base)
	}
	return candidates
}

func (h *overlayHub) selectedPlayerMap() (contracts.MapData, error) {
	h.mu.Lock()
	applied := h.appliedMapID
	h.mu.Unlock()
	if applied != "" {
		if value, err := h.store.load(applied); err == nil {
			return value, nil
		}
	}
	entries, err := os.ReadDir(filepath.Join(h.store.activeUpstream(), "maps"))
	if err != nil {
		return contracts.MapData{}, err
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		if value, err := h.store.load(strings.TrimSuffix(entry.Name(), ".json")); err == nil {
			return value, nil
		}
	}
	return contracts.MapData{}, os.ErrNotExist
}

func (h *overlayHub) acceptScreenshot(value gamewatch.Screenshot) error {
	m, err := h.selectedPlayerMap()
	h.mu.Lock()
	pending := h.pendingMap
	pendingMode := h.pendingMode
	autoMap := h.monitorSettings.AutoMapSwitch
	currentMode := h.monitorSettings.Mode
	h.mu.Unlock()
	if autoMap && pending != "" {
		mode := currentMode
		if pendingMode != "" {
			mode = pendingMode
		}
		if candidate, loadErr := h.store.loadFromMode(pending, mode); loadErr == nil {
			m, err = candidate, nil
		}
	}
	if err != nil || len(m.Floors) == 0 {
		return errors.New("no active map")
	}
	player, err := h.projectPlayerOnMap(m, contracts.DevPlayer{PlayerId: "self", DisplayName: "You", IsSelf: true, MapId: m.Id, WorldPosition: contracts.WorldPosition{X: value.X, Y: value.Y, Z: value.Z}, Heading: value.Heading})
	if err != nil {
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, old := range h.players {
		if id != player.PlayerId && old.IsSelf {
			old.IsSelf = false
			h.players[id] = old
			h.publish(contracts.ServerEvent{Type: "player_upsert", Player: &old})
		}
	}
	h.players[player.PlayerId] = player
	oldMap := h.appliedMapID
	oldMode := h.monitorSettings.Mode
	if autoMap && h.pendingMap != "" && m.Id == h.pendingMap {
		h.appliedMapID = m.Id
		h.detectedMapID = m.Id
		h.pendingMap = ""
		h.monitorStatus.MapId = m.Id
		_ = h.persistAppliedMap()
		h.monitorDiagnostic("info", "map_applied", fmt.Sprintf("Map %q", m.Id))
	}
	h.publish(contracts.ServerEvent{Type: "player_upsert", Player: &player})
	if oldMap != h.appliedMapID {
		id := h.appliedMapID
		h.publish(contracts.ServerEvent{Type: "map_changed", MapId: &id, GameMonitorStatus: &h.monitorStatus})
	}
	if h.pendingMode != "" {
		h.monitorSettings.Mode = h.pendingMode
		h.pendingMode = ""
		h.monitorStatus.Mode = h.monitorSettings.Mode
		if repo, err := newModeRepository(h.store.root, h.monitorSettings.Mode); err == nil {
			h.store.setRepository(repo)
			if settings, err := readUserSettings(h.store.root); err == nil {
				settings.GameMonitor = h.monitorSettings
				_ = h.store.saveGlobal("user-settings.json", settings)
			}
		}
		for id, old := range h.players {
			if old.IsSelf && id != player.PlayerId {
				delete(h.players, id)
				h.publish(contracts.ServerEvent{Type: "player_remove", PlayerId: &id})
			}
		}
		if oldMode != h.monitorSettings.Mode {
			h.monitorDiagnostic("info", "mode_applied", fmt.Sprintf("Mode %q", h.monitorSettings.Mode))
			h.publish(contracts.ServerEvent{Type: "resources_changed"})
			h.publish(contracts.ServerEvent{Type: "mode_applied", GameMonitorStatus: &h.monitorStatus})
		}
	}
	return nil
}

func (h *overlayHub) registerGameMonitor(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/game-monitor/settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		h.mu.Lock()
		value := h.monitorSettings
		h.mu.Unlock()
		jsonResponse(w, value)
	})
	mux.HandleFunc("PUT /api/game-monitor/settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var value contracts.GameMonitorSettings
		if !decodeUpdate(w, r, &value) || !validGameMonitorSettings(value) {
			apiError(w, http.StatusBadRequest, "game_monitor_settings_invalid")
			return
		}
		current, err := h.userSettings()
		if err != nil {
			apiError(w, http.StatusInternalServerError, "game_monitor_settings_save_failed")
			return
		}
		current.GameMonitor = value
		if _, code := h.prepareUserSettings(&current, true); code != "" {
			apiError(w, http.StatusBadRequest, code)
			return
		}
		if err := h.applyUserSettings(current, operationID(r), false, true); err != nil {
			if code := userSettingsErrorCode(err); code != "" {
				apiError(w, http.StatusBadRequest, code)
			} else {
				apiError(w, http.StatusInternalServerError, "game_monitor_settings_save_failed")
			}
			return
		}
		jsonResponse(w, value)
	})
	mux.HandleFunc("GET /api/game-monitor/status", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		h.mu.Lock()
		value := h.monitorStatus
		h.mu.Unlock()
		jsonResponse(w, value)
	})
	mux.HandleFunc("POST /api/game-monitor/browse/{kind}", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		kind := r.PathValue("kind")
		if kind != "screenshots" && kind != "logs" {
			apiError(w, http.StatusBadRequest, "game_monitor_path_invalid")
			return
		}
		h.browseStateMu.Lock()
		if h.browseActive[kind] {
			h.browseStateMu.Unlock()
			apiError(w, http.StatusConflict, "game_monitor_browse_in_progress")
			return
		}
		h.browseActive[kind] = true
		h.browseStateMu.Unlock()
		defer func() {
			h.browseStateMu.Lock()
			h.browseActive[kind] = false
			h.browseStateMu.Unlock()
		}()
		h.browseMu.Lock()
		path, err := zenity.SelectFile(
			zenity.Directory(),
			zenity.Modal(),
			zenity.Title("Select EFT "+kind+" directory"),
		)
		h.browseMu.Unlock()
		if errors.Is(err, zenity.ErrCanceled) {
			jsonResponse(w, map[string]string{"path": ""})
			return
		}
		if err != nil {
			apiError(w, http.StatusInternalServerError, "game_monitor_browse_failed")
			return
		}
		jsonResponse(w, map[string]string{"path": path})
	})
}
