// Package gamewatch consumes EFT's filesystem output without periodic polling.
package gamewatch

import (
	"bufio"
	"context"
	"io"
	"log"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

type Mode string

const (
	ModePVP       Mode = "pvp"
	ModePVE       Mode = "pve"
	ModePVPSeason Mode = "pvp-season"
)

func ValidMode(mode Mode) bool { return mode == ModePVP || mode == ModePVE || mode == ModePVPSeason }

func ParseMode(raw string) (Mode, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "pve":
		return ModePVE, true
	case "regular", "pvp":
		return ModePVP, true
	case "pvpseason", "pvp-season", "seasonal", "szn":
		return ModePVPSeason, true
	default:
		return "", false
	}
}

type Screenshot struct {
	Filename string
	X, Y, Z  float64
	Heading  float64
}

var screenshotPattern = regexp.MustCompile(`(?i)^\d{4}-\d{2}-\d{2}\[\d{2}-\d{2}\]_?.*?(-?[0-9]+\.[0-9]+), (-?[0-9]+\.[0-9]+), (-?[0-9]+\.[0-9]+)_?(-?[0-9]+\.[0-9]+), (-?[0-9]+\.[0-9]+), (-?[0-9]+\.[0-9]+), (-?[0-9]+\.[0-9]+).*\.png$`)

func ParseScreenshotName(name string) (Screenshot, bool) {
	var out Screenshot
	match := screenshotPattern.FindStringSubmatch(filepath.Base(name))
	if match == nil {
		return out, false
	}
	values := make([]float64, 7)
	for i := range values {
		var err error
		values[i], err = strconv.ParseFloat(match[i+1], 64)
		if err != nil || math.IsNaN(values[i]) || math.IsInf(values[i], 0) {
			return out, false
		}
	}
	// EFT writes the quaternion as rx, ry, rz, rw. The monitor's original
	// yaw conversion uses Unity's z-axis yaw convention.
	// TarkovMonitor passes rx, ry, rz to a helper whose second and third
	// parameters are named z and y respectively; preserve that convention.
	x, z, y, w := values[3], values[4], values[5], values[6]
	out = Screenshot{Filename: filepath.Base(name), X: values[0], Y: values[1], Z: values[2], Heading: math.Atan2(2*(w*z+x*y), 1-2*(y*y+z*z)) * 180 / math.Pi}
	return out, true
}

type LogEvent struct {
	Mode Mode
	Map  string
}

var (
	modePattern    = regexp.MustCompile(`Session mode:\s*([^\s|]+)`)
	scenePattern   = regexp.MustCompile(`scene preset path:\s*(maps/[A-Za-z0-9_]+\.bundle)`)
	sessionPattern = regexp.MustCompile(`(?i)^log_(\d{4}\.\d{1,2}\.\d{1,2}_\d{1,2}-\d{1,2}-\d{1,2})(?:_.*)?$`)
)

func ParseLogLine(line string) (LogEvent, bool) {
	var out LogEvent
	matched := false
	if match := modePattern.FindStringSubmatch(line); match != nil {
		if mode, ok := ParseMode(match[1]); ok {
			out.Mode, matched = mode, true
		}
	}
	if match := scenePattern.FindStringSubmatch(line); match != nil {
		out.Map, matched = strings.TrimSuffix(filepath.Base(match[1]), filepath.Ext(match[1])), true
	}
	return out, matched
}

type Config struct {
	ScreenshotDirectory string
	LogDirectory        string
	DeleteScreenshots   bool
	AutoMapSwitch       bool
}

type Callbacks struct {
	Screenshot func(Screenshot) error
	Log        func(LogEvent)
	Activity   func(kind string, at time.Time)
}

// Monitor owns at most one watcher for the screenshots directory, the log root,
// and the active session. Historical session directories are never watched.
type Monitor struct {
	callbacks Callbacks
	updates   chan Config
	mu        sync.Mutex
	config    Config
}

func New(callbacks Callbacks) *Monitor {
	return &Monitor{callbacks: callbacks, updates: make(chan Config, 1)}
}

func (m *Monitor) Apply(config Config) {
	m.mu.Lock()
	m.config = config
	m.mu.Unlock()
	select {
	case m.updates <- config:
	default:
		select {
		case <-m.updates:
		default:
		}
		m.updates <- config
	}
}

func (m *Monitor) currentConfig() Config {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.config
}

