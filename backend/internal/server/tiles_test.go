package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	contracts "efttoolbox/contracts"
)

func TestTileCacheAndValidation(t *testing.T) {
	root, handler := mapFixture(t)
	name := filepath.Join(root, "upstream", "modes", "pvp", "maps", "fixture.json")
	var m contracts.MapData
	if err := readJSON(name, &m); err != nil {
		t.Fatal(err)
	}
	m.Tiles = []contracts.TileLayer{{Id: "base", FloorId: "ground", SourceUrl: "https://assets.tarkov.dev/maps/test/{z}/{x}/{y}.png", MinZoom: 1, MaxZoom: 2, TileSize: 256, Transform: []float64{1, 0, 1, 0}, Bounds: []contracts.MapPoint{{X: 0, Y: 0}, {X: 256, Y: 256}}}}
	data, _ := json.Marshal(m)
	if err := os.WriteFile(name, data, 0o644); err != nil {
		t.Fatal(err)
	}
	var imageData bytes.Buffer
	if err := png.Encode(&imageData, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	source := "https://assets.tarkov.dev/maps/test/1/0/0.png"
	key := sha256.Sum256([]byte(source))
	tilePath := filepath.Join(root, "upstream", "tiles", hex.EncodeToString(key[:])[:2], hex.EncodeToString(key[:])+".png")
	if err := os.MkdirAll(filepath.Dir(tilePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tilePath, imageData.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/map-tiles/fixture/base/1/0/0.png", nil))
		if response.Code != 200 || !bytes.Equal(response.Body.Bytes(), imageData.Bytes()) {
			t.Fatalf("tile response: %d %s", response.Code, response.Body)
		}
	}
	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, httptest.NewRequest("GET", "/api/map-tiles/fixture/base/1/1/0.png", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing tile: %d %s", missing.Code, missing.Body)
	}
	for _, path := range []string{"base/0/0/0.png", "base/1/99/0.png", "base/1/a/0.png", "unknown/1/0/0.png"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/map-tiles/fixture/"+path, nil))
		if response.Code != 404 {
			t.Errorf("invalid tile %s: %d", path, response.Code)
		}
	}
}
