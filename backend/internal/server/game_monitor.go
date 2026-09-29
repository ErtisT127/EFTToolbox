package server

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	defaults "efttoolbox/backend/internal/defaults"
	"efttoolbox/backend/internal/gamewatch"
	contracts "efttoolbox/contracts"

	"github.com/ncruces/zenity"
)

func defaultGameMonitorSettings() contracts.GameMonitorSettings {
	value := defaults.UserSettings().GameMonitor
	if home, err := os.UserHomeDir(); err == nil {
		value.ScreenshotDirectory = filepath.Join(home, "Documents", "Escape From Tarkov", "Screenshots")
	}
	return value
}

func validGameMonitorSettings(value contracts.GameMonitorSettings) bool {
	return value.SchemaVersion == contracts.ContractSchemaVersion && gamewatch.ValidMode(gamewatch.Mode(value.Mode)) && len(value.ScreenshotDirectory) < 4096 && len(value.LogDirectory) < 4096
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
	if readJSON(h.store.userPath("game-monitor-state.json"), &state) == nil && state.SchemaVersion == contracts.ContractSchemaVersion {
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
	return h.store.save("game-monitor-state.json", gameMonitorState{SchemaVersion: contracts.ContractSchemaVersion, MapID: h.appliedMapID})
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
	h.monitorStatus = contracts.GameMonitorStatus{SchemaVersion: contracts.ContractSchemaVersion, Mode: settings.Mode, MapId: h.appliedMapID, ScreenshotWatching: settings.ScreenshotDirectory != "", LogWatching: settings.LogDirectory != ""}
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
	h.locationsMu.RLock()
	locations, cached := h.locations[mode]
	h.locationsMu.RUnlock()
	if !cached {
		var loaded map[string]string
		if repo, err := newModeRepository(h.store.root, mode); err == nil && readJSON(filepath.Join(repo.root, "locations.json"), &loaded) == nil {
			locations = loaded
		}
		h.locationsMu.Lock()
		if h.locations == nil {
			h.locations = make(map[string]map[string]string)
		}
		h.locations[mode] = locations
		h.locationsMu.Unlock()
	}
	if locations != nil {
		for _, candidate := range locationCandidates(name) {
			if id := locations[candidate]; id != "" {
				return id
			}
		}
	}
	return name
}

func (h *overlayHub) clearLocationCache() {
	h.locationsMu.Lock()
	h.locations = nil
	h.locationsMu.Unlock()
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

func (h *overlayHub) selectedPlayerMap() (contracts.MapData, string, error) {
	repo := h.store.repository()
	if repo == nil {
		return contracts.MapData{}, "", errors.New("mode_repository_unavailable")
	}
	h.mu.Lock()
	applied := h.appliedMapID
	h.mu.Unlock()
	if applied != "" {
		if value, err := h.store.loadFromRepository(applied, repo, "zh"); err == nil {
			return value, repo.mode, nil
		}
	}
	entries, err := os.ReadDir(filepath.Join(repo.root, "maps"))
	if err != nil {
		return contracts.MapData{}, "", err
	}
	for _, entry := range entries {
		id, ok := mapIDFromFile(entry.Name())
		if entry.IsDir() || !ok {
			continue
		}
		if value, err := h.store.loadFromRepository(id, repo, "zh"); err == nil {
			return value, repo.mode, nil
		}
	}
	return contracts.MapData{}, "", os.ErrNotExist
}

func (h *overlayHub) projectScreenshotPlayer(m contracts.MapData, mode, mapID string, value gamewatch.Screenshot) (contracts.PlayerState, error) {
	return h.projectPlayerOnMode(m, mode, playerInput{
		PlayerId: "self", DisplayName: "You", IsSelf: true, MapId: mapID,
		WorldPosition: contracts.WorldPosition{X: value.X, Y: value.Y, Z: value.Z}, Heading: value.Heading,
	})
}

func (h *overlayHub) publishSelfPlayer(player contracts.PlayerState) {
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
	h.publish(contracts.ServerEvent{Type: "player_upsert", Player: &player})
}

func (h *overlayHub) acceptScreenshot(value gamewatch.Screenshot) error {
	m, mode, err := h.selectedPlayerMap()
	h.mu.Lock()
	pending := h.pendingMap
	pendingMode := h.pendingMode
	autoMap := h.monitorSettings.AutoMapSwitch
	currentMode := h.monitorSettings.Mode
	h.mu.Unlock()
	if autoMap && pending != "" {
		candidateMode := currentMode
		if pendingMode != "" {
			candidateMode = pendingMode
		}
		if candidate, loadErr := h.store.loadFromMode(pending, candidateMode); loadErr == nil {
			m, err = candidate, nil
			mode = candidateMode
		}
	}
	if err != nil || len(m.Floors) == 0 {
		return errors.New("no active map")
	}
	player, err := h.projectScreenshotPlayer(m, mode, m.Id, value)
	if err != nil {
		return err
	}
	h.publishSelfPlayer(player)
	h.mu.Lock()
	defer h.mu.Unlock()
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
		}
		h.clearLocationCache()
		for id, old := range h.players {
			if old.IsSelf && id != player.PlayerId {
				delete(h.players, id)
				h.publish(contracts.ServerEvent{Type: "player_remove", PlayerId: &id})
			}
		}
		if oldMode != h.monitorSettings.Mode {
			mode := h.monitorSettings.Mode
			go func() {
				if _, _, _, err := h.UpdateUserSettings(func(settings *contracts.UserSettings) error {
					settings.GameMonitor.Mode = mode
					return nil
				}); err != nil {
					log.Printf("persist automatic game mode: %v", err)
				}
			}()
			h.monitorDiagnostic("info", "mode_applied", fmt.Sprintf("Mode %q", h.monitorSettings.Mode))
			h.publish(contracts.ServerEvent{Type: "resources_changed"})
			h.publish(contracts.ServerEvent{Type: "mode_applied", GameMonitorStatus: &h.monitorStatus})
		}
	}
	return nil
}

