package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
		if method == http.MethodPut {
			current, err := http.Get(srv.URL + path)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("If-Match", current.Header.Get("ETag"))
			_ = current.Body.Close()
		}
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
	var saved contracts.OverlaySettings
	if err := json.Unmarshal(call("PUT", "/api/overlay-settings", s, 200), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Width != 2048 || saved.Hotkeys.ToggleEdit != "" {
		t.Fatalf("normalization failed: %+v", saved)
	}
	var aggregateSaved contracts.UserSettings
	if err := json.Unmarshal(call("GET", "/api/user-settings", nil, 200), &aggregateSaved); err != nil {
		t.Fatal(err)
	}
	if aggregateSaved.Overlay.Width != 2048 || aggregateSaved.GameMonitor.Mode != "pvp" {
		t.Fatalf("aggregate settings mismatch: %+v", aggregateSaved)
	}
	s.Hotkeys.ToggleEdit = "Ctrl+Ctrl+M"
	call("PUT", "/api/overlay-settings", s, 400)
	s.Hotkeys.ToggleEdit = ""
	s.Width = 1
	aggregate := contracts.UserSettings{SchemaVersion: 1, Overlay: s, GameMonitor: defaultGameMonitorSettings(), Recognition: defaultRecognitionSettings()}
	aggregateData, err := json.Marshal(aggregate)
	if err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(root, "user", "user-settings.json")
	if err = os.WriteFile(settingsPath, aggregateData, 0o600); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(call("GET", "/api/overlay-settings", nil, 200), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Width != 160 {
		t.Fatalf("GET did not normalize disk: %+v", saved)
	}
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
	if err = os.WriteFile(settingsPath, aggregateData, 0o600); err != nil {
		t.Fatal(err)
	}
	position := contracts.ManualPositionUpdate{MapId: "fixture", ScreenshotName: "2026-09-21[12-30]_25.000, 1.000, 75.000_0.000, 0.000, 0.000, 1.000.png"}
	call("POST", "/api/game-monitor/position", position, 200)
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
		if p.MapPosition.X != 25 || p.MapPosition.Y != 25 || p.Heading != 0 {
			t.Fatalf("world projection: %+v", p)
		}
	}
	position.ScreenshotName = "invalid.png"
	call("POST", "/api/game-monitor/position", position, 400)
	req := httptest.NewRequest("GET", "http://localhost/api/overlay/bootstrap", nil)
	req.RemoteAddr = "192.0.2.1:9000"
	out := httptest.NewRecorder()
	handler.ServeHTTP(out, req)
	if out.Code != 403 {
		t.Fatal("bootstrap accepted non-loopback peer")
	}
}

func TestOverlayHotkeyMouseNormalization(t *testing.T) {
	settings := defaultOverlaySettings()
	settings.Hotkeys.ZoomIn = "Alt+Ctrl+WheelUp"
	settings.Hotkeys.ZoomOut = "Ctrl+WheelUp"
	settings.Hotkeys.PanUp = "Alt+Ctrl+Mouse5"
	settings.Hotkeys.PanDown = "Mouse4"
	settings.Hotkeys.PanLeft = "Ctrl+Mouse3"
	if !normalizeHotkeys(&settings.Hotkeys) {
		t.Fatal("valid mouse bindings were rejected")
	}
	if settings.Hotkeys.ZoomIn != "Ctrl+Alt+WheelUp" || settings.Hotkeys.ZoomOut != "Ctrl+WheelUp" {
		t.Fatalf("wheel bindings were not canonicalized: %+v", settings.Hotkeys)
	}
	if settings.Hotkeys.PanUp != "Ctrl+Alt+Mouse5" || settings.Hotkeys.PanDown != "Mouse4" ||
		settings.Hotkeys.PanLeft != "Ctrl+Mouse3" {
		t.Fatalf("mouse button bindings were not canonicalized: %+v", settings.Hotkeys)
	}
	settings.Hotkeys.PanRight = "Ctrl+WheelRight"
	if normalizeHotkeys(&settings.Hotkeys) {
		t.Fatal("invalid wheel token was accepted")
	}
	settings.Hotkeys.PanRight = ""
	settings.Hotkeys.FloorUp = "Mouse6"
	if normalizeHotkeys(&settings.Hotkeys) {
		t.Fatal("unknown mouse button was accepted")
	}
	settings.Hotkeys.FloorUp = ""
	settings.Hotkeys.FloorDown = "Back"
	if normalizeHotkeys(&settings.Hotkeys) {
		t.Fatal("mouse button named after its action was accepted")
	}
	if !validHotkey("") || !validHotkey("A") || !validHotkey("Ctrl+WheelDown") ||
		!validHotkey("Mouse3") || !validHotkey("Ctrl+Mouse4") {
		t.Fatal("supported hotkey form was rejected")
	}
	if validHotkey("Mouse0") || validHotkey("Mouse6") || validHotkey("Back") {
		t.Fatal("unsupported mouse button was accepted")
	}
}

