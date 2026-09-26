package server

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"

	"efttoolbox/backend/internal/gamewatch"
	"efttoolbox/backend/internal/mapper"
	contracts "efttoolbox/contracts"
)

var safeID = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// A sticker reference is `<kind>:<key>`, e.g. `mob:glukhar` or `key:5780d0652459777df90dcb74`.
// Only the shape is checked here, never whether the catalogue still carries the id: dropping an
// entry upstream must not make a map's saved annotations unsavable.
var stickerID = regexp.MustCompile(`^[a-z]+:[A-Za-z0-9_/-]{1,120}$`)

// PREFIX + 24 hex characters of content hash, as written by scripts/lib/item-pull.mjs.
var contentHashed = regexp.MustCompile(`^(item|trader|mob|category)-[0-9a-f]{24}\.[a-z]+$`)

func hasContentHashName(name string) bool { return contentHashed.MatchString(name) }

// Top-level asset namespaces and extensions served by /api/assets; kept in step with the
// directory layout written by scripts/commands/data.
var assetNamespaces = map[string]bool{"display": true, "maps": true, "items": true, "portraits": true}
var assetExtensions = map[string]bool{".svg": true, ".png": true, ".webp": true, ".jpg": true, ".woff2": true}

type mapStore struct {
	root             string
	mu               sync.Mutex
	calibrationMu    sync.Mutex
	modeMu           sync.RWMutex
	repo             *modeRepository
	changed          func(string, string, string)
	calibrationReset func()
}

type modeRepository struct {
	mode string
	root string
}

func (s *mapStore) repository() *modeRepository {
	s.modeMu.RLock()
	defer s.modeMu.RUnlock()
	return s.repo
}

func (s *mapStore) setRepository(repo *modeRepository) {
	s.modeMu.Lock()
	s.repo = repo
	s.modeMu.Unlock()
}

func newModeRepository(root, mode string) (*modeRepository, error) {
	if !gamewatch.ValidMode(gamewatch.Mode(mode)) {
		return nil, fmt.Errorf("invalid mode: %s", mode)
	}
	modeRoot := filepath.Join(root, "upstream", "modes", mode)
	info, err := os.Stat(filepath.Join(modeRoot, "maps"))
	if err != nil || !info.IsDir() {
		if err == nil {
			err = errors.New("not a directory")
		}
		return nil, fmt.Errorf("mode %q maps directory unavailable: %w", mode, err)
	}
	entries, err := os.ReadDir(filepath.Join(modeRoot, "maps"))
	if err != nil {
		return nil, fmt.Errorf("mode %q maps directory unreadable: %w", mode, err)
	}
	repo := &modeRepository{mode: mode, root: modeRoot}
	validMaps := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if _, err := (&mapStore{}).loadFromRepository(id, repo); err != nil {
			return nil, fmt.Errorf("mode %q map %q invalid: %w", mode, id, err)
		}
		validMaps++
	}
	if validMaps == 0 {
		return nil, fmt.Errorf("mode %q contains no maps", mode)
	}
	return repo, nil
}

func (s *mapStore) loadFromRepository(id string, repo *modeRepository) (contracts.MapData, error) {
	var data contracts.MapData
	if !safeID.MatchString(id) {
		return data, os.ErrNotExist
	}
	if repo == nil {
		return data, errors.New("mode repository unavailable")
	}
	if err := readJSON(filepath.Join(repo.root, "maps", id+".json"), &data); err != nil {
		return data, err
	}
	if data.SchemaVersion != 1 || data.Id != id || len(data.Floors) == 0 || len(data.Projection.ViewBox) != 4 || len(data.Projection.Bounds) != 2 {
		return data, fmt.Errorf("invalid map data: %s", id)
	}
	return data, nil
}

func (s *mapStore) loadFromMode(id, mode string) (contracts.MapData, error) {
	repo, err := newModeRepository(s.root, mode)
	if err != nil {
		return contracts.MapData{}, err
	}
	return s.loadFromRepository(id, repo)
}

