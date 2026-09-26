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

const ProtocolVersion = "1"

func New(ctx context.Context, version string, assets http.FileSystem, dataRoot string) http.Handler {
	logWriter, err := newDailyLogWriter(filepath.Join(dataRoot, "..", "logs"))
	if err == nil {
		log.SetOutput(logWriter)
	} else {
		log.Printf("initialize daily log writer: %v", err)
	}
	status := contracts.Status{ProtocolVersion: ProtocolVersion, AppVersion: version, StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	mux := http.NewServeMux()
	store := &mapStore{root: dataRoot}
	hub := &overlayHub{store: store, status: status, players: map[string]contracts.PlayerState{}, clients: map[chan contracts.ServerEvent]bool{}, browseActive: map[string]bool{}, indexes: map[string]regionIndexSnapshot{}, overlapDedup: newOverlapDedup()}
	mobile := newMobileManager(ctx, assets, hub)
	hub.mobile = mobile
	hub.mobileBase = mux
	multiplayer := newMultiplayerManager(ctx, hub)
	hub.multiplayer = multiplayer
	store.multiplayer = multiplayer
	store.changed = hub.changed
	store.calibrationReset = hub.invalidateCalibrationIndexes
	if writer, ok := logWriter.(*dailyLogWriter); ok {
		hub.logWriter = writer
		hub.pipe = startOverlayLogPipe(ctx, writer)
	}
	store.register(mux)
	hub.register(mux)
	mobile.register(mux)
	multiplayer.register(mux)
	hub.registerGameMonitor(mux)
	hub.startGameMonitor(ctx)
	if writer, ok := logWriter.(*dailyLogWriter); ok {
		mux.HandleFunc("POST /api/logs", func(w http.ResponseWriter, r *http.Request) {
			defer func() { _ = r.Body.Close() }()
			var entry clientLog
			if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&entry); err != nil {
				http.Error(w, "invalid log entry", http.StatusBadRequest)
				return
			}
			entry.Component = strings.TrimSpace(entry.Component)
			if entry.Component == "" {
				entry.Component = "dashboard"
			}
			if entry.Level == "" {
				entry.Level = "error"
			}
			if err := writer.write(entry); err != nil {
				http.Error(w, "log unavailable", http.StatusServiceUnavailable)
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
		mux.ServeHTTP(w, r)
	})
}
