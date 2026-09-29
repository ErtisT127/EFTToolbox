package server

import (
	"bytes"
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
)

// TestMarkerPreferencesSyncToCast locks the cast alignment contract: saving owner visibility
// publishes marker_preferences_changed to cast subscribers, and the mobile snapshot carries the
// persisted lists so a freshly opened cast page renders the same filter state as the dashboard.
func TestMarkerPreferencesSyncToCast(t *testing.T) {
	root := t.TempDir()
	hub := &overlayHub{store: &mapStore{root: root, files: &VersionedFileStore{root: root}}, status: contracts.Status{ProtocolVersion: "1"}, players: map[string]contracts.PlayerState{}, clients: map[chan contracts.ServerEvent]bool{}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	hub.mobile = newMobileManager(ctx, http.FS(fstest.MapFS{}), hub)
	mobile := hub.mobile

	prefsPath := filepath.Join(root, "user", "marker-preferences.json")
	if err := os.MkdirAll(filepath.Dir(prefsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	value := contracts.MarkerPreferences{SchemaVersion: contracts.ContractSchemaVersion, HiddenOwners: []string{"aaaaaaaaaaaaaaaa"}, ShownOwners: []string{}}
	if data, err := json.Marshal(value); err != nil || os.WriteFile(prefsPath, data, 0o644) != nil {
		t.Fatalf("seed marker preferences: %v", err)
	}

	subscriber := make(chan mobilePacket, 8)
	mobile.mu.Lock()
	mobile.subscribers[subscriber] = struct{}{}
	mobile.mu.Unlock()

	hub.markerPreferencesChanged(value, "op-1")
	select {
	case packet := <-subscriber:
		if packet.event != "marker_preferences_changed" {
			t.Fatalf("event %q, want marker_preferences_changed", packet.event)
		}
		var event contracts.ServerEvent
		if json.Unmarshal(packet.data, &event) != nil || event.MarkerPreferences == nil {
			t.Fatalf("marker preferences payload missing: %s", packet.data)
		}
		if len(event.MarkerPreferences.HiddenOwners) != 1 || event.MarkerPreferences.HiddenOwners[0] != "aaaaaaaaaaaaaaaa" {
			t.Fatalf("hidden owners: %v", event.MarkerPreferences.HiddenOwners)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no cast event within 2s")
	}

	snapshot := hub.mobileSnapshot()
	if snapshot.MarkerPreferences == nil || len(snapshot.MarkerPreferences.HiddenOwners) != 1 || snapshot.MarkerPreferences.HiddenOwners[0] != "aaaaaaaaaaaaaaaa" {
		t.Fatalf("snapshot marker preferences: %+v", snapshot.MarkerPreferences)
	}
}

// TestLanguageSyncsToCast locks the cast language contract: the phone cannot read user settings, so
// the interface language must reach it through the snapshot, and changing it must push a fresh
// snapshot to an already-open cast page instead of waiting for a reconnect.
func TestLanguageSyncsToCast(t *testing.T) {
	root := t.TempDir()
	hub := &overlayHub{store: &mapStore{root: root, files: &VersionedFileStore{root: root}}, status: contracts.Status{ProtocolVersion: "1"}, players: map[string]contracts.PlayerState{}, clients: map[chan contracts.ServerEvent]bool{}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	hub.mobile = newMobileManager(ctx, http.FS(fstest.MapFS{}), hub)
	mobile := hub.mobile

	subscriber := make(chan mobilePacket, 8)
	mobile.mu.Lock()
	mobile.subscribers[subscriber] = struct{}{}
	mobile.mu.Unlock()

	if _, _, _, err := hub.updateUserSettings("", func(value *contracts.UserSettings) error {
		value.Language = "en-US"
		return nil
	}, false, false, nil, false, false); err != nil {
		t.Fatalf("update language: %v", err)
	}

	select {
	case packet := <-subscriber:
		if packet.event != "snapshot" {
			t.Fatalf("event %q, want snapshot", packet.event)
		}
		var event contracts.ServerEvent
		if json.Unmarshal(packet.data, &event) != nil || event.Language == nil || *event.Language != "en-US" {
			t.Fatalf("language payload missing: %s", packet.data)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no cast event within 2s")
	}

	if snapshot := hub.mobileSnapshot(); snapshot.Language == nil || *snapshot.Language != "en-US" {
		t.Fatalf("snapshot language: %+v", snapshot.Language)
	}
}

// TestCastSessionContextSyncsToCast locks the owner-visibility inputs the cast needs: the local
// owner id and the roster on the snapshot (so a phone with no game running still shows its own
// markers), the owner lists, and the live events that keep them current.
func TestCastSessionContextSyncsToCast(t *testing.T) {
	root := t.TempDir()
	hub := &overlayHub{store: &mapStore{root: root, files: &VersionedFileStore{root: root}}, status: contracts.Status{ProtocolVersion: "1"}, players: map[string]contracts.PlayerState{}, clients: map[chan contracts.ServerEvent]bool{}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	hub.mobile = newMobileManager(ctx, http.FS(fstest.MapFS{}), hub)
	hub.multiplayer = newMultiplayerManager(ctx, hub)
	mobile := hub.mobile

	ownersPath := filepath.Join(root, "user", "marker-preferences.json")
	if err := os.MkdirAll(filepath.Dir(ownersPath), 0o755); err != nil {
		t.Fatal(err)
	}
	owners := contracts.MarkerPreferences{SchemaVersion: contracts.ContractSchemaVersion, HiddenOwners: []string{"aaaaaaaaaaaaaaaa"}, ShownOwners: []string{}}
	if data, err := json.Marshal(owners); err != nil || os.WriteFile(ownersPath, data, 0o644) != nil {
		t.Fatalf("seed owner lists: %v", err)
	}

	snapshot := hub.mobileSnapshot()
	if snapshot.OwnerId == nil || *snapshot.OwnerId != hub.multiplayer.selfID() {
		t.Fatalf("snapshot owner id: %+v", snapshot.OwnerId)
	}
	// No room is open here, so the roster is empty and the phone falls back to "own markers only".
	if snapshot.MultiplayerStatus == nil || snapshot.MultiplayerStatus.Enabled || (snapshot.MultiplayerStatus.Members != nil && len(*snapshot.MultiplayerStatus.Members) != 0) {
		t.Fatalf("snapshot multiplayer status: %+v", snapshot.MultiplayerStatus)
	}
	if snapshot.MarkerPreferences == nil || len(snapshot.MarkerPreferences.HiddenOwners) != 1 {
		t.Fatalf("snapshot owner lists: %+v", snapshot.MarkerPreferences)
	}

	subscriber := make(chan mobilePacket, 8)
	mobile.mu.Lock()
	mobile.subscribers[subscriber] = struct{}{}
	mobile.mu.Unlock()

	status := contracts.MultiplayerStatus{Enabled: false}
	hub.mu.Lock()
	hub.publish(contracts.ServerEvent{Type: "resources_changed"})
	hub.publish(contracts.ServerEvent{Type: "multiplayer_changed", MultiplayerStatus: &status})
	hub.mu.Unlock()

	seen := map[string]bool{}
	for range 2 {
		select {
		case packet := <-subscriber:
			seen[packet.event] = true
		case <-time.After(2 * time.Second):
			t.Fatalf("no cast event within 2s, seen=%v", seen)
		}
	}
	if !seen["resources_changed"] || !seen["multiplayer_changed"] {
		t.Fatalf("cast missed reload/roster events, seen=%v", seen)
	}
}

// TestCastSurfaceRejectsWrites locks the read-only cast contract: the LAN handler refuses every
// non-GET method before the mux ever sees it, so a phone holding a valid cast token cannot write
// map data, preferences or logs.
func TestCastSurfaceRejectsWrites(t *testing.T) {
	root := t.TempDir()
	hub := &overlayHub{store: &mapStore{root: root, files: &VersionedFileStore{root: root}}, status: contracts.Status{ProtocolVersion: "1"}, players: map[string]contracts.PlayerState{}, clients: map[chan contracts.ServerEvent]bool{}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	hub.mobile = newMobileManager(ctx, http.FS(fstest.MapFS{}), hub)
	hub.mobileBase = http.NewServeMux()
	mobile := hub.mobile
	mobile.mu.Lock()
	mobile.enabled = true
	mobile.token = "token"
	mobile.mu.Unlock()

	annotationPath := filepath.Join(root, "user", "modes", "pvp", "maps", "fixture.annotations.json")
	if err := os.MkdirAll(filepath.Dir(annotationPath), 0o755); err != nil {
		t.Fatal(err)
	}
	seed := []byte(`{"schemaVersion":1,"items":[]}`)
	if err := os.WriteFile(annotationPath, seed, 0o644); err != nil {
		t.Fatal(err)
	}

	lan := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path+"?token=token", strings.NewReader(body))
		request.RemoteAddr, request.Host = "192.168.1.50:55555", "192.168.1.33:47831"
		recorder := httptest.NewRecorder()
		mobile.serveLAN(recorder, request)
		return recorder
	}
	for _, request := range []struct{ method, path, body string }{
		{http.MethodPut, "/api/maps/fixture/annotations", `{"schemaVersion":1,"items":[]}`},
		{http.MethodPut, "/api/map-preferences", `{"schemaVersion":1,"selectedMap":"fixture","maps":[],"stickerUsage":[]}`},
		{http.MethodPut, "/api/marker-preferences", `{"schemaVersion":1,"hiddenOwners":[],"shownOwners":[]}`},
		{http.MethodPut, "/api/user-settings", `{}`},
		{http.MethodPost, "/api/logs", `{}`},
		{http.MethodDelete, "/api/recognition-result", ""},
	} {
		recorder := lan(request.method, request.path, request.body)
		if recorder.Code != http.StatusMethodNotAllowed || !strings.Contains(recorder.Body.String(), "mobile_method_not_allowed") {
			t.Fatalf("%s %s: %d %s", request.method, request.path, recorder.Code, recorder.Body.String())
		}
	}
	if data, err := os.ReadFile(annotationPath); err != nil || !bytes.Equal(data, seed) {
		t.Fatalf("a cast write reached the annotation file: %q %v", data, err)
	}
	// Reads still pass the method gate (the empty mux answers 404, never 405).
	if recorder := lan(http.MethodGet, "/api/maps/fixture/annotations", ""); recorder.Code == http.StatusMethodNotAllowed {
		t.Fatalf("a read was refused as a write: %s", recorder.Body.String())
	}
}
