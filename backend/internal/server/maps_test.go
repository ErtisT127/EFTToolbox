package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"testing/fstest"
	"time"

	defaults "efttoolbox/backend/internal/defaults"
	contracts "efttoolbox/contracts"
)

// mapFixtureWithBlockedUser blocks the user directory by writing a FILE over its path before the
// handler starts, simulating an unwritable data root for save-failure paths.
func mapFixtureWithBlockedUser(t *testing.T) (string, http.Handler) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "upstream", "modes", "pvp", "maps"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := contracts.MapData{SchemaVersion: 1, Id: "fixture", Name: "Fixture", DefaultFloor: "ground", Projection: contracts.Projection{ViewBox: []float64{0, 0, 100, 100}, Bounds: []contracts.WorldXZ{{X: 0, Z: 0}, {X: 100, Z: 100}}}, Floors: []contracts.Floor{{Id: "ground", Name: "Ground", SvgGroups: []string{"ground"}}}, Categories: []contracts.Category{}, Markers: []contracts.BuiltinMarker{}, Tasks: []contracts.MapTask{}, Warnings: []string{}}
	data, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(root, "upstream", "modes", "pvp", "maps", "fixture_zh.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "user"), []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root, testServer(t, root)
}

func mapFixture(t *testing.T) (string, http.Handler) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "upstream", "modes", "pvp", "maps"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := contracts.MapData{SchemaVersion: 1, Id: "fixture", Name: "Fixture", DefaultFloor: "ground", Projection: contracts.Projection{ViewBox: []float64{0, 0, 100, 100}, Bounds: []contracts.WorldXZ{{X: 0, Z: 0}, {X: 100, Z: 100}}}, Floors: []contracts.Floor{{Id: "ground", Name: "Ground", SvgGroups: []string{"ground"}}}, Categories: []contracts.Category{}, Markers: []contracts.BuiltinMarker{}, Tasks: []contracts.MapTask{}, Warnings: []string{}}
	data, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(root, "upstream", "modes", "pvp", "maps", "fixture_zh.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	// The English twin must not double the catalog entry: discovery is keyed by map id.
	en := m
	en.Name = "Fixture EN"
	dataEn, _ := json.Marshal(en)
	if err := os.WriteFile(filepath.Join(root, "upstream", "modes", "pvp", "maps", "fixture_en.json"), dataEn, 0o644); err != nil {
		t.Fatal(err)
	}
	return root, testServer(t, root)
}

func testServer(t *testing.T, root string) http.Handler {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	handler := New(ctx, "test", http.FS(fstest.MapFS{}), root)
	t.Cleanup(func() {
		cancel()
		time.Sleep(50 * time.Millisecond)
	})
	return handler
}

