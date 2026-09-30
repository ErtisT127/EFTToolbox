package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	contracts "efttoolbox/contracts"
)

func callLocalJSON(t *testing.T, handler http.Handler, method, path string, value any) *httptest.ResponseRecorder {
	t.Helper()
	var body []byte
	if value != nil {
		var err error
		body, err = json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.RemoteAddr = "127.0.0.1:1234"
	request.Host = "localhost"
	request.Header.Set("Content-Type", "application/json")
	if method == http.MethodPut || path == "/api/data/reset-user-settings" {
		getPath := path
		if path == "/api/data/reset-user-settings" {
			getPath = "/api/user-settings"
		}
		get := httptest.NewRequest(http.MethodGet, getPath, nil)
		get.RemoteAddr, get.Host = request.RemoteAddr, request.Host
		current := httptest.NewRecorder()
		handler.ServeHTTP(current, get)
		request.Header.Set("If-Match", current.Header().Get("ETag"))
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestInvalidUserSettingsHasDedicatedError(t *testing.T) {
	root, handler := mapFixture(t)
	path := filepath.Join(root, "user", "user-settings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{
		"{",
		`{"schemaVersion":1,"overlay":{},"gameMonitor":{},"unknown":true}`,
		`{} {}`,
	} {
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
		response := callLocalJSON(t, handler, "GET", "/api/user-settings", nil)
		if response.Code != http.StatusInternalServerError || !bytes.Contains(response.Body.Bytes(), []byte(`"code":"user_settings_invalid"`)) {
			t.Fatalf("invalid user settings was not classified correctly: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestResetUserSettingsRestoresDefaultsOnly(t *testing.T) {
	root, handler := mapFixture(t)
	settingsPath := filepath.Join(root, "user", "user-settings.json")
	keepPath := filepath.Join(root, "user", "keep.txt")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settingsPath, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keepPath, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}

	response := callLocalJSON(t, handler, "POST", "/api/data/reset-user-settings", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("reset failed: %d %s", response.Code, response.Body.String())
	}
	var value contracts.UserSettings
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil || value.SchemaVersion != 1 {
		t.Fatalf("reset response is not default settings: %s", response.Body.String())
	}
	if _, err := readUserSettings(root); err != nil {
		t.Fatalf("reset did not write valid settings: %v", err)
	}
	if data, err := os.ReadFile(keepPath); err != nil || string(data) != "keep" {
		t.Fatalf("reset touched unrelated user data: %q %v", data, err)
	}
}

func TestRecognitionWarmupMigrationPreservesExplicitDisable(t *testing.T) {
	root, handler := mapFixture(t)
	path := filepath.Join(root, "user", "user-settings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	write := func(warmup any) {
		t.Helper()
		value := defaultUserSettings()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var document map[string]json.RawMessage
		if err := json.Unmarshal(raw, &document); err != nil {
			t.Fatal(err)
		}
		var recognition map[string]json.RawMessage
		if err := json.Unmarshal(document["recognition"], &recognition); err != nil {
			t.Fatal(err)
		}
		if warmup == nil {
			delete(recognition, "ocrWarmup")
			delete(document, "settingsVersion")
		} else {
			recognition["ocrWarmup"], err = json.Marshal(warmup)
			if err != nil {
				t.Fatal(err)
			}
		}
		document["recognition"], err = json.Marshal(recognition)
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(document)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	read := func() contracts.UserSettings {
		t.Helper()
		response := callLocalJSON(t, handler, http.MethodGet, "/api/user-settings", nil)
		if response.Code != http.StatusOK {
			t.Fatalf("settings GET failed: %d %s", response.Code, response.Body.String())
		}
		var value contracts.UserSettings
		if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		return value
	}

	write(nil)
	if err := SetHostCloseAction(root, "tray"); err != nil {
		t.Fatal(err)
	}
	if value, err := readUserSettings(root); err != nil || !value.Recognition.OcrWarmup {
		t.Fatalf("legacy host write disabled OCR warmup: %+v %v", value.Recognition, err)
	}
	if value := read(); !value.Recognition.OcrWarmup {
		t.Fatal("legacy settings did not enable OCR warmup")
	}
	write(false)
	if value := read(); value.Recognition.OcrWarmup {
		t.Fatal("explicitly disabled OCR warmup was overwritten")
	}
}

func TestHostCloseActionDefaultsAndPersistence(t *testing.T) {
	root := t.TempDir()
	if action := HostCloseAction(root); action != "ask" {
		t.Fatalf("missing settings should ask before closing, got %q", action)
	}
	if language := HostLanguage(root); language != "zh-CN" {
		t.Fatalf("missing settings should default the host language, got %q", language)
	}

	// A file written before closeAction existed keeps its other values and reads back as "ask".
	raw, err := json.Marshal(defaultUserSettings())
	if err != nil {
		t.Fatal(err)
	}
	var legacy map[string]any
	if err := json.Unmarshal(raw, &legacy); err != nil {
		t.Fatal(err)
	}
	legacy["language"] = "en-US"
	delete(legacy, "closeAction")
	settingsPath := filepath.Join(root, "user", "user-settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settingsPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if action := HostCloseAction(root); action != "ask" {
		t.Fatalf("legacy settings should ask before closing, got %q", action)
	}
	if language := HostLanguage(root); language != "en-US" {
		t.Fatalf("legacy settings lost their language, got %q", language)
	}

	if err := SetHostCloseAction(root, "tray"); err != nil {
		t.Fatalf("persist close action: %v", err)
	}
	value, err := readUserSettings(root)
	if err != nil {
		t.Fatalf("host write produced unreadable settings: %v", err)
	}
	if value.CloseAction != "tray" || value.Language != "en-US" ||
		value.Overlay.Width != defaultUserSettings().Overlay.Width ||
		value.GameMonitor.Mode != defaultUserSettings().GameMonitor.Mode {
		t.Fatalf("host write changed more than the close action: %+v", value)
	}

	// An unknown action is normalized instead of being written verbatim, and a corrupt file is
	// reported instead of being replaced by defaults: the dashboard owns repair, and the host falls
	// back to asking.
	if err := SetHostCloseAction(root, "restart"); err != nil {
		t.Fatal(err)
	}
	if action := HostCloseAction(root); action != "ask" {
		t.Fatalf("unknown close action was not normalized, got %q", action)
	}
	if err := os.WriteFile(settingsPath, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if action := HostCloseAction(root); action != "ask" {
		t.Fatalf("corrupt settings should ask before closing, got %q", action)
	}
	if err := SetHostCloseAction(root, "exit"); err == nil {
		t.Fatal("corrupt settings were overwritten instead of reported")
	}
	if data, err := os.ReadFile(settingsPath); err != nil || string(data) != "{" {
		t.Fatalf("corrupt settings were modified: %q %v", data, err)
	}
}
