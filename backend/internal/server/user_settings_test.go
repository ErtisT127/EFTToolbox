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
