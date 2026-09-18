package server

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	contracts "efttoolbox/contracts"
)

type tileTransport func(*http.Request) (*http.Response, error)

func (f tileTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestTileCacheAndValidation(t *testing.T) {
	root, handler := mapFixture(t)
	name := filepath.Join(root, "upstream", "maps", "fixture.json")
	var m contracts.MapData
	if err := readJSON(name, &m); err != nil {
		t.Fatal(err)
	}
	m.Tiles = []contracts.TileLayer{{Id: "base", FloorId: "ground", SourceUrl: "https://assets.tarkov.dev/maps/test/{z}/{x}/{y}.png", MinZoom: 1, MaxZoom: 2, TileSize: 256, Transform: []float64{1, 0, 1, 0}, Bounds: []contracts.Point{{X: 0, Y: 0}, {X: 256, Y: 256}}}}
	data, _ := json.Marshal(m)
	if err := os.WriteFile(name, data, 0o644); err != nil {
		t.Fatal(err)
	}
	var imageData bytes.Buffer
	if err := png.Encode(&imageData, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	previous := tileClient
	defer func() { tileClient = previous }()
	calls := 0
	tileClient = &http.Client{Transport: tileTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != "https://assets.tarkov.dev/maps/test/1/0/0.png" {
			t.Errorf("unexpected URL: %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(imageData.Bytes())), Header: make(http.Header)}, nil
	})}
	for i := 0; i < 2; i++ {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/map-tiles/fixture/base/1/0/0.png", nil))
		if response.Code != 200 || !bytes.Equal(response.Body.Bytes(), imageData.Bytes()) {
			t.Fatalf("tile response: %d %s", response.Code, response.Body)
		}
	}
	if calls != 1 {
		t.Fatalf("cached request used upstream: %d calls", calls)
	}
	for _, path := range []string{"base/0/0/0.png", "base/1/99/0.png", "base/1/a/0.png", "unknown/1/0/0.png"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/map-tiles/fixture/"+path, nil))
		if response.Code != 404 {
			t.Errorf("invalid tile %s: %d", path, response.Code)
		}
	}
	if calls != 1 {
		t.Fatal("invalid requests reached upstream")
	}
}
