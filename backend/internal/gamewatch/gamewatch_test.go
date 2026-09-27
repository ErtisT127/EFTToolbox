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
	value, ok = ParseScreenshotName("4.85, 5.16, 36.42_0.08595, -0.66457, 0.07868, 0.73808")
	if !ok || value.X != 4.85 || value.Y != 5.16 || value.Z != 36.42 {
		t.Fatalf("coordinate fragment = %#v, %v", value, ok)
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
	if err := os.WriteFile(filepath.Join(session, "application.log"), nil, 0o644); err != nil {
		t.Fatal(err)
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

func TestMonitorDoesNotReplayExistingScreenshot(t *testing.T) {
	root := t.TempDir()
	screenshots := filepath.Join(root, "screenshots")
	logs := filepath.Join(root, "logs")
	if err := os.MkdirAll(screenshots, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	historical := filepath.Join(screenshots, "2026-09-21[12-34]_0.000, 0.000, 0.000_0.000, 0.000, 0.000, 1.000.png")
	if err := os.WriteFile(historical, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	events := make(chan struct{}, 2)
	monitor := New(Callbacks{Screenshot: func(Screenshot) error {
		events <- struct{}{}
		return nil
	}})
	monitor.Apply(Config{ScreenshotDirectory: screenshots, LogDirectory: logs})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go monitor.Run(ctx)

	select {
	case <-events:
		t.Fatal("historical screenshot was replayed")
	case <-time.After(400 * time.Millisecond):
	}
	current := filepath.Join(screenshots, "2026-09-21[12-35]_1.000, 0.000, 0.000_0.000, 0.000, 0.000, 1.000.png")
	if err := os.WriteFile(current, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	select {
	case <-events:
	case <-time.After(2 * time.Second):
		t.Fatal("new screenshot was not observed")
	}
}

func TestMonitorIgnoresWriteForExistingScreenshot(t *testing.T) {
	root := t.TempDir()
	screenshots := filepath.Join(root, "screenshots")
	logs := filepath.Join(root, "logs")
	if err := os.MkdirAll(screenshots, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(screenshots, "2026-09-21[12-36]_1.000, 0.000, 0.000_0.000, 0.000, 0.000, 1.000.png")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	events := make(chan struct{}, 1)
	monitor := New(Callbacks{Screenshot: func(Screenshot) error {
		events <- struct{}{}
		return nil
	}})
	monitor.Apply(Config{ScreenshotDirectory: screenshots, LogDirectory: logs})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go monitor.Run(ctx)
	time.Sleep(100 * time.Millisecond)
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.WriteString("ignored")
	_ = file.Close()
	select {
	case <-events:
		t.Fatal("write event triggered screenshot processing")
	case <-time.After(500 * time.Millisecond):
	}
}

func TestMonitorRecoversLatestStateOnStartup(t *testing.T) {
	root := t.TempDir()
	screenshots := filepath.Join(root, "screenshots")
	logs := filepath.Join(root, "logs")
	session := filepath.Join(logs, "log_2026.09.21_12-34-00")
	if err := os.MkdirAll(session, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(screenshots, 0o755); err != nil {
		t.Fatal(err)
	}
	application := filepath.Join(session, "application.log")
	if err := os.WriteFile(application, []byte("Session mode: PVE\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	events := make(chan LogEvent, 2)
	monitor := New(Callbacks{Log: func(event LogEvent) { events <- event }})
	monitor.Apply(Config{ScreenshotDirectory: screenshots, LogDirectory: logs})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go monitor.Run(ctx)

	select {
	case event := <-events:
		if !event.InitialRead || event.Mode != ModePVE {
			t.Fatalf("recovered event = %#v, want initial PVE event", event)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("latest state was not recovered")
	}

}

func TestMonitorSwitchesToNewSession(t *testing.T) {
	root := t.TempDir()
	screenshots := filepath.Join(root, "screenshots")
	logs := filepath.Join(root, "logs")
	oldSession := filepath.Join(logs, "log_2026.09.21_23-23-44_1.1.5.1.47510")
	if err := os.MkdirAll(oldSession, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(screenshots, 0o755); err != nil {
		t.Fatal(err)
	}
	oldLog := filepath.Join(oldSession, "application.log")
	if err := os.WriteFile(oldLog, []byte("Session mode: PVE\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	events := make(chan LogEvent, 2)
	monitor := New(Callbacks{Log: func(event LogEvent) { events <- event }})
	monitor.Apply(Config{ScreenshotDirectory: screenshots, LogDirectory: logs})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go monitor.Run(ctx)
	time.Sleep(100 * time.Millisecond)

	newSession := filepath.Join(logs, "log_2026.09.22_0-15-50_1.1.5.1.47510")
	if err := os.MkdirAll(newSession, 0o755); err != nil {
		t.Fatal(err)
	}
	newLog := filepath.Join(newSession, "application.log")
	if err := os.WriteFile(newLog, []byte("Session mode: PVE\nscene preset path:maps/factory_day_preset.bundle\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	seenMap := false
	for !seenMap {
		select {
		case event := <-events:
			if event.Map == "factory_day_preset" {
				seenMap = true
			}
		case <-deadline.C:
			t.Fatal("new session log was not replayed")
		}
	}
}