func (h *overlayHub) registerGameMonitor(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/game-monitor/position", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var value contracts.ManualPositionUpdate
		if !decodeUpdate(w, r, &value) {
			return
		}
		if !safeID.MatchString(value.MapId) || len(value.MapId) > 100 {
			apiError(w, http.StatusBadRequest, "map_unknown")
			return
		}
		name := strings.TrimSpace(value.ScreenshotName)
		if name == "" || len(name) > 4096 {
			apiError(w, http.StatusBadRequest, "screenshot_name_invalid")
			return
		}
		position, ok := gamewatch.ParseScreenshotName(name)
		if !ok {
			apiError(w, http.StatusBadRequest, "screenshot_name_invalid")
			return
		}
		repo := h.store.repository()
		if repo == nil {
			apiError(w, http.StatusInternalServerError, "mode_repository_unavailable")
			return
		}
		m, err := h.store.loadFromRepository(value.MapId, repo, "zh")
		if err != nil || len(m.Floors) == 0 {
			apiError(w, http.StatusBadRequest, "map_unknown")
			return
		}
		player, err := h.projectScreenshotPlayer(m, repo.mode, value.MapId, position)
		if err != nil {
			apiError(w, http.StatusBadRequest, "position_update_failed")
			return
		}
		h.publishSelfPlayer(player)
		jsonResponse(w, struct{}{})
	})
	mux.HandleFunc("GET /api/game-monitor/settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		settings, revision, etag, err := ReadVersioned(h.store.files, filepath.Join("user", "user-settings.json"), defaultUserSettings())
		if err != nil {
			apiError(w, http.StatusInternalServerError, "user_settings_invalid")
			return
		}
		versionedJSONResponse(w, settings.GameMonitor, revision, etag)
	})
	mux.HandleFunc("PUT /api/game-monitor/settings", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		expected, ok := requireRevision(w, r)
		if !ok {
			return
		}
		var value contracts.GameMonitorSettings
		if !decodeUpdate(w, r, &value) || !validGameMonitorSettings(value) {
			apiError(w, http.StatusBadRequest, "game_monitor_settings_invalid")
			return
		}
		current, revision, etag, err := h.applyUserSettingsUpdate(expected, func(current *contracts.UserSettings) error {
			current.GameMonitor = value
			return nil
		}, operationID(r), false, true)
		if errors.Is(err, errRevisionConflict) {
			versionedConflict(w, revision, etag)
			return
		}
		if err != nil {
			if code := userSettingsErrorCode(err); code != "" {
				apiError(w, http.StatusBadRequest, code)
			} else {
				apiError(w, http.StatusInternalServerError, "game_monitor_settings_save_failed")
			}
			return
		}
		versionedJSONResponse(w, current.GameMonitor, revision, etag)
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
