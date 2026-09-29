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
	locations := map[string]string{"bigmap": "fixture"}
	data, _ = json.Marshal(locations)
	if err := os.WriteFile(filepath.Join(store.repository().root, "locations.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	hub.mu.Lock()
	hub.monitorSettings = contracts.GameMonitorSettings{SchemaVersion: contracts.ContractSchemaVersion, Mode: "pvp", AutoMapSwitch: true}
	hub.monitorStatus = contracts.GameMonitorStatus{SchemaVersion: contracts.ContractSchemaVersion, Mode: "pvp"}
	hub.sessionGeneration = 1
	hub.mu.Unlock()
	events := make(chan contracts.ServerEvent, 16)
	hub.clients[events] = true
	return hub, events
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

	// The next position update applies the map exactly once.
	if err := hub.acceptScreenshot(position); err != nil {
		t.Fatalf("acceptScreenshot: %v", err)
	}
	if hub.appliedMapID != "fixture" || hub.monitorStatus.MapId != "fixture" {
		t.Fatalf("appliedMapID = %q status = %q, want fixture", hub.appliedMapID, hub.monitorStatus.MapId)
	}
	if hub.pendingMap != "" {
		t.Fatalf("pendingMap = %q, want consumed", hub.pendingMap)
	}
	waitForMapChanged(t, events)

	// Re-detecting the already applied map consumes silently.
	hub.acceptLog(gamewatch.LogEvent{Mode: gamewatch.ModePVP, Map: "bigmap", Generation: 2})
	if hub.pendingMap != "fixture" {
		t.Fatalf("pendingMap = %q, want fixture", hub.pendingMap)
	}
	drainEvents(events)
	if err := hub.acceptScreenshot(position); err != nil {
		t.Fatalf("acceptScreenshot: %v", err)
	}
	if hub.pendingMap != "" || hub.appliedMapID != "fixture" {
		t.Fatalf("pending = %q applied = %q, want consumed without switching", hub.pendingMap, hub.appliedMapID)
	}
	select {
	case event := <-events:
		if event.Type == "map_changed" {
			t.Fatal("map_changed republished for the already applied map")
		}
	default:
	}

	// Manual map selection updates the applied map without a map_changed event.
	drainEvents(events)
	hub.preferencesChanged(contracts.Preferences{SchemaVersion: contracts.ContractSchemaVersion}, "other", "")
	if hub.appliedMapID != "other" || hub.monitorStatus.MapId != "other" {
		t.Fatalf("appliedMapID = %q status = %q, want other", hub.appliedMapID, hub.monitorStatus.MapId)
	}
	select {
	case event := <-events:
		if event.Type == "map_changed" {
			t.Fatal("map_changed republished for a manual selection")
		}
	default:
	}
}
