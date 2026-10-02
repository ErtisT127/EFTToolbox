package server

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	contracts "efttoolbox/contracts"
)

func New(ctx context.Context, version string, assets http.FileSystem, dataRoot string) http.Handler {
	if err := InstallLogging(filepath.Join(dataRoot, "..", "logs")); err != nil {
		log.Printf("initialize daily log writer: %v", err)
	}
	logWriter := installedLogWriter
	slowLogger := newSlowOperationLogger(ctx, logWriter)
	status := contracts.Status{ProtocolVersion: contracts.ContractProtocolVersion, AppVersion: version, StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	mux := http.NewServeMux()
	store := &mapStore{root: dataRoot, files: &VersionedFileStore{root: dataRoot, slow: slowLogger}}
	hub := &overlayHub{store: store, status: status, players: map[string]contracts.PlayerState{}, clients: map[chan contracts.ServerEvent]bool{}, browseActive: map[string]bool{}, indexes: map[string]regionIndexSnapshot{}, overlapDedup: newOverlapDedup()}
	mobile := newMobileManager(ctx, assets, hub)
	hub.mobile = mobile
	hub.mobileBase = mux
	multiplayer := newMultiplayerManager(ctx, hub)
	hub.multiplayer = multiplayer
	store.multiplayer = multiplayer
	store.hub = hub
	store.changed = hub.changed
	store.calibrationReset = hub.invalidateCalibrationIndexes
	items := newItemsManager(ctx, store, hub)
	store.items = items
	store.modeChanged = func() {
		items.cancelUpdate()
	}
	if logWriter != nil {
		hub.logWriter = logWriter
		hub.pipe = startOverlayLogPipe(ctx, logWriter)
	}
	store.register(mux)
	hub.register(mux)
	newUpdateManager(dataRoot, version).register(mux)
	mobile.register(mux)
	multiplayer.register(mux)
	items.register(mux)
	hub.registerGameMonitor(mux)
	if err := store.ensureCalibrationDefaults(); err != nil {
		log.Printf("initialize calibration defaults: %v", err)
	}
	hub.startGameMonitor(ctx)
	if logWriter != nil {
		mux.HandleFunc("POST /api/logs", func(w http.ResponseWriter, r *http.Request) {
			defer func() { _ = r.Body.Close() }()
			var entry clientLog
			if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&entry); err != nil {
				apiError(w, http.StatusBadRequest, "log_entry_invalid")
				return
			}
			entry.Component = strings.TrimSpace(entry.Component)
			if entry.Component == "" {
				entry.Component = "dashboard"
			}
			if entry.Level == "" {
				entry.Level = "error"
			}
			if err := logWriter.write(entry); err != nil {
				apiError(w, http.StatusServiceUnavailable, "log_unavailable")
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
	}
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(status)
	})
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) { hub.websocket(ctx, w, r) })
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		http.FileServer(assets).ServeHTTP(w, r)
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := rand.Text()
		r.Header.Set("X-Operation-ID", id)
		w.Header().Set("X-Operation-ID", id)
		if slowLogger == nil || !shouldMeasureAPI(r.URL.Path) {
			mux.ServeHTTP(w, r)
			return
		}
		started := time.Now()
		response := &apiResponseWriter{ResponseWriter: w}
		mux.ServeHTTP(response, r)
		elapsed := time.Since(started)
		slowLogger.record(elapsed, "slow_api_request", slowAPIMessage(r, response, elapsed), id)
	})
}
