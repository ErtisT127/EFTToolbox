package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"

	contracts "efttoolbox/contracts"
)

var safeID = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// A sticker reference is `<kind>:<key>`, e.g. `mob:glukhar` or `key:5780d0652459777df90dcb74`.
// Only the shape is checked here, never whether the catalogue still carries the id: dropping an
// entry upstream must not make a map's saved annotations unsavable.
var stickerID = regexp.MustCompile(`^[a-z]+:[A-Za-z0-9_/-]{1,120}$`)

// PREFIX + 24 hex characters of content hash, as written by scripts/commands/data/item-images.mjs.
var contentHashed = regexp.MustCompile(`^(item|trader|mob)-[0-9a-f]{24}\.[a-z]+$`)

func hasContentHashName(name string) bool { return contentHashed.MatchString(name) }

type mapStore struct {
	root    string
	mu      sync.Mutex
	modeMu  sync.RWMutex
	mode    string
	changed func(string, string, string)
}

func (s *mapStore) setMode(mode string) {
	if mode != "pve" && mode != "pvp-season" {
		mode = "pvp"
	}
	s.modeMu.Lock()
	s.mode = mode
	s.modeMu.Unlock()
}

func (s *mapStore) activeUpstream() string {
	s.modeMu.RLock()
	mode := s.mode
	s.modeMu.RUnlock()
	if mode == "" {
		mode = "pvp"
	}
	modeRoot := filepath.Join(s.root, "upstream", "modes", mode)
	if info, err := os.Stat(filepath.Join(modeRoot, "maps")); err == nil && info.IsDir() {
		return modeRoot
	}
	// Keep existing generated PVP data usable until all mode datasets are present.
	return filepath.Join(s.root, "upstream")
}

func readJSON(name string, value any) error {
	data, err := os.ReadFile(name)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func (s *mapStore) load(id string) (contracts.MapData, error) {
	var data contracts.MapData
	if !safeID.MatchString(id) {
		return data, os.ErrNotExist
	}
	err := readJSON(filepath.Join(s.activeUpstream(), "maps", id+".json"), &data)
	if err != nil {
		return data, err
	}
	if data.SchemaVersion != 1 || data.Id != id || len(data.Floors) == 0 || len(data.Projection.ViewBox) != 4 || len(data.Projection.Bounds) != 2 {
		return data, fmt.Errorf("invalid map data: %s", id)
	}
	return data, nil
}

func jsonResponse(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(value)
}

func apiError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(contracts.ErrorBody{Code: code})
}

func dataError(w http.ResponseWriter, err error) {
	if errors.Is(err, os.ErrNotExist) {
		apiError(w, http.StatusNotFound, "map_not_found")
		return
	}
	log.Printf("map data: %v", err)
	apiError(w, http.StatusInternalServerError, "map_data_failed")
}

func decodeUpdate(w http.ResponseWriter, r *http.Request, value any) bool {
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host != r.Host {
			apiError(w, http.StatusForbidden, "origin_rejected")
			return false
		}
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		apiError(w, http.StatusUnsupportedMediaType, "json_expected")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		apiError(w, http.StatusBadRequest, "json_invalid")
		return false
	}
	if decoder.Decode(new(any)) != io.EOF {
		apiError(w, http.StatusBadRequest, "json_multiple")
		return false
	}
	return true
}

func (s *mapStore) save(name string, value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.root, "user")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".saving-*")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer func() { _ = os.Remove(temp) }()
	if _, err = file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(temp, filepath.Join(dir, name))
}

func validAnnotations(data contracts.Annotations, m contracts.MapData) bool {
	if data.SchemaVersion != 1 || data.Items == nil || len(data.Items) > 10000 {
		return false
	}
	ids := map[string]bool{}
	for _, a := range data.Items {
		if !safeID.MatchString(a.Id) || len(a.Id) > 100 || ids[a.Id] || !slices.ContainsFunc(m.Floors, func(f contracts.Floor) bool { return f.Id == a.FloorId }) {
			return false
		}
		ids[a.Id] = true
		if (a.Kind != "marker" && a.Kind != "stroke") || len(a.Points) == 0 || len(a.Points) > 20000 || (a.Kind == "marker" && len(a.Points) != 1) || !hexColor.MatchString(a.Color) || !finite(a.Width) || a.Width < 1 || a.Width > 20 || !finite(a.TextSize) || a.TextSize < 12 || a.TextSize > 48 || len(a.Text) > 2000 || len(a.Emoji) > 80 || (a.ImageId != "" && !stickerID.MatchString(a.ImageId)) {
			return false
		}
		for _, p := range a.Points {
			if !finite(p.X) || !finite(p.Y) || math.Abs(p.X) > 1e7 || math.Abs(p.Y) > 1e7 {
				return false
			}
		}
	}
	return true
}
func finite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }

