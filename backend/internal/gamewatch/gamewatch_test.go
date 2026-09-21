package gamewatch

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseScreenshotName(t *testing.T) {
	value, ok := ParseScreenshotName("2026-09-21[12-30]_12.50, 3.25, -8.00_0.00, 0.7071, 0.00, 0.7071 (1).png")
	if !ok {
		t.Fatal("valid EFT screenshot name was rejected")
	}
	if value.X != 12.5 || value.Y != 3.25 || value.Z != -8 {
		t.Fatalf("coordinates = %#v", value)
	}
	if value.Heading < 89 || value.Heading > 91 {
		t.Fatalf("value = %#v, want heading about 90 degrees", value)
	}
}

func TestParseModeAndLogLine(t *testing.T) {
	for raw, want := range map[string]Mode{"Pve": ModePVE, "Regular": ModePVP, "PvpSeason": ModePVPSeason} {
		if got, ok := ParseMode(raw); !ok || got != want {
			t.Fatalf("ParseMode(%q) = %q, %v", raw, got, ok)
		}
	}
	event, ok := ParseLogLine("2026-09-18 21:32:05.197|1.1.5.1.47473|Info|application|Session mode: Pve")
	if !ok || event.Mode != ModePVE {
		t.Fatalf("mode event = %#v, %v", event, ok)
	}
	event, ok = ParseLogLine("2026-09-18 21:35:30.141|1.1.5.1.47473|Info|application|scene preset path:maps/factory_day_preset.bundle rcid:factory_day.scenespreset.asset")
	if !ok || event.Map != "factory_day_preset" {
		t.Fatalf("log event = %#v, %v", event, ok)
	}
}

func TestNewestSessionUsesTimestampWithVersionSuffix(t *testing.T) {
	root := t.TempDir()
	older := filepath.Join(root, "log_2026.09.18_9-31-54_1.1.5.1.47473")
	newer := filepath.Join(root, "log_2026.09.18_21-31-54_1.1.5.1.47473")
	for _, directory := range []string{older, newer} {
		if err := os.Mkdir(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Directory mtimes can change after creation; session selection follows the timestamp in EFT's name.
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(older, future, future); err != nil {
		t.Fatal(err)
	}
	if got := newestSession(root); got != newer {
		t.Fatalf("newestSession() = %q, want %q", got, newer)
	}
}

func TestApplicationLogNamesMatchEFTSessionPrefix(t *testing.T) {
	for _, name := range []string{
		"application.log",
		"application_000.log",
		"2026.09.18_21-31-54_1.1.5.1.47473 application_000.log",
	} {
		if !isApplicationLog(name) {
			t.Fatalf("isApplicationLog(%q) = false", name)
		}
	}
	if isApplicationLog("2026.09.18_21-31-54_1.1.5.1.47473 output_000.log") {
		t.Fatal("output log matched as application log")
	}
}

func TestMonitorHandlesChildFileEvents(t *testing.T) {
	root := t.TempDir()
	screenshots := filepath.Join(root, "screenshots")
	logs := filepath.Join(root, "logs")
	session := filepath.Join(logs, "log_2026.09.21_12-34-00")
	for _, directory := range []string{screenshots, session} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	events := make(chan string, 2)
	monitor := New(Callbacks{
		Screenshot: func(Screenshot) error {
			events <- "screenshot"
			return nil
		},
		Log: func(LogEvent) { events <- "log" },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	monitor.Apply(Config{ScreenshotDirectory: screenshots, LogDirectory: logs})
	go monitor.Run(ctx)

	// The watcher setup is synchronous inside Run; this only gives the goroutine a chance to enter it
	// before the child events are created.
	time.Sleep(50 * time.Millisecond)
	if err := os.WriteFile(filepath.Join(session, "application.log"), []byte("Session mode: PVE\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(screenshots, "2026-09-21[12-34]_0.000, 0.000, 0.000_0.000, 0.000, 0.000, 1.000.png"),
		[]byte{},
		0o644,
	); err != nil {
		t.Fatal(err)
	}

	seen := map[string]bool{}
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	for len(seen) < 2 {
		select {
		case kind := <-events:
			seen[kind] = true
		case <-deadline.C:
			t.Fatalf("monitor events = %#v, want log and screenshot", seen)
		}
	}
}
