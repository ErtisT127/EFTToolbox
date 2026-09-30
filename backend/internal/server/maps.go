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

	defaults "efttoolbox/backend/internal/defaults"
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
	files            *VersionedFileStore
	calibrationMu    sync.Mutex
	modeMu           sync.RWMutex
	repo             *modeRepository
	changed          func(string, string, string)
	modeChanged      func()
	calibrationReset func()
	multiplayer      *multiplayerManager
	items            *itemsManager
	hub              *overlayHub
}

type modeRepository struct {
	mode string
	root string
	ids  map[string]struct{}
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
	if s.modeChanged != nil {
		s.modeChanged()
	}
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
	repo := &modeRepository{mode: mode, root: modeRoot, ids: map[string]struct{}{}}
	validMaps := 0
	seen := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		id, ok := mapIDFromFile(entry.Name())
		if !ok || seen[id] {
			continue
		}
		seen[id] = true
		if _, err := (&mapStore{}).loadFromRepository(id, repo, "zh"); err != nil {
			return nil, fmt.Errorf("mode %q map %q invalid: %w", mode, id, err)
		}
		repo.ids[id] = struct{}{}
		validMaps++
	}
	if validMaps == 0 {
		return nil, fmt.Errorf("mode %q contains no maps", mode)
	}
	return repo, nil
}

// mapLang maps the API locale query onto the generated per-language map file suffix
// ({id}_zh.json / {id}_en.json), the same split the items catalog uses.
func mapLang(locale string) string {
	if locale == "en-US" || locale == "en" {
		return "en"
	}
	return "zh"
}

// mapIDFromFile extracts the map id from a generated per-language file name.
func mapIDFromFile(name string) (string, bool) {
	base := strings.TrimSuffix(name, ".json")
	if idx := strings.LastIndexByte(base, '_'); idx > 0 {
		switch base[idx+1:] {
		case "zh", "en":
			return base[:idx], true
		}
	}
	return "", false
}

func (s *mapStore) loadFromRepository(id string, repo *modeRepository, lang string) (contracts.MapData, error) {
	if !safeID.MatchString(id) {
		return contracts.MapData{}, os.ErrNotExist
	}
	if repo == nil {
		return contracts.MapData{}, errors.New("mode_repository_unavailable")
	}
	if lang == "zh" {
		return readMapData(filepath.Join(repo.root, "maps", id+"_zh.json"), id)
	}
	// The English twin may be missing (data not yet regenerated) or broken; either way the
	// Chinese file is the last resort, so a language switch can never blank the map page.
	if value, err := readMapData(filepath.Join(repo.root, "maps", id+"_en.json"), id); err == nil {
		return value, nil
	}
	return readMapData(filepath.Join(repo.root, "maps", id+"_zh.json"), id)
}

func readMapData(name, id string) (contracts.MapData, error) {
	var data contracts.MapData
	if err := readJSON(name, &data); err != nil {
		return data, err
	}
	if data.SchemaVersion != contracts.ContractSchemaVersion || data.Id != id || len(data.Floors) == 0 || len(data.Projection.ViewBox) != 4 || len(data.Projection.Bounds) != 2 {
		return data, fmt.Errorf("invalid map data: %s", id)
	}
	return data, nil
}

func (s *mapStore) loadFromMode(id, mode string) (contracts.MapData, error) {
	repo, err := newModeRepository(s.root, mode)
	if err != nil {
		return contracts.MapData{}, err
	}
	return s.loadFromRepository(id, repo, "zh")
}

