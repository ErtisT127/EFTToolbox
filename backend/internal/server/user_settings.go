package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	contracts "efttoolbox/contracts"
)

var errUserSettingsInvalid = errors.New("invalid saved user settings")

func defaultUserSettings() contracts.UserSettings {
	return contracts.UserSettings{
		SchemaVersion: 1,
		Overlay:       defaultOverlaySettings(),
		GameMonitor:   defaultGameMonitorSettings(),
	}
}

func readUserSettings(root string) (contracts.UserSettings, error) {
	defaults := defaultUserSettings()
	data, err := os.ReadFile(filepath.Join(root, "user", "user-settings.json"))
	if errors.Is(err, os.ErrNotExist) {
		return defaults, nil
	}
	if err != nil {
		return defaults, err
	}
	if len(data) > 8<<20 {
		return defaults, errUserSettingsInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var value *contracts.UserSettings
	if err = decoder.Decode(&value); err != nil {
		return defaults, errUserSettingsInvalid
	}
	if value == nil {
		return defaults, errUserSettingsInvalid
	}
	if decoder.Decode(new(any)) != io.EOF {
		return *value, errUserSettingsInvalid
	}
	if value.SchemaVersion != 1 || !validGameMonitorSettings(value.GameMonitor) {
		return *value, errUserSettingsInvalid
	}
	return *value, nil
}

func (h *overlayHub) userSettings() (contracts.UserSettings, error) {
	value, err := readUserSettings(h.store.root)
	if err != nil {
		return value, err
	}
	if !h.normalize(&value.Overlay) {
		return value, errUserSettingsInvalid
	}
	return value, nil
}

func (h *overlayHub) prepareUserSettings(value *contracts.UserSettings, checkMode bool) (*modeRepository, string) {
	if value.SchemaVersion != 1 || !validGameMonitorSettings(value.GameMonitor) {
		return nil, "game_monitor_settings_invalid"
	}
	if !h.normalize(&value.Overlay) {
		return nil, "overlay_settings_invalid"
	}
	if !checkMode {
		return nil, ""
	}
	repo, err := newModeRepository(h.store.root, value.GameMonitor.Mode)
	if err != nil {
		return nil, "game_monitor_mode_unavailable"
	}
	return repo, ""
}

func (h *overlayHub) applyUserSettings(value contracts.UserSettings, operationID *string, overlayChanged, monitorChanged bool) error {
	repo, code := h.prepareUserSettings(&value, monitorChanged)
	if code != "" {
		return errors.New(code)
	}
	h.mu.Lock()
	oldMode := h.monitorSettings.Mode
	oldLogDirectory := h.monitorSettings.LogDirectory
	oldScreenshotDirectory := h.monitorSettings.ScreenshotDirectory
	if err := h.store.saveGlobal("user-settings.json", value); err != nil {
		h.mu.Unlock()
		return err
	}
	if monitorChanged {
		h.monitorSettings = value.GameMonitor
		h.monitorStatus.Mode = value.GameMonitor.Mode
		h.monitorStatus.ScreenshotWatching = value.GameMonitor.ScreenshotDirectory != ""
		h.monitorStatus.LogWatching = value.GameMonitor.LogDirectory != ""
		if oldLogDirectory != value.GameMonitor.LogDirectory || oldScreenshotDirectory != value.GameMonitor.ScreenshotDirectory || oldMode != value.GameMonitor.Mode {
			h.detectedMapID = ""
			h.pendingMap = ""
			h.pendingMode = ""
		}
		if repo != nil {
			h.store.setRepository(repo)
		}
	}
	if overlayChanged {
		h.publish(contracts.ServerEvent{Type: "overlay_settings", OverlaySettings: &value.Overlay, OperationId: operationID})
	}
	if monitorChanged {
		if oldMode != value.GameMonitor.Mode {
			for id, player := range h.players {
				if player.IsSelf {
					delete(h.players, id)
				}
			}
			h.publish(contracts.ServerEvent{Type: "resources_changed"})
		}
		h.publish(contracts.ServerEvent{Type: "game_monitor_changed", GameMonitorStatus: &h.monitorStatus, OperationId: operationID})
	}
	h.mu.Unlock()
	if monitorChanged && h.monitor != nil {
		h.monitor.Apply(h.monitorConfig())
	}
	return nil
}

func userSettingsErrorCode(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, errUserSettingsInvalid) {
		return "user_settings_invalid"
	}
	code := err.Error()
	switch code {
	case "game_monitor_settings_invalid", "overlay_settings_invalid", "game_monitor_mode_unavailable":
		return code
	default:
		return ""
	}
}