func (m *Monitor) Run(ctx context.Context) {
	config := m.currentConfig()
	var watcher *fsnotify.Watcher
	var watchedScreenshot, watchedLogs, watchedSession string
	readers := map[string]*incrementalReader{}
	defer func() {
		if watcher != nil {
			_ = watcher.Close()
		}
	}()

	reset := func(next Config) {
		if m.callbacks.Activity != nil {
			m.callbacks.Activity("session", time.Now())
		}
		if watcher != nil {
			_ = watcher.Close()
		}
		watcher = nil
		watchedScreenshot, watchedLogs, watchedSession = "", "", ""
		readers = map[string]*incrementalReader{}
		config = next
		w, err := fsnotify.NewWatcher()
		if err != nil {
			log.Printf("game monitor watcher: %v", err)
			return
		}
		watcher = w
		if dir := cleanDirectory(config.ScreenshotDirectory); dir != "" {
			if err := w.Add(dir); err == nil {
				watchedScreenshot = dir
			}
		}
		if dir := cleanDirectory(config.LogDirectory); dir != "" {
			if err := w.Add(dir); err == nil {
				watchedLogs = dir
				watchedSession = newestSession(dir)
				if watchedSession != "" {
					if err := w.Add(watchedSession); err != nil {
						watchedSession = ""
					}
				}
				if watchedSession != "" {
					readApplicationLogs(watchedSession, readers, m.consume, m.callbacks.Activity)
				}
			}
		}
	}
	reset(config)

	for {
		if watcher == nil {
			select {
			case <-ctx.Done():
				return
			case next := <-m.updates:
				reset(next)
			}
			continue
		}
		select {
		case <-ctx.Done():
			return
		case next := <-m.updates:
			reset(next)
		case event, ok := <-watcher.Events:
			if !ok {
				reset(config)
				continue
			}
			eventDir := filepath.Clean(filepath.Dir(event.Name))
			if eventDir == watchedScreenshot && event.Op&(fsnotify.Create|fsnotify.Rename) != 0 {
				m.consumeScreenshot(config, event.Name)
				continue
			}
			if eventDir == watchedLogs && event.Op&(fsnotify.Create|fsnotify.Rename) != 0 {
				next := newestSession(watchedLogs)
				if next != "" && next != watchedSession {
					if watchedSession != "" {
						_ = watcher.Remove(watchedSession)
					}
					if err := watcher.Add(next); err == nil {
						watchedSession = next
						readers = map[string]*incrementalReader{}
						readApplicationLogs(next, readers, m.consume, m.callbacks.Activity)
					}
				}
				continue
			}
			if eventDir == watchedSession && event.Op&(fsnotify.Create|fsnotify.Rename|fsnotify.Write) != 0 {
				if isApplicationLog(event.Name) {
					readApplicationLog(event.Name, readers, m.consume, m.callbacks.Activity)
				}
				continue
			}
		case err, ok := <-watcher.Errors:
			if !ok || err != nil {
				// Overflow/revocation recovery is one rescan and watcher rebuild.
				reset(config)
			}
		}
	}
}

func (m *Monitor) consume(event LogEvent) {
	if m.callbacks.Log != nil {
		m.callbacks.Log(event)
	}
}

func (m *Monitor) consumeScreenshot(config Config, path string) {
	screenshot, ok := ParseScreenshotName(path)
	if !ok || m.callbacks.Screenshot == nil {
		return
	}
	if err := m.callbacks.Screenshot(screenshot); err != nil {
		return
	}
	if config.DeleteScreenshots {
		_ = os.Remove(path)
	}
	if m.callbacks.Activity != nil {
		m.callbacks.Activity("screenshot", time.Now())
	}
}

func cleanDirectory(path string) string {
	if path == "" {
		return ""
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return ""
	}
	if info, err := os.Stat(abs); err != nil || !info.IsDir() {
		return ""
	}
	return filepath.Clean(abs)
}

func newestSession(root string) string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	type item struct {
		path  string
		stamp time.Time
		mod   time.Time
	}
	items := make([]item, 0)
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(strings.ToLower(entry.Name()), "log_") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		stamp := info.ModTime()
		if match := sessionPattern.FindStringSubmatch(entry.Name()); match != nil {
			if parsed, parseErr := time.ParseInLocation("2006.1.2_15-4-5", match[1], time.Local); parseErr == nil {
				stamp = parsed
			}
		}
		items = append(items, item{filepath.Join(root, entry.Name()), stamp, info.ModTime()})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].stamp.After(items[j].stamp) || items[i].stamp.Equal(items[j].stamp) && items[i].mod.After(items[j].mod)
	})
	if len(items) == 0 {
		return ""
	}
	return items[0].path
}

func isApplicationLog(path string) bool {
	name := strings.ToLower(filepath.Base(path))
	return strings.HasSuffix(name, "application.log") || strings.HasSuffix(name, "application_000.log")
}

type incrementalReader struct {
	offset  int64
	pending string
}

func readApplicationLogs(dir string, readers map[string]*incrementalReader, consume func(LogEvent), activity func(string, time.Time)) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		if !entry.IsDir() && isApplicationLog(path) {
			readApplicationLog(path, readers, consume, activity)
		}
	}
}

func readApplicationLog(path string, readers map[string]*incrementalReader, consume func(LogEvent), activity func(string, time.Time)) {
	reader := readers[path]
	if reader == nil {
		reader = &incrementalReader{}
		readers[path] = reader
	}
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return
	}
	if info.Size() < reader.offset {
		reader.offset, reader.pending = 0, ""
	}
	if _, err = file.Seek(reader.offset, io.SeekStart); err != nil {
		return
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return
	}
	reader.offset += int64(len(data))
	reader.pending += string(data)
	scanner := bufio.NewScanner(strings.NewReader(reader.pending))
	lines := make([]string, 0)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if !strings.HasSuffix(reader.pending, "\n") {
		if len(lines) > 0 {
			reader.pending = lines[len(lines)-1]
			lines = lines[:len(lines)-1]
		}
	} else {
		reader.pending = ""
	}
	for _, line := range lines {
		if event, ok := ParseLogLine(strings.TrimSuffix(line, "\r")); ok {
			consume(event)
			if activity != nil {
				activity("log", time.Now())
			}
		}
	}
}