func callJSON(t *testing.T, handler http.Handler, method, path string, value any) *httptest.ResponseRecorder {
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
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:1234"
	request.Host = "localhost"
	if method == http.MethodPut || path == "/api/data/reset-user-settings" {
		getPath := path
		if path == "/api/data/reset-user-settings" {
			getPath = "/api/user-settings"
		}
		get := httptest.NewRequest(http.MethodGet, getPath, nil)
		get.RemoteAddr, get.Host = request.RemoteAddr, request.Host
		current := httptest.NewRecorder()
		handler.ServeHTTP(current, get)
		tag := current.Header().Get("ETag")
		if tag == "" {
			tag = `"invalid"`
		}
		request.Header.Set("If-Match", tag)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

// multiplayerOwnerID returns the derived peer id the annotations PUT path treats as the local
// owner; items stamped with it survive the merge, everything else comes from the sync cache.
func multiplayerOwnerID(t *testing.T, handler http.Handler) string {
	t.Helper()
	request := httptest.NewRequest("GET", "/api/multiplayer/settings", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.Host = "localhost"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("multiplayer settings: %s", response.Body.String())
	}
	var settings contracts.MultiplayerSettings
	if err := json.Unmarshal(response.Body.Bytes(), &settings); err != nil || settings.PlayerId == "" {
		t.Fatalf("multiplayer settings: %s", response.Body.String())
	}
	return settings.PlayerId
}

func TestMapDiscoveryAndPersistence(t *testing.T) {
	root, handler := mapFixture(t)
	owner := multiplayerOwnerID(t, handler)
	response := callJSON(t, handler, "GET", "/api/maps", nil)
	var maps []contracts.MapSummary
	if err := json.Unmarshal(response.Body.Bytes(), &maps); err != nil || len(maps) != 1 || maps[0].Id != "fixture" {
		t.Fatalf("map discovery: %s", response.Body.String())
	}
	// The language pair must not double the entry, and the English locale resolves English names.
	if localized := callJSON(t, handler, "GET", "/api/maps?locale=en-US", nil); localized.Code != 200 ||
		bytes.Count(localized.Body.Bytes(), []byte(`"id":"fixture"`)) != 1 ||
		!bytes.Contains(localized.Body.Bytes(), []byte("Fixture EN")) {
		t.Fatalf("english discovery: %s", localized.Body.String())
	}
	if localized := callJSON(t, handler, "GET", "/api/maps/fixture?locale=en-US", nil); localized.Code != 200 ||
		!bytes.Contains(localized.Body.Bytes(), []byte("Fixture EN")) {
		t.Fatalf("english map data: %s", localized.Body.String())
	}
	initial := callJSON(t, handler, "GET", "/api/maps/fixture/annotations", nil)
	if initial.Code != 200 || !bytes.Contains(initial.Body.Bytes(), []byte(`"items":[]`)) {
		t.Fatal(initial.Body.String())
	}
	saved := contracts.Annotations{SchemaVersion: 1, Items: []contracts.Annotation{{Id: "user-mark", OwnerId: owner, FloorId: "ground", Kind: "marker", Points: []contracts.MapPoint{{X: 25, Y: 35}}, Color: "#5FD3C4", Width: 3, TextSize: 15, Text: "淇濈暀鎴戠殑鏍囪", Emoji: "馃搷"}}}
	if response := callJSON(t, handler, "PUT", "/api/maps/fixture/annotations", saved); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	restarted := testServer(t, root)
	response = callJSON(t, restarted, "GET", "/api/maps/fixture/annotations", nil)
	var actual contracts.Annotations
	if err := json.Unmarshal(response.Body.Bytes(), &actual); err != nil || len(actual.Items) != 1 || actual.Items[0].Text != saved.Items[0].Text {
		t.Fatalf("restart lost data: %s", response.Body.String())
	}
	saved.Items[0].Text = "Updated"
	if response := callJSON(t, restarted, "PUT", "/api/maps/fixture/annotations", saved); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	files, err := os.ReadDir(filepath.Join(root, "user", "modes", "pvp", "maps"))
	if err != nil || len(files) != 1 {
		t.Fatalf("temporary files leaked: %v %v", files, err)
	}
}

func TestInvalidAnnotationCannotOverwriteSavedData(t *testing.T) {
	root, handler := mapFixture(t)
	valid := contracts.Annotations{SchemaVersion: 1, Items: []contracts.Annotation{}}
	if response := callJSON(t, handler, "PUT", "/api/maps/fixture/annotations", valid); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	before, err := os.ReadFile(filepath.Join(root, "user", "modes", "pvp", "maps", "fixture.annotations.json"))
	if err != nil {
		t.Fatal(err)
	}
	invalid := contracts.Annotations{SchemaVersion: 1, Items: []contracts.Annotation{{Id: "x", FloorId: "unknown", Kind: "marker", Points: []contracts.MapPoint{{X: 0, Y: 0}}, Color: "#ffffff", Width: 3, TextSize: 15}}}
	if response := callJSON(t, handler, "PUT", "/api/maps/fixture/annotations", invalid); response.Code != 400 {
		t.Fatalf("accepted unknown floor: %d", response.Code)
	}
	after, err := os.ReadFile(filepath.Join(root, "user", "modes", "pvp", "maps", "fixture.annotations.json"))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("invalid write changed saved data")
	}
	request := httptest.NewRequest("PUT", "/api/maps/fixture/annotations", bytes.NewBufferString(`{"schemaVersion":1,"items":[]}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://foreign.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatalf("foreign origin accepted: %d", response.Code)
	}
	if response := callJSON(t, handler, "GET", "/api/maps/does-not-exist", nil); response.Code != 404 {
		t.Fatalf("missing map: %d", response.Code)
	}
}

func TestCorruptCalibrationReturnsCalibrationError(t *testing.T) {
	root, handler := mapFixture(t)
	path := filepath.Join(root, "user", "calibration", "maps.calibration.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	response := callJSON(t, handler, "GET", "/api/maps/fixture/calibration?basemap=svg", nil)
	if response.Code != http.StatusInternalServerError || !bytes.Contains(response.Body.Bytes(), []byte(`"code":"calibration_invalid"`)) {
		t.Fatalf("corrupt calibration was not classified correctly: %d %s", response.Code, response.Body.String())
	}
}

func TestInvalidCalibrationDocumentSetReturnsCalibrationError(t *testing.T) {
	root, handler := mapFixture(t)
	path := filepath.Join(root, "user", "calibration", "maps.calibration.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	invalid := contracts.CalibrationDocuments{
		SchemaVersion: 1,
		Maps: []contracts.CalibrationDocument{
			{SchemaVersion: 1, MapId: "fixture", Basemap: "svg", Revision: 0, NextRegionNumber: 1},
			{SchemaVersion: 1, MapId: "fixture", Basemap: "svg", Revision: 0, NextRegionNumber: 1},
		},
	}
	data, err := json.Marshal(invalid)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	response := callJSON(t, handler, "GET", "/api/maps/fixture/calibration?basemap=svg", nil)
	if response.Code != http.StatusInternalServerError || !bytes.Contains(response.Body.Bytes(), []byte(`"code":"calibration_invalid"`)) {
		t.Fatalf("invalid calibration set was accepted: %d %s", response.Code, response.Body.String())
	}
}

func TestCalibrationRegionDeletionPersistsEmptyDocument(t *testing.T) {
	_, handler := mapFixture(t)
	withRegion := contracts.CalibrationDocument{
		SchemaVersion:    1,
		MapId:            "fixture",
		Basemap:          "svg",
		Revision:         0,
		NextRegionNumber: 2,
		Regions: []contracts.CalibrationRegion{{
			Id:      "region-1",
			FloorId: "ground",
			Name:    "Region 1",
			Rectangle: contracts.WorldRectXZ{
				MinX: 0,
				MaxX: 10,
				MinZ: 0,
				MaxZ: 10,
			},
			YRange:   contracts.YRange{Min: 0, Max: 10},
			Priority: 1,
		}},
	}
	if response := callJSON(t, handler, "PUT", "/api/maps/fixture/calibration?basemap=svg", withRegion); response.Code != http.StatusOK {
		t.Fatalf("save region: %d %s", response.Code, response.Body.String())
	}

	deleted := withRegion
	deleted.Revision = 1
	deleted.Regions = []contracts.CalibrationRegion{}
	response := callJSON(t, handler, "PUT", "/api/maps/fixture/calibration?basemap=svg", deleted)
	if response.Code != http.StatusOK {
		t.Fatalf("delete region: %d %s", response.Code, response.Body.String())
	}
	var saved contracts.CalibrationDocument
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 2 || len(saved.Regions) != 0 {
		t.Fatalf("deleted document: %+v", saved)
	}

	response = callJSON(t, handler, "GET", "/api/maps/fixture/calibration?basemap=svg", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("read deleted document: %d %s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 2 || len(saved.Regions) != 0 {
		t.Fatalf("persisted deleted document: %+v", saved)
	}

	stale := deleted
	stale.Revision = 1
	stale.NextRegionNumber = 3
	response = callJSON(t, handler, "PUT", "/api/maps/fixture/calibration?basemap=svg", stale)
	if response.Code != http.StatusConflict {
		t.Fatalf("stale deletion accepted: %d %s", response.Code, response.Body.String())
	}
	response = callJSON(t, handler, "GET", "/api/maps/fixture/calibration?basemap=svg", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("read after stale deletion: %d %s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 2 || len(saved.Regions) != 0 {
		t.Fatalf("stale deletion changed saved document: %+v", saved)
	}
}

func TestCalibrationDocumentRequiresCurrentETag(t *testing.T) {
	_, handler := mapFixture(t)
	path := "/api/maps/fixture/calibration?basemap=svg"
	request := func(method string, document *contracts.CalibrationDocument, etag string) *httptest.ResponseRecorder {
		var body []byte
		if document != nil {
			var err error
			body, err = json.Marshal(document)
			if err != nil {
				t.Fatal(err)
			}
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if etag != "" {
			req.Header.Set("If-Match", etag)
		}
		req.RemoteAddr = "127.0.0.1:1234"
		req.Host = "localhost"
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}

	initial := request(http.MethodGet, nil, "")
	if initial.Code != http.StatusOK || initial.Header().Get("ETag") == "" || initial.Header().Get("X-Revision") == "" {
		t.Fatalf("GET did not return revision: %d %v", initial.Code, initial.Header())
	}
	var document contracts.CalibrationDocument
	if err := json.Unmarshal(initial.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}

	withoutRevision := request(http.MethodPut, &document, "")
	if withoutRevision.Code != http.StatusPreconditionRequired {
		t.Fatalf("PUT without revision returned %d: %s", withoutRevision.Code, withoutRevision.Body.String())
	}

	document.NextRegionNumber++
	saved := request(http.MethodPut, &document, initial.Header().Get("ETag"))
	if saved.Code != http.StatusOK || saved.Header().Get("X-Revision") == initial.Header().Get("X-Revision") || saved.Header().Get("ETag") == "" {
		t.Fatalf("conditional PUT failed or omitted new revision: %d %v %s", saved.Code, saved.Header(), saved.Body.String())
	}
	var persisted contracts.CalibrationDocument
	if err := json.Unmarshal(saved.Body.Bytes(), &persisted); err != nil {
		t.Fatal(err)
	}
	stale := request(http.MethodPut, &persisted, initial.Header().Get("ETag"))
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale ETag PUT returned %d: %s", stale.Code, stale.Body.String())
	}

	after := request(http.MethodGet, nil, "")
	var actual contracts.CalibrationDocument
	if after.Code != http.StatusOK || json.Unmarshal(after.Body.Bytes(), &actual) != nil || actual.Revision != persisted.Revision || actual.NextRegionNumber != persisted.NextRegionNumber || after.Header().Get("X-Revision") != saved.Header().Get("X-Revision") {
		t.Fatalf("stale PUT changed persisted document: %d %s", after.Code, after.Body.String())
	}
}

func TestCalibrationDocumentsAreIsolatedByBasemap(t *testing.T) {
	_, handler := mapFixture(t)
	document := func(basemap, id string) contracts.CalibrationDocument {
		return contracts.CalibrationDocument{
			SchemaVersion: 1, MapId: "fixture", Basemap: basemap, NextRegionNumber: 2,
			Regions: []contracts.CalibrationRegion{{
				Id: id, FloorId: "ground", Name: id,
				Rectangle: contracts.WorldRectXZ{MinX: 0, MaxX: 10, MinZ: 0, MaxZ: 10},
				YRange:    contracts.YRange{Min: 0, Max: 10}, Priority: 1,
			}},
		}
	}
	for _, value := range []struct {
		basemap string
		id      string
	}{
		{"svg", "svg-region"},
		{"tiles", "tiles-region"},
	} {
		if response := callJSON(t, handler, "PUT", "/api/maps/fixture/calibration?basemap="+value.basemap, document(value.basemap, value.id)); response.Code != http.StatusOK {
			t.Fatalf("save %s: %d %s", value.basemap, response.Code, response.Body.String())
		}
	}
	for _, value := range []struct {
		basemap string
		id      string
	}{
		{"svg", "svg-region"},
		{"tiles", "tiles-region"},
	} {
		response := callJSON(t, handler, "GET", "/api/maps/fixture/calibration?basemap="+value.basemap, nil)
		var actual contracts.CalibrationDocument
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &actual) != nil || actual.Basemap != value.basemap || len(actual.Regions) != 1 || actual.Regions[0].Id != value.id || actual.Revision != 1 {
			t.Fatalf("read %s: %d %s", value.basemap, response.Code, response.Body.String())
		}
	}
	if response := callJSON(t, handler, "GET", "/api/maps/fixture/calibration", nil); response.Code != http.StatusBadRequest {
		t.Fatalf("missing basemap accepted: %d", response.Code)
	}
}

func TestCorruptCalibrationPreferencesReturnsCalibrationError(t *testing.T) {
	root, handler := mapFixture(t)
	path := filepath.Join(root, "user", "calibration", "calibration-preferences.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	response := callJSON(t, handler, "GET", "/api/calibration-preferences", nil)
	if response.Code != http.StatusInternalServerError || !bytes.Contains(response.Body.Bytes(), []byte(`"code":"calibration_preferences_invalid"`)) {
		t.Fatalf("corrupt calibration preferences were not classified correctly: %d %s", response.Code, response.Body.String())
	}
}

func TestCalibrationResetRestoresDefaultsAndPreservesOtherUserData(t *testing.T) {
	root, handler := mapFixture(t)
	files := map[string]string{
		filepath.Join(root, "user", "calibration", "maps.calibration.json"):             `{ "schemaVersion": 1, "maps": [] }`,
		filepath.Join(root, "user", "calibration", "calibration-preferences.json"):      `{ "schemaVersion": 1, "sidebarCollapsed": false, "collapsedMaps": [], "collapsedFloors": [] }`,
		filepath.Join(root, "user", "maps", "keep.txt"):                                 "keep",
		filepath.Join(root, "user", "modes", "pvp", "map-preferences.json"):             "preferences",
		filepath.Join(root, "user", "modes", "pvp", "maps", "fixture.annotations.json"): "annotations",
		filepath.Join(root, "user", "user-settings.json"):                               "settings",
	}
	for path, value := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	request := httptest.NewRequest("POST", "/api/data/reset-calibration", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.Host = "localhost"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("calibration reset failed: %d %s", response.Code, response.Body.String())
	}
	var documents contracts.CalibrationDocuments
	if err := readJSON(filepath.Join(root, "user", "calibration", "maps.calibration.json"), &documents); err != nil || !reflect.DeepEqual(documents, defaults.CalibrationDocuments()) {
		t.Fatalf("calibration documents were not restored to defaults: %+v %v", documents, err)
	}
	var preferences contracts.CalibratorPreferences
	if err := readJSON(filepath.Join(root, "user", "calibration", "calibration-preferences.json"), &preferences); err != nil || preferences.SchemaVersion != 1 || preferences.CollapsedMaps == nil || preferences.CollapsedFloors == nil {
		t.Fatalf("calibration preferences were not restored to defaults: %+v %v", preferences, err)
	}
	for _, path := range []string{
		filepath.Join(root, "user", "maps", "keep.txt"),
		filepath.Join(root, "user", "modes", "pvp", "map-preferences.json"),
		filepath.Join(root, "user", "modes", "pvp", "maps", "fixture.annotations.json"),
		filepath.Join(root, "user", "user-settings.json"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("reset removed unrelated user data %s: %v", path, err)
		}
	}
}

func TestCorruptDataAndSaveFailure(t *testing.T) {
	root, handler := mapFixtureWithBlockedUser(t)

	if response := callJSON(t, handler, "PUT", "/api/maps/fixture/annotations", contracts.Annotations{SchemaVersion: 1, Items: []contracts.Annotation{}}); response.Code != 500 {
		t.Fatalf("save failure hidden: %d", response.Code)
	}
	if err := os.WriteFile(filepath.Join(root, "upstream", "modes", "pvp", "maps", "broken_zh.json"), []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if response := callJSON(t, handler, "GET", "/api/maps/broken", nil); response.Code != 500 {
		t.Fatalf("corrupt map hidden: %d", response.Code)
	}
	response := callJSON(t, handler, "GET", "/api/maps", nil)
	if response.Code != 200 || !bytes.Contains(response.Body.Bytes(), []byte("fixture")) {
		t.Fatal("one broken map prevented valid map discovery")
	}
}
