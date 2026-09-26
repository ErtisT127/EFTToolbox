package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestAssetRouteValidation(t *testing.T) {
	root := t.TempDir()
	assets := filepath.Join(root, "upstream", "assets")
	files := map[string]string{
		"maps/svg/customs.svg":                             "<svg/>",
		"maps/icons/extract_pmcs.png":                      "png",
		"maps/icons/category-0123456789abcdef01234567.png": "category",
		"items/item-0123456789abcdef01234567.webp":         "item",
		"portraits/trader-0123456789abcdef01234567.webp":   "trader",
		"display/fonts/noto-sans-sc-400.woff2":             "font",
		"display-resources.json":                           "{}",
	}
	for file, content := range files {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(assets, file)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(assets, file), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	srv := httptest.NewServer(New(context.Background(), "test", http.FS(fstest.MapFS{}), root))
	defer srv.Close()

	for target, want := range map[string]struct {
		status int
		cache  string
		body   string
	}{
		"/api/assets/maps/svg/customs.svg":                                 {http.StatusOK, "no-cache", "<svg/>"},
		"/api/assets/maps/icons/extract_pmcs.png":                          {http.StatusOK, "no-cache", "png"},
		"/api/assets/maps/icons/category-0123456789abcdef01234567.png":     {http.StatusOK, "public, max-age=31536000, immutable", "category"},
		"/api/assets/items/item-0123456789abcdef01234567.webp":             {http.StatusOK, "public, max-age=31536000, immutable", "item"},
		"/api/assets/portraits/trader-0123456789abcdef01234567.webp":       {http.StatusOK, "public, max-age=31536000, immutable", "trader"},
		"/api/assets/display/fonts/noto-sans-sc-400.woff2":                 {http.StatusOK, "public, max-age=31536000, immutable", "font"},
		"/api/assets/display-resources.json":                               {http.StatusNotFound, "", ""},
		"/api/assets/tiles/manifest.json":                                  {http.StatusNotFound, "", ""},
		"/api/assets/portraits/unknown-0123456789abcdef01234567.webp":      {http.StatusNotFound, "", ""},
		"/api/assets/maps/svg/evil.html":                                   {http.StatusNotFound, "", ""},
		"/api/assets/maps/svg/not~safe.svg":                                {http.StatusNotFound, "", ""},
		"/api/assets/maps/%2e%2e/items/item-0123456789abcdef01234567.webp": {http.StatusNotFound, "", ""},
		"/api/assets/maps%5csvg/customs.svg":                               {http.StatusNotFound, "", ""},
		"/api/assets/../upstream/assets/maps/svg/customs.svg":              {http.StatusNotFound, "", ""},
	} {
		response, err := http.Get(srv.URL + target)
		if err != nil {
			t.Fatalf("%s: %v", target, err)
		}
		body, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if response.StatusCode != want.status {
			t.Errorf("%s: status %d, want %d (body %s)", target, response.StatusCode, want.status, body)
		}
		if got := response.Header.Get("Cache-Control"); got != want.cache {
			t.Errorf("%s: cache %q, want %q", target, got, want.cache)
		}
		if want.body != "" && string(body) != want.body {
			t.Errorf("%s: body %q, want %q", target, body, want.body)
		}
	}
}

func TestStickersAreSharedAcrossModes(t *testing.T) {
	root := t.TempDir()
	stickers := filepath.Join(root, "upstream", "stickers.json")
	payload := `[{"id":"mob:boss","name":"Boss","group":"boss","iconUrl":"/api/assets/portraits/mob-0123456789abcdef01234567.webp"}]`
	if err := os.MkdirAll(filepath.Dir(stickers), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stickers, []byte(payload), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(context.Background(), "test", http.FS(fstest.MapFS{}), root))
	defer srv.Close()
	response, err := http.Get(srv.URL + "/api/stickers")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	var entries []map[string]string
	if err := json.NewDecoder(response.Body).Decode(&entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0]["id"] != "mob:boss" {
		t.Fatalf("unexpected stickers: %#v", entries)
	}
}
