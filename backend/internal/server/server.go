package server

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	contracts "efttoolbox/contracts"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const ProtocolVersion = "1"

func New(ctx context.Context, version string, assets http.FileSystem, dataRoot string) http.Handler {
	logWriter, err := newDailyLogWriter(filepath.Join(dataRoot, "..", "logs"))
	if err == nil {
		log.SetOutput(io.MultiWriter(os.Stderr, logWriter))
	} else {
		log.Printf("initialize daily log writer: %v", err)
	}
	status := contracts.Status{ProtocolVersion: ProtocolVersion, AppVersion: version, StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	mux := http.NewServeMux()
	(&mapStore{root: dataRoot}).register(mux)
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
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			log.Printf("websocket accept remote=%s: %v", r.RemoteAddr, err)
			return
		}
		defer func() { _ = conn.CloseNow() }()
		readCtx := conn.CloseRead(ctx)
		send := func(kind string) error {
			writeCtx, cancel := context.WithTimeout(readCtx, 5*time.Second)
			defer cancel()
			event := contracts.ServerEvent{Type: kind, SentAt: time.Now().UTC().Format(time.RFC3339Nano), Status: status}
			if kind == "snapshot" {
				players := []contracts.PlayerState{}
				annotations := []contracts.SharedAnnotation{}
				event.Players = &players
				event.Annotations = &annotations
			}
			return wsjson.Write(writeCtx, conn, event)
		}
		if err := send("snapshot"); err != nil {
			if readCtx.Err() == nil {
				log.Printf("websocket snapshot write remote=%s: %v", r.RemoteAddr, err)
			}
			return
		}
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-readCtx.Done():
				return
			case <-ticker.C:
				if err := send("heartbeat"); err != nil {
					if readCtx.Err() == nil {
						log.Printf("websocket heartbeat write remote=%s: %v", r.RemoteAddr, err)
					}
					return
				}
			}
		}
	})
	mux.Handle("/", http.FileServer(assets))
	return mux
}