func readJSON(name string, value any) error {
	data, err := os.ReadFile(name)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func (s *mapStore) load(id string) (contracts.MapData, error) {
	return s.loadFromRepository(id, s.repository())
}

func (s *mapStore) activeUpstream() string {
	if repo := s.repository(); repo != nil {
		return repo.root
	}
	return filepath.Join(s.root, "upstream", "modes", "invalid")
}

func (s *mapStore) userRoot() string {
	if repo := s.repository(); repo != nil {
		return filepath.Join(s.root, "user", "modes", repo.mode)
	}
	return filepath.Join(s.root, "user", "modes", "invalid")
}

func (s *mapStore) userPath(name string) string { return filepath.Join(s.userRoot(), name) }

func (s *mapStore) calibrationRoot() string {
	return filepath.Join(s.root, "user", "calibration")
}

func (s *mapStore) calibrationPreferencesPath() string {
	return filepath.Join(s.calibrationRoot(), "calibration-preferences.json")
}

func (s *mapStore) calibrationDocumentsPath() string {
	return filepath.Join(s.calibrationRoot(), "maps.calibration.json")
}

func validBasemap(value string) bool { return value == "svg" || value == "tiles" }

func emptyCalibrationDocument(mapID, basemap string) contracts.CalibrationDocument {
	return contracts.CalibrationDocument{
		SchemaVersion:    1,
		MapId:            mapID,
		Basemap:          basemap,
		Revision:         0,
		NextRegionNumber: 1,
		Regions:          []contracts.CalibrationRegion{},
	}
}

func emptyCalibrationDocuments() contracts.CalibrationDocuments {
	return contracts.CalibrationDocuments{SchemaVersion: 1, Maps: []contracts.CalibrationDocument{}}
}

func normalizeMapPreferences(data *contracts.Preferences) {
	if data.Maps == nil {
		data.Maps = []contracts.MapPreference{}
	}
	if data.StickerUsage == nil {
		data.StickerUsage = []contracts.StickerUsage{}
	}
	for i := range data.Maps {
		preference := &data.Maps[i]
		if preference.HiddenCategories == nil {
			preference.HiddenCategories = []string{}
		}
		if preference.CollapsedGroups == nil {
			preference.CollapsedGroups = []string{}
		}
		if preference.SelectedTasks == nil {
			preference.SelectedTasks = []string{}
		}
		if preference.Center == nil {
			preference.Center = []float64{}
		}
	}
}

func validCalibrationDocuments(data contracts.CalibrationDocuments) bool {
	if data.SchemaVersion != 1 || data.Maps == nil || len(data.Maps) > 2000 {
		return false
	}
	ids := map[string]bool{}
	for _, doc := range data.Maps {
		key := doc.MapId + ":" + doc.Basemap
		if !safeID.MatchString(doc.MapId) || len(doc.MapId) > 100 || !validBasemap(doc.Basemap) || ids[key] || doc.SchemaVersion != 1 || doc.Revision < 0 || doc.NextRegionNumber < 1 || len(doc.Regions) > 10000 {
			return false
		}
		ids[key] = true
	}
	return true
}

func (s *mapStore) readCalibrationDocuments() (contracts.CalibrationDocuments, error) {
	data := emptyCalibrationDocuments()
	err := readJSON(s.calibrationDocumentsPath(), &data)
	if errors.Is(err, os.ErrNotExist) {
		return data, nil
	}
	if err != nil || !validCalibrationDocuments(data) {
		if err == nil {
			err = errors.New("invalid calibration documents")
		}
		return data, err
	}
	return data, nil
}

func (s *mapStore) readCalibrationDocument(mapID, basemap string) (contracts.CalibrationDocument, error) {
	data, err := s.readCalibrationDocuments()
	if err != nil {
		return contracts.CalibrationDocument{}, err
	}
	for _, doc := range data.Maps {
		if doc.MapId == mapID && doc.Basemap == basemap {
			return doc, nil
		}
	}
	return emptyCalibrationDocument(mapID, basemap), nil
}

func validCalibratorPreferences(data contracts.CalibratorPreferences) bool {
	if data.SchemaVersion != 1 || data.CollapsedMaps == nil || data.CollapsedFloors == nil || len(data.CollapsedMaps) > 1000 || len(data.CollapsedFloors) > 1000 {
		return false
	}
	for _, id := range data.CollapsedMaps {
		if len(id) > 100 || !safeID.MatchString(id) {
			return false
		}
	}
	for _, key := range data.CollapsedFloors {
		parts := strings.Split(key, ":")
		if len(parts) != 2 || len(parts[0]) > 100 || len(parts[1]) > 100 || !safeID.MatchString(parts[0]) || !safeID.MatchString(parts[1]) {
			return false
		}
	}
	if data.Selection == nil {
		return true
	}
	selection := data.Selection
	if !slices.Contains([]string{"map", "floor", "region"}, selection.Type) || len(selection.MapId) > 100 || !safeID.MatchString(selection.MapId) {
		return false
	}
	if selection.Type != "map" && (selection.FloorId == nil || len(*selection.FloorId) > 100 || !safeID.MatchString(*selection.FloorId)) {
		return false
	}
	if selection.Type == "region" && (selection.RegionId == nil || len(*selection.RegionId) > 100 || !safeID.MatchString(*selection.RegionId)) {
		return false
	}
	return true
}

func jsonResponse(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(value)
}

func cachedJSONResponse(w http.ResponseWriter, r *http.Request, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		apiError(w, http.StatusInternalServerError, "json_encode_failed")
		return
	}
	sum := sha256.Sum256(data)
	etag := fmt.Sprintf(`"%x"`, sum)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, must-revalidate")
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = w.Write(append(data, '\n'))
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
	return s.saveTo(filepath.Join(s.userRoot()), name, value)
}

