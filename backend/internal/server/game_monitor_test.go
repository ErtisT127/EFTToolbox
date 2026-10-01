package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"efttoolbox/backend/internal/gamewatch"
	contracts "efttoolbox/contracts"
)

func gameMonitorFixture(t *testing.T) (*overlayHub, chan contracts.ServerEvent) {
	t.Helper()
	_, store, hub := mapStoreFixture(t)
	m := contracts.MapData{SchemaVersion: 1, Id: "other", Name: "Other", DefaultFloor: "ground", Projection: contracts.Projection{ViewBox: []float64{0, 0, 100, 100}, Bounds: []contracts.WorldXZ{{X: 0, Z: 0}, {X: 100, Z: 100}}}, Floors: []contracts.Floor{{Id: "ground", Name: "Ground", SvgGroups: []string{"ground"}}}, Categories: []contracts.Category{}, Markers: []contracts.BuiltinMarker{}, Tasks: []contracts.MapTask{}, Warnings: []string{}}
	data, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(store.repository().root, "maps", "other_zh.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	locations := map[string]string{"bigmap": "fixture", "ground-zero-21": "groundzero", "Sandbox": "groundzero"}
	data, _ = json.Marshal(locations)
	if err := os.WriteFile(filepath.Join(store.repository().root, "locations.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	hub.mu.Lock()
	hub.monitorSettings = contracts.GameMonitorSettings{SchemaVersion: contracts.ContractSchemaVersion, Mode: "pvp", AutoMapSwitch: true}
	hub.monitorStatus = contracts.GameMonitorStatus{SchemaVersion: contracts.ContractSchemaVersion, Mode: "pvp"}
	hub.appliedMapID = "other"
	hub.monitorStatus.MapId = "other"
	hub.sessionGeneration = 1
	hub.mu.Unlock()
	events := make(chan contracts.ServerEvent, 16)
	hub.clients[events] = true
	return hub, events
}

func TestGameMonitorResolvesVariantToInternalMapID(t *testing.T) {
	hub, _ := gameMonitorFixture(t)
	for _, name := range []string{"ground-zero-21", "sandbox_high_preset", "sandbox_start_preset"} {
		if got := hub.resolveLocationForMode(name, "pvp"); got != "groundzero" {
			t.Fatalf("variant %q resolved to %q, want internal map id groundzero", name, got)
		}
	}
}

func waitForMapChanged(t *testing.T, events chan contracts.ServerEvent) contracts.ServerEvent {
	t.Helper()
	select {
	case event := <-events:
		if event.Type != "map_changed" {
			return waitForMapChanged(t, events)
		}
		return event
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for map_changed event")
		return contracts.ServerEvent{}
	}
}

func drainEvents(events chan contracts.ServerEvent) {
	for {
		select {
		case <-events:
		default:
			return
		}
	}
}

func TestGameMonitorPendingMapConsumedByNextPosition(t *testing.T) {
	hub, events := gameMonitorFixture(t)
	position := gamewatch.Screenshot{Filename: "screenshot", X: 10, Y: 0, Z: 10}

	// Log detection activates the pending map through the locations alias.
	hub.acceptLog(gamewatch.LogEvent{Mode: gamewatch.ModePVP, Map: "bigmap", Generation: 1})
	if hub.pendingMap != "fixture" {
		t.Fatalf("pendingMap = %q, want fixture", hub.pendingMap)
	}

	// Session and configuration resets must not drop the pending map.
	hub.monitorSessionChanged(2)
	if hub.pendingMap != "fixture" || hub.detectedMapID != "fixture" {
		t.Fatalf("pending state lost on session change: pending=%q detected=%q", hub.pendingMap, hub.detectedMapID)
	}

	// The next position update applies the detected map and keeps it as the target.
	if err := hub.acceptScreenshot(position); err != nil {
		t.Fatalf("acceptScreenshot: %v", err)
	}
	if hub.appliedMapID != "fixture" || hub.monitorStatus.MapId != "fixture" {
		t.Fatalf("appliedMapID = %q status = %q, want fixture", hub.appliedMapID, hub.monitorStatus.MapId)
	}
	if hub.pendingMap != "fixture" {
		t.Fatalf("pendingMap = %q, want sticky fixture", hub.pendingMap)
	}
	waitForMapChanged(t, events)
	if got := hub.normalizeDetectedMapPreference("other"); got != "other" {
		t.Fatalf("manual map preference normalized to %q, want other", got)
	}

	// A manual selection may move away, but the next position update switches back.
	hub.preferencesChanged(contracts.Preferences{SchemaVersion: contracts.ContractSchemaVersion}, "other", "")
	if hub.appliedMapID != "other" {
		t.Fatalf("appliedMapID = %q, want other", hub.appliedMapID)
	}
	drainEvents(events)
	if err := hub.acceptScreenshot(position); err != nil {
		t.Fatalf("acceptScreenshot: %v", err)
	}
	if hub.pendingMap != "fixture" || hub.appliedMapID != "fixture" {
		t.Fatalf("pending = %q applied = %q, want sticky fixture and switch back", hub.pendingMap, hub.appliedMapID)
	}
	waitForMapChanged(t, events)
}

func TestGameMonitorPositionDoesNotRewriteAppliedMap(t *testing.T) {
	hub, _ := gameMonitorFixture(t)
	position := gamewatch.Screenshot{Filename: "screenshot", X: 10, Y: 0, Z: 10}
	hub.acceptLog(gamewatch.LogEvent{Mode: gamewatch.ModePVP, Map: "bigmap", Generation: 1})
	if err := hub.acceptScreenshot(position); err != nil {
		t.Fatalf("initial acceptScreenshot: %v", err)
	}

	statePath := hub.store.userPath("game-monitor-state.json")
	baseline := time.Unix(1, 0)
	if err := os.Chtimes(statePath, baseline, baseline); err != nil {
		t.Fatalf("set state mtime: %v", err)
	}
	if err := hub.acceptScreenshot(position); err != nil {
		t.Fatalf("repeat acceptScreenshot: %v", err)
	}
	info, err := os.Stat(statePath)
	if err != nil {
		t.Fatalf("stat unchanged state: %v", err)
	}
	if !info.ModTime().Equal(baseline) {
		t.Fatalf("same applied map rewrote state: mtime=%v, want %v", info.ModTime(), baseline)
	}

	hub.preferencesChanged(contracts.Preferences{SchemaVersion: contracts.ContractSchemaVersion}, "other", "")
	info, err = os.Stat(statePath)
	if err != nil {
		t.Fatalf("stat changed state: %v", err)
	}
	if info.ModTime().Equal(baseline) {
		t.Fatal("changed applied map did not persist state")
	}
}

func TestGameMonitorManualModeChangeIsNotBlockedAfterDetection(t *testing.T) {
	_, _, hub := mapStoreFixture(t)
	hub.monitorSettings = contracts.GameMonitorSettings{SchemaVersion: contracts.ContractSchemaVersion, Mode: "pve"}

	manual := contracts.GameMonitorSettings{SchemaVersion: contracts.ContractSchemaVersion, Mode: "pvp"}
	if got := hub.normalizeDetectedModePreference(manual); got.Mode != "pvp" {
		t.Fatalf("manual mode normalized to %q, want pvp", got.Mode)
	}
}
