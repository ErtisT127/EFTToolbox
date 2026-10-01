package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"

	defaults "efttoolbox/backend/internal/defaults"
	contracts "efttoolbox/contracts"
)

var errUserSettingsInvalid = errors.New("invalid saved user settings")

const currentUserSettingsVersion = contracts.UserSettingsVersion

var languages = []string{"zh-CN", "en-US"}

// A missing or unknown language (an older settings file, a newer frontend) falls back to the
// default instead of failing validation, so the rest of the settings still load.
func normalizeLanguage(value *contracts.UserSettings) {
	if !slices.Contains(languages, value.Language) {
		value.Language = "zh-CN"
	}
}

// The close button behavior is a closed set for the same reason as the language: a hand-edited
// file or a newer frontend must not leave the desktop host without a usable action.
var closeActions = []string{"ask", "exit", "tray"}

func normalizeCloseAction(value *contracts.UserSettings) {
	if !slices.Contains(closeActions, value.CloseAction) {
		value.CloseAction = "ask"
	}
}

// The automatic update check is a closed set for the same reason as the language: the field is a
// two-valued choice stored as text, so a settings file written before the field existed (or by a
// newer frontend) reads back as the default instead of as the zero value of a boolean.
var updateChecks = []string{"auto", "manual"}

func normalizeUpdateCheck(value *contracts.UserSettings) {
	if !slices.Contains(updateChecks, value.UpdateCheck) {
		value.UpdateCheck = "auto"
	}
}

func defaultUserSettings() contracts.UserSettings {
	value := defaults.UserSettings()
	value.GameMonitor = defaultGameMonitorSettings()
	return value
}

func normalizeUserSettings(v *contracts.UserSettings) bool {
	return v.SchemaVersion == contracts.ContractSchemaVersion &&
		v.SettingsVersion == currentUserSettingsVersion &&
		validGameMonitorSettings(v.GameMonitor) &&
		normalizeRecognition(&v.Recognition)
}

func normalizeRecognition(v *contracts.RecognitionSettings) bool {
	if v.SchemaVersion != contracts.ContractSchemaVersion || !slices.Contains([]int{3, 5, 10, 15}, v.AutoCloseSeconds) {
		return false
	}
	v.OcrConfidence = clampLimit(v.OcrConfidence, contracts.RecognitionSettingsLimits.OcrConfidence)
	v.NameSimilarity = clampLimit(v.NameSimilarity, contracts.RecognitionSettingsLimits.NameSimilarity)
	v.TemplateSimilarity = clampLimit(v.TemplateSimilarity, contracts.RecognitionSettingsLimits.TemplateSimilarity)
	v.CaptureWidth = int(clampLimit(float64(v.CaptureWidth), contracts.RecognitionSettingsLimits.CaptureWidth))
	v.CaptureHeight = int(clampLimit(float64(v.CaptureHeight), contracts.RecognitionSettingsLimits.CaptureHeight))
	// The capture region is always square, so a hand-edited pair never reaches the screen grab.
	v.CaptureHeight = v.CaptureWidth
	v.OcrUpscale = int(clampLimit(float64(v.OcrUpscale), contracts.RecognitionSettingsLimits.OcrUpscale))
	v.OcrMinLength = int(clampLimit(float64(v.OcrMinLength), contracts.RecognitionSettingsLimits.OcrMinLength))
	v.CandidateLimit = int(clampLimit(float64(v.CandidateLimit), contracts.RecognitionSettingsLimits.CandidateLimit))
	v.TemplateMinScale = clampLimit(v.TemplateMinScale, contracts.RecognitionSettingsLimits.TemplateMinScale)
	v.TemplateMaxScale = clampLimit(v.TemplateMaxScale, contracts.RecognitionSettingsLimits.TemplateMaxScale)
	// A range that runs backwards would leave the icon check with nothing to try.
	if v.TemplateMaxScale < v.TemplateMinScale {
		v.TemplateMaxScale = v.TemplateMinScale
	}
	v.IconWindowRatio = clampLimit(v.IconWindowRatio, contracts.RecognitionSettingsLimits.IconWindowRatio)
	v.WindowWidth = int(clampLimit(float64(v.WindowWidth), contracts.RecognitionSettingsLimits.WindowWidth))
	v.WindowHeight = int(clampLimit(float64(v.WindowHeight), contracts.RecognitionSettingsLimits.WindowHeight))
	v.WindowLeft = int(clampLimit(float64(v.WindowLeft), contracts.RecognitionSettingsLimits.WindowLeft))
	v.WindowTop = int(clampLimit(float64(v.WindowTop), contracts.RecognitionSettingsLimits.WindowTop))
	v.Opacity = int(clampLimit(float64(v.Opacity), contracts.RecognitionSettingsLimits.Opacity))
	return true
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
	data = migrateUserSettings(data)
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var value *contracts.UserSettings
	if err = decoder.Decode(&value); err != nil {
		return defaults, errUserSettingsInvalid
	}
	if value == nil {
		return defaults, errUserSettingsInvalid
	}
	normalizeLanguage(value)
	normalizeCloseAction(value)
	normalizeUpdateCheck(value)
	if decoder.Decode(new(any)) != io.EOF {
		return *value, errUserSettingsInvalid
	}
	if !normalizeUserSettings(value) {
		return *value, errUserSettingsInvalid
	}
	return *value, nil
}