func (s *mapStore) saveGlobal(name string, value any) error {
	return s.saveTo(filepath.Join(s.root, "user"), name, value)
}

func (s *mapStore) saveTo(dir, name string, value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	target := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
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
	return os.Rename(temp, target)
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
	openDirectory := func(w http.ResponseWriter, r *http.Request, dir string) {
		if !localRequest(w, r) {
			return
		}
		_ = os.MkdirAll(dir, 0o755)
		var cmd *exec.Cmd
		switch runtime.GOOS {
		case "windows":
			cmd = exec.Command("explorer.exe", dir)
		case "darwin":
			cmd = exec.Command("open", dir)
		default:
			cmd = exec.Command("xdg-open", dir)
		}
		if err := cmd.Start(); err != nil {
			apiError(w, http.StatusInternalServerError, "data_directory_open_failed")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
	mux.HandleFunc("GET /api/data/open", func(w http.ResponseWriter, r *http.Request) {
		openDirectory(w, r, s.calibrationRoot())
	})
	mux.HandleFunc("GET /api/data/open-user-settings", func(w http.ResponseWriter, r *http.Request) {
		openDirectory(w, r, s.userRoot())
	})
	mux.HandleFunc("POST /api/data/reset-calibration", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		s.calibrationMu.Lock()
		defer s.calibrationMu.Unlock()
		for _, path := range []string{s.calibrationDocumentsPath(), s.calibrationPreferencesPath()} {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				apiError(w, http.StatusInternalServerError, "data_reset_failed")
				return
			}
		}
		if s.calibrationReset != nil {
			s.calibrationReset()
		}
		jsonResponse(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/map-tiles/{map}/{layer}/{z}/{x}/{y}", s.tile)
	mux.HandleFunc("GET /api/stickers", func(w http.ResponseWriter, r *http.Request) {
		data := []contracts.Sticker{}
		err := readJSON(filepath.Join(s.root, "upstream", "stickers.json"), &data)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			dataError(w, err)
			return
		}
		cachedJSONResponse(w, r, data)
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
		cachedJSONResponse(w, r, summaries)
	})
	mux.HandleFunc("GET /api/maps/{id}", func(w http.ResponseWriter, r *http.Request) {
		m, err := s.load(r.PathValue("id"))
		if err != nil {
			dataError(w, err)
			return
		}
		cachedJSONResponse(w, r, m)
	})
	mux.HandleFunc("GET /api/assets/{path...}", func(w http.ResponseWriter, r *http.Request) {
		rel := r.PathValue("path")
		ext := strings.ToLower(path.Ext(rel))
		segments := strings.Split(rel, "/")
		// Every segment must be a plain id, so `..`, dots and separators can never reach the
		// filesystem; ServeFile would resolve them, which makes the checks below the boundary.
		valid := len(segments) >= 2 && !strings.Contains(rel, "\\") &&
			assetNamespaces[segments[0]] && assetExtensions[ext]
		for i, segment := range segments {
			if i == len(segments)-1 {
				valid = valid && safeID.MatchString(strings.TrimSuffix(segment, ext))
			} else {
				valid = valid && safeID.MatchString(segment)
			}
		}
		if !valid {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// The downloaded images are named after a hash of their own bytes, so a given name can
		// never describe different content. Map SVGs are not: a refresh replaces them in place
		// under a stable name, so those still have to be revalidated.
		if hasContentHashName(segments[len(segments)-1]) || ext == ".woff2" {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		root := filepath.Join(s.root, "upstream", "assets")
		local := filepath.Join(root, filepath.FromSlash(rel))
		if !strings.HasPrefix(local, root+string(filepath.Separator)) {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, local)
	})
	mux.HandleFunc("GET /api/maps/{id}/annotations", func(w http.ResponseWriter, r *http.Request) {
		m, err := s.load(r.PathValue("id"))
		if err != nil {
			dataError(w, err)
			return
		}
		data := contracts.Annotations{SchemaVersion: 1, Items: []contracts.Annotation{}}
		err = readJSON(s.userPath(filepath.Join("maps", m.Id+".annotations.json")), &data)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			dataError(w, err)
			return
		}
		if !validAnnotations(data, m) {
			dataError(w, errors.New("invalid saved annotations"))
			return
		}
		cachedJSONResponse(w, r, data)
	})
	mux.HandleFunc("GET /api/maps/{id}/calibration", func(w http.ResponseWriter, r *http.Request) {
		basemap := r.URL.Query().Get("basemap")
		if !validBasemap(basemap) {
			apiError(w, http.StatusBadRequest, "calibration_basemap_invalid")
			return
		}
		m, err := s.load(r.PathValue("id"))
		if err != nil {
			dataError(w, err)
			return
		}
		data, err := s.readCalibrationDocument(m.Id, basemap)
		if err != nil {
			log.Printf("calibration data: %v", err)
			apiError(w, http.StatusInternalServerError, "calibration_invalid")
			return
		}
		if !mapper.ValidDocument(data, m) {
			apiError(w, http.StatusInternalServerError, "calibration_invalid")
			return
		}
		cachedJSONResponse(w, r, data)
	})
	mux.HandleFunc("PUT /api/maps/{id}/calibration", func(w http.ResponseWriter, r *http.Request) {
		basemap := r.URL.Query().Get("basemap")
		if !validBasemap(basemap) {
			apiError(w, http.StatusBadRequest, "calibration_basemap_invalid")
			return
		}
		s.calibrationMu.Lock()
		defer s.calibrationMu.Unlock()
		m, err := s.load(r.PathValue("id"))
		if err != nil {
			dataError(w, err)
			return
		}
		var data contracts.CalibrationDocument
		if !decodeUpdate(w, r, &data) {
			return
		}
		if data.Basemap != basemap || !mapper.ValidDocument(data, m) {
			apiError(w, http.StatusBadRequest, "calibration_invalid")
			return
		}
		documents, err := s.readCalibrationDocuments()
		if err != nil {
			log.Printf("calibration data: %v", err)
			apiError(w, http.StatusInternalServerError, "calibration_invalid")
			return
		}
		current := emptyCalibrationDocument(m.Id, basemap)
		for _, doc := range documents.Maps {
			if doc.MapId == m.Id && doc.Basemap == basemap {
				current = doc
				break
			}
		}
		if data.Revision != current.Revision {
			apiError(w, http.StatusConflict, "calibration_revision_conflict")
			return
		}
		data.Revision++
		updated := false
		for i, doc := range documents.Maps {
			if doc.MapId == m.Id && doc.Basemap == basemap {
				documents.Maps[i] = data
				updated = true
				break
			}
		}
		if !updated {
			documents.Maps = append(documents.Maps, data)
		}
		if err = s.saveTo(s.calibrationRoot(), filepath.Base(s.calibrationDocumentsPath()), documents); err != nil {
			log.Printf("save calibration: %v", err)
			apiError(w, http.StatusInternalServerError, "calibration_save_failed")
			return
		}
		if s.changed != nil {
			s.changed("calibration_changed", m.Id, r.Header.Get("X-Operation-ID"))
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
		if err = s.save(filepath.Join("maps", m.Id+".annotations.json"), data); err != nil {
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
		err := readJSON(s.userPath("map-preferences.json"), &data)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			dataError(w, err)
			return
		}
		normalizeMapPreferences(&data)
		cachedJSONResponse(w, r, data)
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
	mux.HandleFunc("GET /api/calibration-preferences", func(w http.ResponseWriter, r *http.Request) {
		data := contracts.CalibratorPreferences{
			SchemaVersion:   1,
			CollapsedMaps:   []string{},
			CollapsedFloors: []string{},
		}
		err := readJSON(s.calibrationPreferencesPath(), &data)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			apiError(w, http.StatusInternalServerError, "calibration_preferences_invalid")
			return
		}
		if err == nil && !validCalibratorPreferences(data) {
			apiError(w, http.StatusInternalServerError, "calibration_preferences_invalid")
			return
		}
		jsonResponse(w, data)
	})
	mux.HandleFunc("PUT /api/calibration-preferences", func(w http.ResponseWriter, r *http.Request) {
		var data contracts.CalibratorPreferences
		if !decodeUpdate(w, r, &data) {
			return
		}
		if !validCalibratorPreferences(data) {
			apiError(w, http.StatusBadRequest, "preferences_invalid")
			return
		}
		s.calibrationMu.Lock()
		defer s.calibrationMu.Unlock()
		if err := s.saveTo(s.calibrationRoot(), "calibration-preferences.json", data); err != nil {
			log.Printf("save calibration preferences: %v", err)
			apiError(w, http.StatusInternalServerError, "preferences_save_failed")
			return
		}
		jsonResponse(w, data)
	})
}
