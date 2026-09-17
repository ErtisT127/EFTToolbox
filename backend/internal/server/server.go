package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	contracts "efttoolbox/contracts"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const ProtocolVersion = "1"

func New(ctx context.Context, version string, assets http.FileSystem) http.Handler {
	status := contracts.Status{ProtocolVersion: ProtocolVersion, AppVersion: version, StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(status)
	})
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()
		readCtx := conn.CloseRead(ctx)
		send := func(kind string) error {
			writeCtx, cancel := context.WithTimeout(readCtx, 5*time.Second)
			defer cancel()
			return wsjson.Write(writeCtx, conn, contracts.ServerEvent{Type: kind, SentAt: time.Now().UTC().Format(time.RFC3339Nano), Status: status})
		}
		if send("snapshot") != nil {
			return
		}
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-readCtx.Done():
				return
			case <-ticker.C:
				if send("heartbeat") != nil {
					return
				}
			}
		}
	})
	mux.Handle("/", http.FileServer(assets))
	return mux
}
