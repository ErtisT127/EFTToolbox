package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	contracts "efttoolbox/contracts"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// Covers public persistence and reconnect contracts; no renderer/private-state assertions.
func TestOverlaySettingsAndPlayerSnapshot(t *testing.T) {
	root, handler := mapFixture(t)
	srv := httptest.NewServer(handler)
	defer srv.Close()
	call := func(method, path string, value any, expected int) []byte {
		t.Helper()
		body, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest(method, srv.URL+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = response.Body.Close() }()
		data, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != expected {
			t.Fatalf("%s %s: %d %s %v", method, path, response.StatusCode, data, err)
		}
		return data
	}
	s := defaultOverlaySettings()
	s.Width = 99999
	s.DevPlayerEnabled = true
	var saved contracts.OverlaySettings
	if err := json.Unmarshal(call("PUT", "/api/overlay-settings", s, 200), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Width != 2048 || saved.Hotkeys.ToggleEdit != "" {
		t.Fatalf("normalization failed: %+v", saved)
	}
	s.Hotkeys.ToggleEdit = "Ctrl+Ctrl+M"
	call("PUT", "/api/overlay-settings", s, 400)
	s.Hotkeys.ToggleEdit = ""
	s.Width = 1
	data, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "user", "overlay-settings.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(call("GET", "/api/overlay-settings", nil, 200), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Width != 160 {
		t.Fatalf("GET did not normalize disk: %+v", saved)
	}
	settingsPath := filepath.Join(root, "user", "overlay-settings.json")
	for _, corrupt := range []string{"null", "{}", "[]", `{"schemaVersion":1,"shape":"square","svgResolution":2048,"unknown":1}`, "{} {}"} {
		if err = os.WriteFile(settingsPath, []byte(corrupt), 0o600); err != nil {
			t.Fatal(err)
		}
		call("GET", "/api/overlay-settings", nil, 500)
		unchanged, readErr := os.ReadFile(settingsPath)
		if readErr != nil || string(unchanged) != corrupt {
			t.Fatalf("invalid settings overwritten: %q %v", unchanged, readErr)
		}
	}
	if err = os.WriteFile(settingsPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	player := contracts.DevPlayer{PlayerId: "self", MapId: "fixture", FloorId: "ground", IsSelf: true, X: 25, Z: 75, Heading: 0}
	call("POST", "/api/dev/player", player, 200)
	readSnapshot := func() contracts.ServerEvent {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = conn.CloseNow() }()
		var event contracts.ServerEvent
		if err = wsjson.Read(ctx, conn, &event); err != nil {
			t.Fatal(err)
		}
		return event
	}
	for range 2 {
		e := readSnapshot()
		if e.Type != "snapshot" || e.Players == nil || len(*e.Players) != 1 {
			t.Fatalf("missing player snapshot: %+v", e)
		}
		p := (*e.Players)[0]
		if p.Position.X != 25 || p.Position.Y != 25 || p.Heading != 0 {
			t.Fatalf("world projection: %+v", p)
		}
	}
	call("DELETE", "/api/dev/player/self", nil, 200)
	if e := readSnapshot(); e.Players == nil || len(*e.Players) != 0 {
		t.Fatal("removed player survived snapshot")
	}
	player.FloorId = "unknown"
	call("POST", "/api/dev/player", player, 400)
	s.DevPlayerEnabled = false
	call("PUT", "/api/overlay-settings", s, 200)
	player.FloorId = "ground"
	call("POST", "/api/dev/player", player, 403)
	req := httptest.NewRequest("GET", "http://localhost/api/overlay/bootstrap", nil)
	req.RemoteAddr = "192.0.2.1:9000"
	out := httptest.NewRecorder()
	handler.ServeHTTP(out, req)
	if out.Code != 403 {
		t.Fatal("bootstrap accepted non-loopback peer")
	}
}

func TestOverlayConnectionReplacement(t *testing.T) {
	_, handler := mapFixture(t)
	srv := httptest.NewServer(handler)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connect := func() *websocket.Conn {
		t.Helper()
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?client=overlay", nil)
		if err != nil {
			t.Fatal(err)
		}
		var snapshot contracts.ServerEvent
		if err = wsjson.Read(ctx, conn, &snapshot); err != nil || snapshot.Type != "snapshot" {
			_ = conn.CloseNow()
			t.Fatalf("initial snapshot: %v", err)
		}
		return conn
	}
	first := connect()
	defer func() { _ = first.CloseNow() }()
	replacement := connect()
	defer func() { _ = replacement.CloseNow() }()
	if err := first.CloseNow(); err != nil {
		t.Fatal(err)
	}
	for {
		var event contracts.ServerEvent
		if err := wsjson.Read(ctx, replacement, &event); err != nil {
			t.Fatal(err)
		}
		if event.Type != "overlay_status" {
			continue
		}
		if event.OverlayView == nil || !event.OverlayView.Connected {
			t.Fatal("old connection marked its active replacement offline")
		}
		break
	}
}