func TestRecognitionResultFromSupersededRunIsIgnored(t *testing.T) {
	_, handler := mapFixture(t)
	started := callLocalJSON(t, handler, http.MethodPost, "/api/recognition/started", contracts.RecognitionStart{RequestId: "newer"})
	if started.Code != http.StatusOK {
		t.Fatalf("start newer recognition: %d %s", started.Code, started.Body.String())
	}
	if response := callLocalJSON(t, handler, http.MethodPost, "/api/recognition/started", contracts.RecognitionStart{RequestId: "latest"}); response.Code != http.StatusOK {
		t.Fatalf("start latest recognition: %d %s", response.Code, response.Body.String())
	}
	stale := callLocalJSON(t, handler, http.MethodPost, "/api/recognition/result", contracts.RecognitionResult{RequestId: "newer", Error: "cancelled"})
	if stale.Code != http.StatusNoContent {
		t.Fatalf("stale recognition result was accepted: %d %s", stale.Code, stale.Body.String())
	}
	current := callLocalJSON(t, handler, http.MethodPost, "/api/recognition/result", contracts.RecognitionResult{RequestId: "latest"})
	if current.Code != http.StatusOK {
		t.Fatalf("current recognition result was rejected: %d %s", current.Code, current.Body.String())
	}
}

func TestRecognitionClearDoesNotCancelNewerRun(t *testing.T) {
	_, handler := mapFixture(t)
	if response := callLocalJSON(t, handler, http.MethodPost, "/api/recognition/started", contracts.RecognitionStart{RequestId: "first"}); response.Code != http.StatusOK {
		t.Fatalf("start first recognition: %d", response.Code)
	}
	if response := callLocalJSON(t, handler, http.MethodPost, "/api/recognition/started", contracts.RecognitionStart{RequestId: "second"}); response.Code != http.StatusOK {
		t.Fatalf("start second recognition: %d", response.Code)
	}
	clear := localCall(handler, http.MethodDelete, "/api/recognition-result?requestId=first", nil)
	if clear.Code != http.StatusNoContent {
		t.Fatalf("stale clear failed: %d", clear.Code)
	}
	if result := callLocalJSON(t, handler, http.MethodPost, "/api/recognition/result", contracts.RecognitionResult{RequestId: "second"}); result.Code != http.StatusOK {
		t.Fatalf("newer recognition was cleared: %d", result.Code)
	}
}

func TestRecognitionCandidatesKeepStableTopKOrder(t *testing.T) {
	catalog := contracts.ItemsCatalog{Items: []contracts.ItemsCatalogItem{
		{Id: "zulu", Name: "Zulu", ShortName: "same"},
		{Id: "alpha", Name: "Alpha", ShortName: "same"},
		{Id: "same-first", Name: "Same", ShortName: "same"},
		{Id: "same-second", Name: "Same", ShortName: "same"},
	}}
	settings := contracts.RecognitionSettings{CandidateLimit: 3, OcrMinLength: 2, NameSimilarity: 1}
	got := recognitionCandidates(catalog, []string{"same", "same"}, settings)
	if len(got) != 2 || len(got[0]) != 3 || len(got[1]) != 3 {
		t.Fatalf("unexpected candidate groups: %#v", got)
	}
	wantIDs := []string{"alpha", "same-first", "same-second"}
	for index, want := range wantIDs {
		if got[0][index].Id != want || got[1][index].Id != want {
			t.Fatalf("candidate order = %#v, want %v", got[0], wantIDs)
		}
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

func TestOverlapDedupRevisionAndLRU(t *testing.T) {
	dedup := newOverlapDedup()
	key := overlapKey{mapID: "map", basemap: "svg", revision: 1, firstID: "a", secondID: "b"}
	if !dedup.firstOccurrence(key) || dedup.firstOccurrence(key) {
		t.Fatal("duplicate overlap was not deduplicated")
	}
	if !dedup.firstOccurrence(overlapKey{mapID: "map", basemap: "tiles", revision: 1, firstID: "a", secondID: "b"}) {
		t.Fatal("overlap dedup crossed basemaps")
	}
	dedup.clearMapRevision("map", "svg", 2)
	if !dedup.firstOccurrence(key) {
		t.Fatal("old revision was not cleared")
	}
	for i := 0; i < 220; i++ {
		if !dedup.firstOccurrence(overlapKey{mapID: "map", revision: 2, firstID: "first", secondID: fmt.Sprint(i)}) {
			t.Fatalf("unexpected duplicate at %d", i)
		}
	}
	if got := dedup.order.Len(); got > 200 {
		t.Fatalf("LRU grew beyond limit: %d", got)
	}
}

// The overlay applies the project's shared owner-visibility rule, so its bootstrap has to point at
// the same owner list file the dashboard writes.
func TestBootstrapCarriesOwnerListPath(t *testing.T) {
	root, handler := mapFixture(t)
	if response := callLocalJSON(t, handler, http.MethodPut, "/api/user-settings", defaultUserSettings()); response.Code != http.StatusOK {
		t.Fatalf("save settings: %d %s", response.Code, response.Body.String())
	}
	response := callLocalJSON(t, handler, http.MethodGet, "/api/overlay/bootstrap", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("bootstrap: %d %s", response.Code, response.Body.String())
	}
	var bootstrap contracts.OverlayBootstrap
	if err := json.Unmarshal(response.Body.Bytes(), &bootstrap); err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "user", "marker-preferences.json"); bootstrap.MarkerPreferencesFile != want {
		t.Fatalf("marker preferences file: %q want %q", bootstrap.MarkerPreferencesFile, want)
	}
}
