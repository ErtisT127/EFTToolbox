package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	defaults "efttoolbox/backend/internal/defaults"
	contracts "efttoolbox/contracts"
)

func TestVersionedMapPreferencesRequireCurrentRevision(t *testing.T) {
	_, handler := mapFixture(t)
	initial := callJSON(t, handler, http.MethodGet, "/api/map-preferences", nil)
	if initial.Code != http.StatusOK || initial.Header().Get("ETag") == "" || initial.Header().Get("X-Revision") == "" {
		t.Fatalf("GET did not return revision: %d %v", initial.Code, initial.Header())
	}

	var preferences contracts.Preferences
	if err := json.Unmarshal(initial.Body.Bytes(), &preferences); err != nil {
		t.Fatal(err)
	}
	preferences.SelectedMap = "fixture"
	request := httptest.NewRequest(http.MethodPut, "/api/map-preferences", jsonBody(t, preferences))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("If-Match", initial.Header().Get("ETag"))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("X-Revision") == initial.Header().Get("X-Revision") {
		t.Fatalf("conditional PUT failed: %d %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPut, "/api/map-preferences", jsonBody(t, preferences))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("If-Match", initial.Header().Get("ETag"))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("stale PUT returned %d: %s", response.Code, response.Body.String())
	}
}

func TestVersionedSettingsRejectStaleRevisions(t *testing.T) {
	_, handler := mapFixture(t)
	tests := []struct {
		getPath string
		putPath string
		change  func(any) any
		value   any
	}{
		{getPath: "/api/user-settings", putPath: "/api/user-settings", value: defaultUserSettings(), change: func(raw any) any { value := raw.(contracts.UserSettings); value.Language = "en-US"; return value }},
		{getPath: "/api/items-settings", putPath: "/api/items-settings", value: defaultItemsSettings(), change: func(raw any) any {
			value := raw.(contracts.ItemsSettings)
			value.Descending = !value.Descending
			return value
		}},
		{getPath: "/api/calibration-preferences", putPath: "/api/calibration-preferences", value: defaults.CalibratorPreferences(), change: func(raw any) any {
			value := raw.(contracts.CalibratorPreferences)
			value.SidebarCollapsed = !value.SidebarCollapsed
			return value
		}},
	}
	for _, test := range tests {
		initial := callJSON(t, handler, http.MethodGet, test.getPath, nil)
		if initial.Code != http.StatusOK || initial.Header().Get("ETag") == "" {
			t.Fatalf("%s GET missing ETag: %d %v", test.getPath, initial.Code, initial.Header())
		}
		body, err := json.Marshal(test.change(test.value))
		if err != nil {
			t.Fatal(err)
		}
		put := func() *httptest.ResponseRecorder {
			request := httptest.NewRequest(http.MethodPut, test.putPath, bytes.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("If-Match", initial.Header().Get("ETag"))
			request.RemoteAddr = "127.0.0.1:1234"
			request.Host = "localhost"
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			return response
		}
		if response := put(); response.Code != http.StatusOK {
			t.Fatalf("%s PUT failed: %d %s", test.putPath, response.Code, response.Body.String())
		}
		if response := put(); response.Code != http.StatusConflict {
			t.Fatalf("%s stale PUT returned %d: %s", test.putPath, response.Code, response.Body.String())
		}
	}
}

func TestUpdateUserSettingsConcurrentFields(t *testing.T) {
	root, handler := mapFixture(t)
	hub := &overlayHub{store: &mapStore{root: root, files: &VersionedFileStore{root: root}}}
	const writes = 3
	var wait sync.WaitGroup
	for i := 0; i < writes; i++ {
		wait.Add(1)
		go func(i int) {
			defer wait.Done()
			_, _, _, err := hub.UpdateUserSettings(func(value *contracts.UserSettings) error {
				switch i {
				case 0:
					value.Language = "en-US"
				case 1:
					value.Overlay.Left = 100
				case 2:
					value.Recognition.WindowLeft = 200
				}
				return nil
			})
			if err != nil {
				t.Errorf("update settings: %v", err)
			}
		}(i)
	}
	wait.Wait()
	response := callLocalJSON(t, handler, http.MethodGet, "/api/user-settings", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("settings GET failed: %d %s", response.Code, response.Body.String())
	}
	var value contracts.UserSettings
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil || value.Language != "en-US" || value.Overlay.Left != 100 || value.Recognition.WindowLeft != 200 {
		t.Fatalf("invalid final settings: %+v %v", value, err)
	}
}

func TestAnnotationsPutRejectsStaleETag(t *testing.T) {
	_, handler := mapFixture(t)
	initial := callJSON(t, handler, http.MethodGet, "/api/maps/fixture/annotations", nil)
	if initial.Code != http.StatusOK || initial.Header().Get("ETag") == "" {
		t.Fatalf("annotations GET did not return ETag: %d %v", initial.Code, initial.Header())
	}
	owner := multiplayerOwnerID(t, handler)
	first := contracts.Annotations{SchemaVersion: 1, Items: []contracts.Annotation{{
		Id: "marker-1", OwnerId: owner, FloorId: "ground", Kind: "marker",
		Points: []contracts.MapPoint{{X: 1, Y: 2}}, Color: "#ffffff", Width: 2, TextSize: 16,
	}}}
	updated := callJSON(t, handler, http.MethodPut, "/api/maps/fixture/annotations", first)
	if updated.Code != http.StatusOK {
		t.Fatalf("annotations PUT failed: %d %s", updated.Code, updated.Body.String())
	}
	stale := httptest.NewRequest(http.MethodPut, "/api/maps/fixture/annotations", jsonBody(t, contracts.Annotations{SchemaVersion: 1, Items: []contracts.Annotation{}}))
	stale.Header.Set("Content-Type", "application/json")
	stale.Header.Set("If-Match", initial.Header().Get("ETag"))
	stale.RemoteAddr = "127.0.0.1:1234"
	stale.Host = "localhost"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, stale)
	if response.Code != http.StatusConflict || !bytes.Contains(response.Body.Bytes(), []byte(`"code":"revision_conflict"`)) {
		t.Fatalf("stale annotations PUT returned %d: %s", response.Code, response.Body.String())
	}
}

func jsonBody(t *testing.T, value any) *bytes.Reader {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(data)
}
