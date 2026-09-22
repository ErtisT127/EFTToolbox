package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	contracts "efttoolbox/contracts"
)

func mapFixture(t *testing.T) (string, http.Handler) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "upstream", "modes", "pvp", "maps"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := contracts.MapData{SchemaVersion: 1, Id: "fixture", Name: "Fixture", DefaultFloor: "ground", Projection: contracts.Projection{ViewBox: []float64{0, 0, 100, 100}, Bounds: []contracts.Point{{X: 0, Y: 0}, {X: 100, Y: 100}}}, Floors: []contracts.Floor{{Id: "ground", Name: "Ground", SvgGroups: []string{"ground"}}}, Categories: []contracts.Category{}, Markers: []contracts.BuiltinMarker{}, Tasks: []contracts.MapTask{}, Warnings: []string{}}
	data, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(root, "upstream", "modes", "pvp", "maps", "fixture.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	return root, New(context.Background(), "test", http.FS(fstest.MapFS{}), root)
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
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestMapDiscoveryAndPersistence(t *testing.T) {
	root, handler := mapFixture(t)
	response := callJSON(t, handler, "GET", "/api/maps", nil)
	var maps []contracts.MapSummary
	if err := json.Unmarshal(response.Body.Bytes(), &maps); err != nil || len(maps) != 1 || maps[0].Id != "fixture" {
		t.Fatalf("map discovery: %s", response.Body.String())
	}
	initial := callJSON(t, handler, "GET", "/api/maps/fixture/annotations", nil)
	if initial.Code != 200 || !bytes.Contains(initial.Body.Bytes(), []byte(`"items":[]`)) {
		t.Fatal(initial.Body.String())
	}
	saved := contracts.Annotations{SchemaVersion: 1, Items: []contracts.Annotation{{Id: "user-mark", FloorId: "ground", Kind: "marker", Points: []contracts.Point{{X: 25, Y: 35}}, Color: "#5FD3C4", Width: 3, TextSize: 15, Text: "保留我的标记", Emoji: "📍"}}}
	if response := callJSON(t, handler, "PUT", "/api/maps/fixture/annotations", saved); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	restarted := New(context.Background(), "test", http.FS(fstest.MapFS{}), root)
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
	invalid := contracts.Annotations{SchemaVersion: 1, Items: []contracts.Annotation{{Id: "x", FloorId: "unknown", Kind: "marker", Points: []contracts.Point{{X: 0, Y: 0}}, Color: "#ffffff", Width: 3, TextSize: 15}}}
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

func TestCorruptDataAndSaveFailure(t *testing.T) {
	root, handler := mapFixture(t)
	if err := os.WriteFile(filepath.Join(root, "user"), []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}
	if response := callJSON(t, handler, "PUT", "/api/maps/fixture/annotations", contracts.Annotations{SchemaVersion: 1, Items: []contracts.Annotation{}}); response.Code != 500 {
		t.Fatalf("save failure hidden: %d", response.Code)
	}
	if err := os.WriteFile(filepath.Join(root, "upstream", "modes", "pvp", "maps", "broken.json"), []byte("{"), 0o644); err != nil {
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
