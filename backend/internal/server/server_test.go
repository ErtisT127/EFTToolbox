package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	contracts "efttoolbox/contracts"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestLocationCandidatesNormalizePresetVariants(t *testing.T) {
	for _, name := range []string{"factory_day_preset", "factory_night_preset", "sandbox_high_preset", "sandbox_start_preset", "laboratory_dark_preset"} {
		candidates := locationCandidates(name)
		want := "factory"
		if strings.HasPrefix(name, "sandbox") {
			want = "sandbox"
		}
		if strings.HasPrefix(name, "laboratory") {
			want = "laboratory"
		}
		if candidates[0] != name || candidates[len(candidates)-1] != want {
			t.Fatalf("locationCandidates(%q) = %#v", name, candidates)
		}
	}
	if got := locationCandidates("customs_preset"); len(got) != 2 || got[0] != "customs_preset" || got[1] != "customs" {
		t.Fatalf("locationCandidates(customs_preset) = %#v", got)
	}
	if got := locationCandidates("shopping_mall"); len(got) != 1 || got[0] != "shopping_mall" {
		t.Fatalf("locationCandidates(shopping_mall) = %#v", got)
	}
}

func TestHTTPAndWebSocket(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	srv := httptest.NewServer(New(ctx, "test-version", http.FS(fstest.MapFS{"index.html": {Data: []byte("dashboard")}}), t.TempDir()))
	defer srv.Close()
	response, err := http.Get(srv.URL + "/api/status")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	var status contracts.Status
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || status.ProtocolVersion != contracts.ContractProtocolVersion || status.AppVersion != "test-version" {
		t.Fatalf("unexpected status: %+v", status)
	}
	if _, err := time.Parse(time.RFC3339Nano, status.StartedAt); err != nil {
		t.Fatal(err)
	}
	requestCtx, stop := context.WithTimeout(ctx, 6*time.Second)
	defer stop()
	conn, _, err := websocket.Dial(requestCtx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.CloseNow() }()
	for _, kind := range []string{"snapshot", "heartbeat"} {
		var event contracts.ServerEvent
		if err := wsjson.Read(requestCtx, conn, &event); err != nil {
			t.Fatal(err)
		}
		if event.Type != kind || event.Status != status {
			t.Fatalf("unexpected event: %+v", event)
		}
		if _, err := time.Parse(time.RFC3339Nano, event.SentAt); err != nil {
			t.Fatal(err)
		}
	}
	cancel()
	if _, _, err := conn.Read(requestCtx); err == nil {
		t.Fatal("connection should close on shutdown")
	}
}

func TestRejectForeignWebSocketOrigin(t *testing.T) {
	srv := httptest.NewServer(New(context.Background(), "test", http.FS(fstest.MapFS{}), t.TempDir()))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://unrelated.example"}}})
	if conn != nil {
		_ = conn.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("expected origin rejection, got %v, %v", response, err)
	}
}

func TestClientLogsArePersisted(t *testing.T) {
	root := t.TempDir()
	dataRoot := filepath.Join(root, "data")
	srv := httptest.NewServer(New(context.Background(), "test", http.FS(fstest.MapFS{}), dataRoot))
	defer srv.Close()
	response, err := http.Post(srv.URL+"/api/logs", "application/json", strings.NewReader(`{"level":"error","event":"test","message":"client failed"}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("unexpected log status: %d", response.StatusCode)
	}
	files, err := filepath.Glob(filepath.Join(root, "logs", "efttoolbox-*.jsonl"))
	if err != nil || len(files) != 1 {
		t.Fatalf("expected one log file, got %v, %v", files, err)
	}
	data, err := os.ReadFile(files[0])
	if err != nil || !strings.Contains(string(data), `"message":"client failed"`) {
		t.Fatalf("log entry missing: %s, %v", data, err)
	}
}