// HostLanguage is the interface language the desktop host renders its own chrome (tray menu, close
// dialog, startup failures) in. The host reads the aggregate user settings directly because it needs
// a language before the backend answers - including while it is showing a startup failure.
func HostLanguage(root string) string {
	value, err := readUserSettings(root)
	if err != nil {
		return defaultUserSettings().Language
	}
	return value.Language
}

// HostCloseAction is the persisted close button behavior: ask, exit or tray.
func HostCloseAction(root string) string {
	value, err := readUserSettings(root)
	if err != nil {
		return defaultUserSettings().CloseAction
	}
	return value.CloseAction
}

// SetHostCloseAction persists the choice the user made in the host's own close dialog. The settings
// API keeps using its revision protocol; this is the one writer outside it, so it re-reads the
// aggregate first and saves atomically, and a corrupt file is reported instead of being replaced by
// defaults so the dashboard's repair flow still owns that decision.
func SetHostCloseAction(root, action string) error {
	value, err := readUserSettings(root)
	if err != nil {
		return err
	}
	value.CloseAction = action
	normalizeCloseAction(&value)
	return (&VersionedFileStore{root: root}).Save(filepath.Join("user", "user-settings.json"), value)
}

func (h *overlayHub) userSettings() (contracts.UserSettings, error) {
	value, err := readUserSettings(h.store.root)
	if err != nil {
		return value, err
	}
	if !h.normalize(&value.Overlay) {
		return value, errUserSettingsInvalid
	}
	if !normalizeRecognition(&value.Recognition) {
		return value, errUserSettingsInvalid
	}
	return value, nil
}