func readJSON(name string, value any) error {
	data, err := os.ReadFile(name)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

// load reads the Chinese map data: the geometry and existence checks never need a locale.
func (s *mapStore) load(id string) (contracts.MapData, error) {
	return s.loadFromRepository(id, s.repository(), "zh")
}

func (s *mapStore) hasMap(id string) bool {
	repo := s.repository()
	if repo == nil {
		return false
	}
	if repo.ids != nil {
		_, ok := repo.ids[id]
		return ok
	}
	_, err := s.loadFromRepository(id, repo, "zh")
	return err == nil
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

// validMarkerPreferences gates the user-level owner visibility arrays: bounded length, deduped.
func validMarkerPreferences(data contracts.MarkerPreferences) bool {
	if data.SchemaVersion != contracts.ContractSchemaVersion || data.HiddenOwners == nil || data.ShownOwners == nil || len(data.HiddenOwners) > 1000 || len(data.ShownOwners) > 1000 {
		return false
	}
	for _, list := range [][]string{data.HiddenOwners, data.ShownOwners} {
		seen := map[string]bool{}
		for _, owner := range list {
			if owner == "" || len(owner) > 100 || seen[owner] {
				return false
			}
			seen[owner] = true
		}
	}
	return true
}

func emptyCalibrationDocument(mapID, basemap string) contracts.CalibrationDocument {
	document := defaults.CalibrationDocument()
	document.MapId = mapID
	document.Basemap = basemap
	return document
}

func emptyCalibrationDocuments() contracts.CalibrationDocuments {
	return defaults.CalibrationDocuments()
}

func (s *mapStore) ensureCalibrationDefaults() error {
	for _, file := range []struct {
		path  string
		value any
	}{
		{s.calibrationDocumentsPath(), defaults.CalibrationDocuments()},
		{s.calibrationPreferencesPath(), defaults.CalibratorPreferences()},
	} {
		if _, err := os.Stat(file.path); err == nil {
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := s.saveTo(s.calibrationRoot(), filepath.Base(file.path), file.value); err != nil {
			return err
		}
	}
	return nil
}

func (s *mapStore) resetCalibration() error {
	if err := s.saveTo(s.calibrationRoot(), filepath.Base(s.calibrationDocumentsPath()), defaults.CalibrationDocuments()); err != nil {
		return err
	}
	if err := s.saveTo(s.calibrationRoot(), filepath.Base(s.calibrationPreferencesPath()), defaults.CalibratorPreferences()); err != nil {
		return err
	}
	if s.calibrationReset != nil {
		s.calibrationReset()
	}
	return nil
}

func (s *mapStore) resetMapPreferences() error {
	root := filepath.Join(s.root, "user", "modes")
	modes, err := os.ReadDir(root)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	modeNames := map[string]bool{}
	for _, mode := range modes {
		if !mode.IsDir() || !safeID.MatchString(mode.Name()) {
			continue
		}
		modeNames[mode.Name()] = true
	}
	if s.repository() != nil {
		modeNames[s.repository().mode] = true
	}
	for mode := range modeNames {
		modeRoot := filepath.Join(root, mode)
		if err := s.saveTo(modeRoot, "map-preferences.json", defaults.MapPreferences()); err != nil {
			return err
		}
		if err := s.saveTo(modeRoot, "game-monitor-state.json", gameMonitorState{SchemaVersion: contracts.ContractSchemaVersion}); err != nil {
			return err
		}
	}
	if s.hub != nil {
		s.hub.mu.Lock()
		s.hub.appliedMapID = ""
		s.hub.monitorStatus.MapId = ""
		status := s.hub.monitorStatus
		s.hub.publish(contracts.ServerEvent{Type: "game_monitor_changed", GameMonitorStatus: &status})
		s.hub.publish(contracts.ServerEvent{Type: "resources_changed"})
		s.hub.clearLocationCache()
		s.hub.mu.Unlock()
	}
	if s.changed != nil {
		s.changed("preferences_changed", "", "")
	}
	return nil
}

func (s *mapStore) migrateLegacyModeFiles(mode string) error {
	legacyRoot := filepath.Join(s.root, "user")
	modeRoot := filepath.Join(legacyRoot, "modes", mode)
	for _, file := range []struct {
		name  string
		valid func([]byte) bool
	}{
		{"map-preferences.json", func(data []byte) bool {
			var value contracts.Preferences
			return json.Unmarshal(data, &value) == nil && value.SchemaVersion == contracts.ContractSchemaVersion
		}},
		{"game-monitor-state.json", func(data []byte) bool {
			var value gameMonitorState
			return json.Unmarshal(data, &value) == nil && value.SchemaVersion == contracts.ContractSchemaVersion
		}},
	} {
		legacyPath := filepath.Join(legacyRoot, file.name)
		legacyData, err := os.ReadFile(legacyPath)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil || !file.valid(legacyData) {
			continue
		}
		canonicalPath := filepath.Join(modeRoot, file.name)
		if _, err := os.Stat(canonicalPath); errors.Is(err, os.ErrNotExist) {
			if err := s.savePath(canonicalPath, json.RawMessage(legacyData)); err != nil {
				return err
			}
		} else {
			canonicalData, readErr := os.ReadFile(canonicalPath)
			if readErr != nil || !file.valid(canonicalData) {
				continue
			}
		}
		if err := os.Remove(legacyPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (s *mapStore) resetAnnotations() error {
	paths, err := filepath.Glob(filepath.Join(s.root, "user", "modes", "*", "maps", "*.annotations.json"))
	if err != nil {
		return err
	}
	if s.multiplayer != nil {
		s.multiplayer.annoMu.Lock()
		for id, timer := range s.multiplayer.annoTimers {
			timer.Stop()
			delete(s.multiplayer.annoTimers, id)
		}
		s.multiplayer.remoteDocs = map[string]map[string][]contracts.Annotation{}
		s.multiplayer.sentOwn = map[string][]contracts.Annotation{}
		s.multiplayer.sentOnce = map[string]bool{}
	}
	for _, path := range paths {
		base := filepath.Base(path)
		mapID := strings.TrimSuffix(base, ".annotations.json")
		if !safeID.MatchString(mapID) {
			continue
		}
		if err := s.saveTo(filepath.Dir(path), base, contracts.Annotations{SchemaVersion: contracts.ContractSchemaVersion, Items: []contracts.Annotation{}}); err != nil {
			if s.multiplayer != nil {
				s.multiplayer.annoMu.Unlock()
			}
			return err
		}
	}
	if s.multiplayer != nil {
		s.multiplayer.annoMu.Unlock()
	}
	for _, path := range paths {
		base := filepath.Base(path)
		mapID := strings.TrimSuffix(base, ".annotations.json")
		if !safeID.MatchString(mapID) {
			continue
		}
		if s.changed != nil {
			s.changed("annotations_changed", mapID, "")
		}
	}
	return nil
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
	if data.SchemaVersion != contracts.ContractSchemaVersion || data.Maps == nil || len(data.Maps) > 2000 {
		return false
	}
	ids := map[string]bool{}
	for _, doc := range data.Maps {
		key := doc.MapId + ":" + doc.Basemap
		if !safeID.MatchString(doc.MapId) || len(doc.MapId) > 100 || !validBasemap(doc.Basemap) || ids[key] || doc.SchemaVersion != contracts.ContractSchemaVersion || doc.Revision < 0 || doc.NextRegionNumber < 1 || len(doc.Regions) > 10000 {
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
	if data.SchemaVersion != contracts.ContractSchemaVersion || data.CollapsedMaps == nil || data.CollapsedFloors == nil || len(data.CollapsedMaps) > 1000 || len(data.CollapsedFloors) > 1000 {
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

func versionedJSONResponse(w http.ResponseWriter, value any, revision, etag string) {
	w.Header().Set("X-Revision", revision)
	w.Header().Set("ETag", etag)
	jsonResponse(w, value)
}

func requireRevision(w http.ResponseWriter, r *http.Request) (string, bool) {
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host != r.Host {
			apiError(w, http.StatusForbidden, "origin_rejected")
			return "", false
		}
	}
	expected := expectedRevision(r.Header.Get("If-Match"), r.Header.Get("X-Expected-Revision"))
	if expected == "" {
		apiError(w, http.StatusPreconditionRequired, "revision_required")
		return "", false
	}
	return expected, true
}

func versionedConflict(w http.ResponseWriter, revision, etag string) {
	w.Header().Set("X-Revision", revision)
	w.Header().Set("ETag", etag)
	apiError(w, http.StatusConflict, "revision_conflict")
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
	// 5xx means the app failed rather than the request, so it belongs in the log pipeline; 4xx is a
	// normal rejection and would only add noise.
	if status >= http.StatusInternalServerError {
		log.Printf("api error %d: %s", status, code)
	}
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
	return s.savePath(filepath.Join(dir, name), value)
}

func (s *mapStore) savePath(name string, value any) error {
	if s.files == nil {
		return errors.New("versioned file store is not initialized")
	}
	relative, err := filepath.Rel(s.root, name)
	if err != nil {
		return err
	}
	return s.files.Save(relative, value)
}

func validAnnotations(data contracts.Annotations, m contracts.MapData) bool {
	if data.SchemaVersion != contracts.ContractSchemaVersion || data.Items == nil || len(data.Items) > 10000 {
		return false
	}
	ids := map[string]bool{}
	for _, a := range data.Items {
		if !safeID.MatchString(a.Id) || len(a.Id) > 100 || ids[a.Id] || !slices.ContainsFunc(m.Floors, func(f contracts.Floor) bool { return f.Id == a.FloorId }) {
			return false
		}
		// Annotations are per-owner documents at heart: multiplayer sync merges foreign owners
		// into the local file, so every item must carry a well-formed owner id.
		if a.OwnerId == "" || len(a.OwnerId) > 100 || !safeID.MatchString(a.OwnerId) {
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
		if err := s.resetCalibration(); err != nil {
			apiError(w, http.StatusInternalServerError, "data_reset_failed")
			return
		}
		jsonResponse(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/data/reset/{kind}", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var err error
		switch r.PathValue("kind") {
		case "map-preferences":
			err = s.resetMapPreferences()
		case "annotations":
			err = s.resetAnnotations()
		case "calibration":
			s.calibrationMu.Lock()
			defer s.calibrationMu.Unlock()
			err = s.resetCalibration()
		case "marker-preferences":
			err = s.saveGlobal(filepath.Base(filepath.Join("user", "marker-preferences.json")), defaults.MarkerPreferences())
		case "items-settings":
			if s.items == nil {
				err = errors.New("items unavailable")
			} else {
				err = s.items.resetSettings()
			}
		case "multiplayer":
			if s.multiplayer == nil {
				err = errors.New("multiplayer unavailable")
			} else {
				err = s.multiplayer.resetData()
			}
		default:
			http.NotFound(w, r)
			return
		}
		if err != nil {
			if errors.Is(err, errMultiplayerResetInRoom) {
				apiError(w, http.StatusConflict, err.Error())
			} else {
				apiError(w, http.StatusInternalServerError, "data_reset_failed")
			}
			return
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
		repo := s.repository()
		if repo == nil {
			dataError(w, errors.New("mode_repository_unavailable"))
			return
		}
		lang := mapLang(r.URL.Query().Get("locale"))
		files, err := os.ReadDir(filepath.Join(repo.root, "maps"))
		if err != nil {
			dataError(w, err)
			return
		}
		summaries := []contracts.MapSummary{}
		seen := map[string]bool{}
		// The catalog supplies data-defined ordering; newly added map files are discovered too.
		var order []contracts.MapSummary
		catalogFile := filepath.Join(repo.root, "catalog_"+lang+".json")
		if _, err := os.Stat(catalogFile); err != nil {
			catalogFile = filepath.Join(repo.root, "catalog_zh.json")
		}
		_ = readJSON(catalogFile, &order)
		for _, file := range files {
			id, ok := mapIDFromFile(file.Name())
			// Every map has one file per language; the id decides, so the pair yields one summary.
			if file.IsDir() || !ok || seen[id] {
				continue
			}
			seen[id] = true
			m, err := s.loadFromRepository(id, repo, lang)
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
		repo := s.repository()
		m, err := s.loadFromRepository(r.PathValue("id"), repo, mapLang(r.URL.Query().Get("locale")))
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
		repo := s.repository()
		m, err := s.loadFromRepository(r.PathValue("id"), repo, "zh")
		if err != nil {
			dataError(w, err)
			return
		}
		data := contracts.Annotations{SchemaVersion: contracts.ContractSchemaVersion, Items: []contracts.Annotation{}}
		path := filepath.Join("user", "modes", repo.mode, "maps", m.Id+".annotations.json")
		var revision, etag string
		data, revision, etag, err = ReadVersionedRepair(s.files, path, data, func(value *contracts.Annotations) error {
			if !validAnnotations(*value, m) {
				log.Printf("annotations treated as empty: map=%s", m.Id)
				*value = contracts.Annotations{SchemaVersion: contracts.ContractSchemaVersion, Items: []contracts.Annotation{}}
			}
			return nil
		})
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			dataError(w, err)
			return
		}
		versionedJSONResponse(w, data, revision, etag)
	})
	mux.HandleFunc("GET /api/maps/{id}/calibration", func(w http.ResponseWriter, r *http.Request) {
		basemap := r.URL.Query().Get("basemap")
		if !validBasemap(basemap) {
			apiError(w, http.StatusBadRequest, "calibration_basemap_invalid")
			return
		}
		repo := s.repository()
		m, err := s.loadFromRepository(r.PathValue("id"), repo, "zh")
		if err != nil {
			dataError(w, err)
			return
		}
		documents, revision, etag, err := ReadVersioned(s.files, filepath.Join("user", "calibration", "maps.calibration.json"), emptyCalibrationDocuments())
		if err != nil {
			log.Printf("calibration data: %v", err)
			apiError(w, http.StatusInternalServerError, "calibration_invalid")
			return
		}
		if !validCalibrationDocuments(documents) {
			apiError(w, http.StatusInternalServerError, "calibration_invalid")
			return
		}
		data := emptyCalibrationDocument(m.Id, basemap)
		for _, document := range documents.Maps {
			if document.MapId == m.Id && document.Basemap == basemap {
				data = document
				break
			}
		}
		if !mapper.ValidDocument(data, m) {
			apiError(w, http.StatusInternalServerError, "calibration_invalid")
			return
		}
		versionedJSONResponse(w, data, revision, etag)
	})
	mux.HandleFunc("PUT /api/maps/{id}/calibration", func(w http.ResponseWriter, r *http.Request) {
		basemap := r.URL.Query().Get("basemap")
		if !validBasemap(basemap) {
			apiError(w, http.StatusBadRequest, "calibration_basemap_invalid")
			return
		}
		expected, ok := requireRevision(w, r)
		if !ok {
			return
		}
		s.calibrationMu.Lock()
		defer s.calibrationMu.Unlock()
		repo := s.repository()
		m, err := s.loadFromRepository(r.PathValue("id"), repo, "zh")
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
		currentRevision, currentETag, hashErr := revisionOf(documents)
		if hashErr != nil {
			apiError(w, http.StatusInternalServerError, "calibration_invalid")
			return
		}
		if data.Revision != current.Revision {
			versionedConflict(w, currentRevision, currentETag)
			return
		}
		if strings.Trim(expected, `\"`) != currentRevision {
			versionedConflict(w, currentRevision, currentETag)
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
		newRevision, newETag, _ := revisionOf(documents)
		versionedJSONResponse(w, data, newRevision, newETag)
	})
	mux.HandleFunc("PUT /api/maps/{id}/annotations", func(w http.ResponseWriter, r *http.Request) {
		expected, ok := requireRevision(w, r)
		if !ok {
			return
		}
		repo := s.repository()
		m, err := s.loadFromRepository(r.PathValue("id"), repo, "zh")
		if err != nil {
			dataError(w, err)
			return
		}
		var data contracts.Annotations
		if !decodeUpdate(w, r, &data) {
			return
		}
		if s.multiplayer != nil {
			// The multiplayer manager owns the merge (and the save): incoming items are
			// authoritative for the local owner only, foreign owners always come from the cache.
			merged, revision, etag, mergeErr := s.multiplayer.applyLocalAnnotations(repo, m.Id, m, data, expected)
			if mergeErr != nil {
				if errors.Is(mergeErr, errRevisionConflict) {
					versionedConflict(w, revision, etag)
					return
				}
				status := http.StatusBadRequest
				if mergeErr.Error() == "annotations_save_failed" {
					status = http.StatusInternalServerError
				}
				apiError(w, status, mergeErr.Error())
				return
			}
			data = merged
			if s.changed != nil {
				s.changed("annotations_changed", m.Id, r.Header.Get("X-Operation-ID"))
			}
			// The merge already saved and returned the revision of the written document;
			// re-reading here could race a concurrent remote-annotation write.
			versionedJSONResponse(w, data, revision, etag)
			return
		} else {
			if !validAnnotations(data, m) {
				apiError(w, http.StatusBadRequest, "annotations_invalid")
				return
			}
			path := filepath.Join("user", "modes", repo.mode, "maps", m.Id+".annotations.json")
			revision, etag, updateErr := s.files.Update(path, expected, contracts.Annotations{SchemaVersion: contracts.ContractSchemaVersion, Items: []contracts.Annotation{}}, data, nil)
			if errors.Is(updateErr, errRevisionConflict) {
				versionedConflict(w, revision, etag)
				return
			}
			if err = updateErr; err != nil {
				log.Printf("save annotations: %v", err)
				apiError(w, http.StatusInternalServerError, "annotations_save_failed")
				return
			}
			versionedJSONResponse(w, data, revision, etag)
			if s.changed != nil {
				s.changed("annotations_changed", m.Id, r.Header.Get("X-Operation-ID"))
			}
			return
		}
	})
	mux.HandleFunc("GET /api/map-preferences", func(w http.ResponseWriter, r *http.Request) {
		repo := s.repository()
		if repo == nil {
			dataError(w, errors.New("mode_repository_unavailable"))
			return
		}
		data := defaults.MapPreferences()
		var revision, etag string
		data, revision, etag, err := ReadVersionedRepair(s.files, filepath.Join("user", "modes", repo.mode, "map-preferences.json"), data, func(value *contracts.Preferences) error {
			normalizeMapPreferences(value)
			return nil
		})
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			dataError(w, err)
			return
		}
		versionedJSONResponse(w, data, revision, etag)
	})
	mux.HandleFunc("PUT /api/map-preferences", func(w http.ResponseWriter, r *http.Request) {
		expected, ok := requireRevision(w, r)
		if !ok {
			return
		}
		repo := s.repository()
		if repo == nil {
			dataError(w, errors.New("mode_repository_unavailable"))
			return
		}
		var data contracts.Preferences
		if !decodeUpdate(w, r, &data) {
			return
		}
		if data.SchemaVersion != contracts.ContractSchemaVersion || data.Maps == nil || len(data.Maps) > 1000 || data.StickerUsage == nil || len(data.StickerUsage) > 1000 {
			apiError(w, http.StatusBadRequest, "preferences_invalid")
			return
		}
		if data.SelectedMap != "" {
			if _, err := s.loadFromRepository(data.SelectedMap, repo, "zh"); err != nil {
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
		relative := filepath.Join("user", "modes", repo.mode, "map-preferences.json")
		revision, etag, err := s.files.Update(relative, expected, defaults.MapPreferences(), data, nil)
		if errors.Is(err, errRevisionConflict) {
			versionedConflict(w, revision, etag)
			return
		}
		if err != nil {
			log.Printf("save preferences: %v", err)
			apiError(w, http.StatusInternalServerError, "preferences_save_failed")
			return
		}
		if s.hub != nil {
			s.hub.preferencesChanged(data, data.SelectedMap, r.Header.Get("X-Operation-ID"))
		} else if s.changed != nil {
			s.changed("preferences_changed", data.SelectedMap, r.Header.Get("X-Operation-ID"))
		}
		versionedJSONResponse(w, data, revision, etag)
	})
	mux.HandleFunc("GET /api/marker-preferences", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		data, revision, etag, err := ReadVersionedRepair(s.files, filepath.Join("user", "marker-preferences.json"), defaults.MarkerPreferences(), func(value *contracts.MarkerPreferences) error {
			if !validMarkerPreferences(*value) {
				*value = defaults.MarkerPreferences()
			}
			return nil
		})
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			apiError(w, http.StatusInternalServerError, "marker_preferences_invalid")
			return
		}
		versionedJSONResponse(w, data, revision, etag)
	})
	mux.HandleFunc("PUT /api/marker-preferences", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		expected, ok := requireRevision(w, r)
		if !ok {
			return
		}
		var data contracts.MarkerPreferences
		if !decodeUpdate(w, r, &data) {
			return
		}
		if !validMarkerPreferences(data) {
			apiError(w, http.StatusBadRequest, "preferences_invalid")
			return
		}
		revision, etag, err := s.files.Update(filepath.Join("user", "marker-preferences.json"), expected, defaults.MarkerPreferences(), data, nil)
		if errors.Is(err, errRevisionConflict) {
			versionedConflict(w, revision, etag)
			return
		}
		if err != nil {
			log.Printf("save marker preferences: %v", err)
			apiError(w, http.StatusInternalServerError, "preferences_save_failed")
			return
		}
		versionedJSONResponse(w, data, revision, etag)
		if s.hub != nil {
			s.hub.markerPreferencesChanged(data, r.Header.Get("X-Operation-ID"))
		}
	})
	mux.HandleFunc("GET /api/calibration-preferences", func(w http.ResponseWriter, r *http.Request) {
		data, revision, etag, err := ReadVersioned(s.files, filepath.Join("user", "calibration", "calibration-preferences.json"), defaults.CalibratorPreferences())
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			apiError(w, http.StatusInternalServerError, "calibration_preferences_invalid")
			return
		}
		if err == nil && !validCalibratorPreferences(data) {
			apiError(w, http.StatusInternalServerError, "calibration_preferences_invalid")
			return
		}
		versionedJSONResponse(w, data, revision, etag)
	})
	mux.HandleFunc("PUT /api/calibration-preferences", func(w http.ResponseWriter, r *http.Request) {
		expected, ok := requireRevision(w, r)
		if !ok {
			return
		}
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
		revision, etag, err := s.files.Update(filepath.Join("user", "calibration", "calibration-preferences.json"), expected, defaults.CalibratorPreferences(), data, nil)
		if errors.Is(err, errRevisionConflict) {
			versionedConflict(w, revision, etag)
			return
		}
		if err != nil {
			log.Printf("save calibration preferences: %v", err)
			apiError(w, http.StatusInternalServerError, "preferences_save_failed")
			return
		}
		versionedJSONResponse(w, data, revision, etag)
	})
}