func (s *mapStore) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/map-tiles/{map}/{layer}/{z}/{x}/{y}", s.tile)
	mux.HandleFunc("GET /api/stickers", func(w http.ResponseWriter, r *http.Request) {
		data := []contracts.Sticker{}
		err := readJSON(filepath.Join(s.activeUpstream(), "stickers.json"), &data)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			dataError(w, err)
			return
		}
		jsonResponse(w, data)
	})
	mux.HandleFunc("GET /api/maps", func(w http.ResponseWriter, r *http.Request) {
		files, err := os.ReadDir(filepath.Join(s.activeUpstream(), "maps"))
		if err != nil {
			dataError(w, err)
			return
		}
		summaries := []contracts.MapSummary{}
		// The catalog supplies data-defined ordering; newly added map files are discovered too.
		var order []contracts.MapSummary
		_ = readJSON(filepath.Join(s.activeUpstream(), "catalog.json"), &order)
		for _, file := range files {
			if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
				continue
			}
			id := strings.TrimSuffix(file.Name(), ".json")
			m, err := s.load(id)
			if err != nil {
				log.Printf("skip map %s: %v", id, err)
				continue
			}
			summaries = append(summaries, contracts.MapSummary{Id: m.Id, Name: m.Name, Subtitle: m.Subtitle, IconUrl: m.IconUrl, DefaultFloor: m.DefaultFloor})
		}
		rank := func(id string) int {
			for i, m := range order {
				if m.Id == id {
					return i
				}
			}
			return len(order)
		}
		slices.SortStableFunc(summaries, func(a, b contracts.MapSummary) int { return rank(a.Id) - rank(b.Id) })
		jsonResponse(w, summaries)
	})
	mux.HandleFunc("GET /api/maps/{id}", func(w http.ResponseWriter, r *http.Request) {
		m, err := s.load(r.PathValue("id"))
		if err != nil {
			dataError(w, err)
			return
		}
		jsonResponse(w, m)
	})
	mux.HandleFunc("GET /api/map-assets/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		ext := filepath.Ext(name)
		if filepath.Base(name) != name || !safeID.MatchString(strings.TrimSuffix(name, ext)) || (ext != ".svg" && ext != ".png" && ext != ".webp" && ext != ".jpg" && ext != ".woff2") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// The downloaded images are named after a hash of their own bytes, so a given name can
		// never describe different content. Map SVGs are not: a refresh replaces them in place
		// under a stable name, so those still have to be revalidated.
		if hasContentHashName(name) {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		http.ServeFile(w, r, filepath.Join(s.root, "upstream", "assets", name))
	})
	mux.HandleFunc("GET /api/maps/{id}/annotations", func(w http.ResponseWriter, r *http.Request) {
		m, err := s.load(r.PathValue("id"))
		if err != nil {
			dataError(w, err)
			return
		}
		data := contracts.Annotations{SchemaVersion: 1, Items: []contracts.Annotation{}}
		err = readJSON(filepath.Join(s.root, "user", m.Id+".annotations.json"), &data)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			dataError(w, err)
			return
		}
		if !validAnnotations(data, m) {
			dataError(w, errors.New("invalid saved annotations"))
			return
		}
		jsonResponse(w, data)
	})
	mux.HandleFunc("PUT /api/maps/{id}/annotations", func(w http.ResponseWriter, r *http.Request) {
		m, err := s.load(r.PathValue("id"))
		if err != nil {
			dataError(w, err)
			return
		}
		var data contracts.Annotations
		if !decodeUpdate(w, r, &data) {
			return
		}
		if !validAnnotations(data, m) {
			apiError(w, http.StatusBadRequest, "annotations_invalid")
			return
		}
		if err = s.save(m.Id+".annotations.json", data); err != nil {
			log.Printf("save annotations: %v", err)
			apiError(w, http.StatusInternalServerError, "annotations_save_failed")
			return
		}
		if s.changed != nil {
			s.changed("annotations_changed", m.Id, r.Header.Get("X-Operation-ID"))
		}
		jsonResponse(w, data)
	})
	mux.HandleFunc("GET /api/map-preferences", func(w http.ResponseWriter, r *http.Request) {
		data := contracts.Preferences{
			SchemaVersion: 1,
			Maps:          []contracts.MapPreference{},
			StickerUsage:  []contracts.StickerUsage{},
		}
		err := readJSON(filepath.Join(s.root, "user", "map-preferences.json"), &data)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			dataError(w, err)
			return
		}
		jsonResponse(w, data)
	})
	mux.HandleFunc("PUT /api/map-preferences", func(w http.ResponseWriter, r *http.Request) {
		var data contracts.Preferences
		if !decodeUpdate(w, r, &data) {
			return
		}
		if data.SchemaVersion != 1 || data.Maps == nil || len(data.Maps) > 1000 || data.StickerUsage == nil || len(data.StickerUsage) > 1000 {
			apiError(w, http.StatusBadRequest, "preferences_invalid")
			return
		}
		if data.SelectedMap != "" {
			if _, err := s.load(data.SelectedMap); err != nil {
				apiError(w, http.StatusBadRequest, "map_unknown")
				return
			}
		}
		for _, p := range data.Maps {
			if !safeID.MatchString(p.MapId) || !finite(p.Zoom) || p.Zoom < -10 || p.Zoom > 10 || (len(p.Center) != 0 && len(p.Center) != 2) || len(p.HiddenCategories) > 1000 || len(p.CollapsedGroups) > 1000 || len(p.SelectedTasks) > 1000 {
				apiError(w, http.StatusBadRequest, "preferences_invalid")
				return
			}
			for _, v := range p.Center {
				if !finite(v) || math.Abs(v) > 1e7 {
					apiError(w, http.StatusBadRequest, "center_invalid")
					return
				}
			}
		}
		if err := s.save("map-preferences.json", data); err != nil {
			log.Printf("save preferences: %v", err)
			apiError(w, http.StatusInternalServerError, "preferences_save_failed")
			return
		}
		if s.changed != nil {
			s.changed("preferences_changed", data.SelectedMap, r.Header.Get("X-Operation-ID"))
		}
		jsonResponse(w, data)
	})
}