func (h *overlayHub) prepareUserSettings(value *contracts.UserSettings, checkMode bool) (*modeRepository, string) {
	normalizeLanguage(value)
	normalizeCloseAction(value)
	normalizeUpdateCheck(value)
	if !normalizeUserSettings(value) {
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

func (h *overlayHub) UpdateUserSettings(update func(*contracts.UserSettings) error) (contracts.UserSettings, string, string, error) {
	return h.updateUserSettings("", update, false, false, nil, false, true)
}

func (h *overlayHub) updateUserSettings(expected string, update func(*contracts.UserSettings) error, requireExpected, repair bool, operationID *string, overlayChanged, monitorChanged bool) (contracts.UserSettings, string, string, error) {
	if monitorChanged {
		// Record the user's intent before the versioned file mutation so a pending automatic mode
		// write can yield even if it has not reached the file yet.
		h.mu.Lock()
		h.monitorRevision++
		h.mu.Unlock()
	}
	fallback := defaultUserSettings()
	var repo *modeRepository
	var languageChanged bool
	mutate := func(raw any) error {
		value := raw.(*contracts.UserSettings)
		previousLanguage := value.Language
		if err := update(value); err != nil {
			return err
		}
		if value.SettingsVersion == 0 {
			value.SettingsVersion = currentUserSettingsVersion
		}
		languageChanged = value.Language != previousLanguage
		var code string
		repo, code = h.prepareUserSettings(value, monitorChanged)
		if code != "" {
			return errors.New(code)
		}
		return nil
	}
	var raw any
	var revision, etag string
	var err error
	if requireExpected {
		raw, revision, etag, err = h.store.files.CompareAndMutate(filepath.Join("user", "user-settings.json"), expected, &fallback, mutate)
	} else {
		if repair {
			raw, revision, etag, err = h.store.files.MutateRepair(filepath.Join("user", "user-settings.json"), &fallback, mutate)
		} else {
			raw, revision, etag, err = h.store.files.Mutate(filepath.Join("user", "user-settings.json"), &fallback, mutate)
		}
	}
	if err != nil {
		return fallback, revision, etag, err
	}
	value := *raw.(*contracts.UserSettings)
	modeChanged := false
	h.mu.Lock()
	mobile := h.mobile
	oldMode := h.monitorSettings.Mode
	oldLogDirectory := h.monitorSettings.LogDirectory
	if monitorChanged {
		h.monitorSettings = value.GameMonitor
		h.monitorStatus.Mode = value.GameMonitor.Mode
		h.monitorStatus.ScreenshotWatching = value.GameMonitor.ScreenshotDirectory != ""
		h.monitorStatus.LogWatching = value.GameMonitor.LogDirectory != ""
		// A screenshot-directory change is the recovery path for a previously
		// misconfigured watcher, so the pending map must survive it.
		if oldLogDirectory != value.GameMonitor.LogDirectory || oldMode != value.GameMonitor.Mode {
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
		h.publish(contracts.ServerEvent{Type: "recognition_settings", RecognitionSettings: &value.Recognition, OperationId: operationID})
	}
	if monitorChanged {
		if oldMode != value.GameMonitor.Mode {
			modeChanged = true
			for id, player := range h.players {
				if player.IsSelf {
					delete(h.players, id)
				}
			}
			h.publish(contracts.ServerEvent{Type: "resources_changed"})
		}
		h.publish(contracts.ServerEvent{Type: "game_monitor_changed", GameMonitorStatus: &h.monitorStatus, GameMonitorSettings: &value.GameMonitor, OperationId: operationID})
	}
	h.mu.Unlock()
	if modeChanged {
		if h.multiplayer != nil {
			h.multiplayer.resetAnnotationSendState()
			h.multiplayer.resyncAnnotations()
		}
		go h.reprojectRemotePlayers()
	}
	// The phone follows the interface language; it only learns about it through the cast stream.
	if languageChanged && mobile != nil {
		mobile.publishSnapshot()
	}
	if monitorChanged && h.monitor != nil {
		h.monitor.Apply(h.monitorConfig())
	}
	return value, revision, etag, nil
}

func (h *overlayHub) applyUserSettingsUpdate(expected string, update func(*contracts.UserSettings) error, operationID *string, overlayChanged, monitorChanged bool) (contracts.UserSettings, string, string, error) {
	return h.updateUserSettings(expected, update, expected != "", false, operationID, overlayChanged, monitorChanged)
}

func (h *overlayHub) resetUserSettings(operationID *string) (contracts.UserSettings, string, string, error) {
	return h.updateUserSettings("", func(value *contracts.UserSettings) error {
		*value = defaultUserSettings()
		return nil
	}, false, true, operationID, true, true)
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
