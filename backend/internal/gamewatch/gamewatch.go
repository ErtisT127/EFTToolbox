// Package gamewatch consumes EFT's filesystem output through polling tails and
// a single coordinator loop.
package gamewatch

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
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
	"github.com/nchizhov/tail"
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

var screenshotPattern = regexp.MustCompile(`([+-]?[0-9]+[.]?[0-9]*)\s*,\s*([+-]?[0-9]+[.]?[0-9]*)\s*,\s*([+-]?[0-9]+[.]?[0-9]*)\s*_\s*([+-]?[0-9]+[.]?[0-9]*)\s*,\s*([+-]?[0-9]+[.]?[0-9]*)\s*,\s*([+-]?[0-9]+[.]?[0-9]*)\s*,\s*([+-]?[0-9]+[.]?[0-9]*)`)

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
	Mode        Mode
	Map         string
	InitialRead bool
	Generation  uint64
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
	Diagnostic     func(level, event, message string)
	Screenshot     func(Screenshot) error
	Log            func(LogEvent)
	SessionChanged func(generation uint64)
	Activity       func(kind string, at time.Time)
}

type TailLine struct {
	Generation uint64
	Path       string
	Text       string
	Err        error
}

type tailHandle struct {
	value *tail.Tail
	stop  chan struct{}
}

const (
	coordinatorInterval = 250 * time.Millisecond
	rootScanTicks       = 20
	largeLogThreshold   = 50 << 20
	reverseChunkSize    = 64 << 10
)

// Monitor coordinates all filesystem access from one goroutine. Log contents are
// tailed with polling so Windows directory notifications are not part of the
// correctness path.
type Monitor struct {
	callbacks Callbacks
	updates   chan Config
	mu        sync.Mutex
	config    Config
}

func (m *Monitor) diagnostic(level, event, format string, args ...any) {
	if m.callbacks.Diagnostic != nil {
		m.callbacks.Diagnostic(level, event, fmt.Sprintf(format, args...))
	}
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
	lines := make(chan TailLine, 4096)
	tails := map[string]tailHandle{}
	var screenshotWatcher *fsnotify.Watcher
	var screenshotEvents <-chan fsnotify.Event
	var screenshotErrors <-chan error
	var screenshotDirectory string
	pendingDelete := make([]string, 0)
	deleteOverflowLogged := false
	deleteFailureLogged := false
	var generation uint64
	var logRoot, session, activeApplication string
	var rootModTime time.Time
	tick := 0

	drainScreenshotChannels := func(events <-chan fsnotify.Event, errors <-chan error) {
		for events != nil || errors != nil {
			select {
			case _, ok := <-events:
				if !ok {
					events = nil
				}
			case _, ok := <-errors:
				if !ok {
					errors = nil
				}
			default:
				return
			}
		}
	}

	stopScreenshotWatcher := func() {
		if screenshotWatcher == nil {
			return
		}
		oldEvents, oldErrors := screenshotEvents, screenshotErrors
		_ = screenshotWatcher.Close()
		drainScreenshotChannels(oldEvents, oldErrors)
		screenshotWatcher = nil
		screenshotEvents = nil
		screenshotErrors = nil
		screenshotDirectory = ""
	}

	startScreenshotWatcher := func(directory string) {
		stopScreenshotWatcher()
		directory = cleanDirectory(directory)
		if directory == "" {
			return
		}
		watcher, err := fsnotify.NewWatcher()
		if err != nil {
			m.diagnostic("error", "screenshot_watch_failed", "Create watcher: %v", err)
			return
		}
		if err := watcher.Add(directory); err != nil {
			_ = watcher.Close()
			m.diagnostic("error", "screenshot_watch_failed", "Watch directory %q: %v", directory, err)
			return
		}
		screenshotWatcher = watcher
		screenshotEvents = watcher.Events
		screenshotErrors = watcher.Errors
		screenshotDirectory = directory
	}

	stopTails := func() {
		for path, handle := range tails {
			close(handle.stop)
			_ = handle.value.Stop()
			delete(tails, path)
		}
		activeApplication = ""
	}

	reset := func(next Config) {
		stopScreenshotWatcher()
		stopTails()
		config = next
		generation++
		logRoot, session = "", ""
		rootModTime = time.Time{}
		pendingDelete = pendingDelete[:0]
		deleteOverflowLogged = false
		deleteFailureLogged = false
		if m.callbacks.SessionChanged != nil {
			m.callbacks.SessionChanged(generation)
		}
	}

	startTail := func(path string, fromEnd bool) {
		location := (*tail.SeekInfo)(nil)
		if fromEnd {
			location = &tail.SeekInfo{Offset: 0, Whence: io.SeekEnd}
		}
		value, err := tail.TailFile(path, tail.Config{Follow: true, ReOpen: true, Poll: true, CompleteLines: true, MustExist: false, Location: location, Logger: tail.DiscardingLogger})
		if err != nil {
			m.diagnostic("error", "tail_start_failed", "Open %q: %v", path, err)
			return
		}
		stop := make(chan struct{})
		tails[path] = tailHandle{value: value, stop: stop}
		go func(path string, generation uint64, value *tail.Tail) {
			for line := range value.Lines {
				item := TailLine{Generation: generation, Path: path, Text: line.Text, Err: line.Err}
				select {
				case lines <- item:
				case <-ctx.Done():
					return
				case <-stop:
					return
				}
			}
		}(path, generation, value)
	}

	switchSession := func(next string, startup bool) {
		if next == session {
			return
		}
		if session != "" {
			generation++
			if m.callbacks.SessionChanged != nil {
				m.callbacks.SessionChanged(generation)
			}
		}
		stopTails()
		session = next
		if next == "" {
			return
		}
		m.diagnostic("info", "session_changed", "Session %q, generation %d", next, generation)
	}

	initialize := func() {
		startScreenshotWatcher(config.ScreenshotDirectory)
		logRoot, rootModTime = scanSessionRoot(logRoot, rootModTime, config.LogDirectory, &session, &switchSession)
		if session != "" {
			scanApplicationFiles(session, &activeApplication, tails, generation, true, startTail, m.callbacks)
		}
	}

	reset(config)
	initialize()
	clock := time.NewTicker(coordinatorInterval)
	defer clock.Stop()
	defer stopScreenshotWatcher()
	defer stopTails()

	for {
		select {
		case <-ctx.Done():
			return
		case next := <-m.updates:
			if next == config {
				continue
			}
			reset(next)
			initialize()
		case <-clock.C:
			tick++
			m.consumeTailLines(ctx, lines, generation)
			m.processPendingDeletes(&pendingDelete, &deleteFailureLogged)
			if tick%rootScanTicks == 0 {
				logRoot, rootModTime = scanSessionRoot(logRoot, rootModTime, config.LogDirectory, &session, &switchSession)
				if session != "" {
					scanApplicationFiles(session, &activeApplication, tails, generation, false, startTail, m.callbacks)
				}
			}
			m.consumeTailLines(ctx, lines, generation)
		case event, ok := <-screenshotEvents:
			if !ok {
				directory := screenshotDirectory
				startScreenshotWatcher(directory)
				continue
			}
			m.consumeTailLines(ctx, lines, generation)
			m.processScreenshotEvent(config, screenshotDirectory, event, &pendingDelete, &deleteOverflowLogged)
			m.processPendingDeletes(&pendingDelete, &deleteFailureLogged)
		case err, ok := <-screenshotErrors:
			if !ok {
				directory := screenshotDirectory
				startScreenshotWatcher(directory)
				continue
			}
			m.diagnostic("error", "screenshot_watch_failed", "%v", err)
			directory := screenshotDirectory
			startScreenshotWatcher(directory)
		}
	}
}

func (m *Monitor) consumeTailLines(ctx context.Context, lines <-chan TailLine, generation uint64) {
	for {
		select {
		case <-ctx.Done():
			return
		case item := <-lines:
			if item.Generation != generation {
				continue
			}
			if item.Err != nil {
				m.diagnostic("error", "tail_read_failed", "Read %q: %v", item.Path, item.Err)
				continue
			}
			if event, ok := ParseLogLine(strings.TrimSuffix(item.Text, "\r")); ok {
				event.Generation = generation
				if m.callbacks.Log != nil {
					m.callbacks.Log(event)
				}
				if m.callbacks.Activity != nil {
					m.callbacks.Activity("log", time.Now())
				}
			}
		default:
			return
		}
	}
}

func (m *Monitor) processScreenshotEvent(config Config, directory string, event fsnotify.Event, pendingDelete *[]string, overflowLogged *bool) {
	if m.callbacks.Screenshot == nil {
		return
	}
	path := filepath.Clean(event.Name)
	if directory == "" || filepath.Dir(path) != directory || event.Op&(fsnotify.Create|fsnotify.Rename) == 0 {
		return
	}
	if strings.ToLower(filepath.Ext(path)) != ".png" {
		return
	}
	value, ok := ParseScreenshotName(path)
	if !ok {
		m.diagnostic("warn", "screenshot_name_invalid", "Cannot parse %q", path)
		return
	}
	if err := m.callbacks.Screenshot(value); err != nil {
		m.diagnostic("warn", "position_update_failed", "Screenshot %q: %v", path, err)
		return
	}
	if config.DeleteScreenshots {
		if len(*pendingDelete) >= 1000 {
			if !*overflowLogged {
				m.diagnostic("warn", "screenshot_delete_limit", "Pending screenshot deletions reached 1000")
				*overflowLogged = true
			}
			return
		}
		*pendingDelete = append(*pendingDelete, path)
	}
	if m.callbacks.Activity != nil {
		m.callbacks.Activity("screenshot", time.Now())
	}
}

// Deletions that fail stay queued for the next attempt. Only the first failure of a streak is
// reported, so one stuck file cannot flood the log.
func (m *Monitor) processPendingDeletes(pending *[]string, failureLogged *bool) {
	kept := (*pending)[:0]
	for _, path := range *pending {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			if !*failureLogged {
				m.diagnostic("warn", "screenshot_delete_failed", "Delete %q: %v", path, err)
				*failureLogged = true
			}
			kept = append(kept, path)
		}
	}
	if len(kept) == 0 {
		*failureLogged = false
	}
	*pending = kept
}

func scanSessionRoot(previous string, previousMod time.Time, configured string, session *string, switchSession *func(string, bool)) (string, time.Time) {
	root := cleanDirectory(configured)
	if root == "" {
		return "", time.Time{}
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return root, time.Time{}
	}
	if root == previous && info.ModTime().Equal(previousMod) {
		return root, previousMod
	}
	next := newestSession(root)
	if next != *session {
		startup := *session == ""
		(*switchSession)(next, startup)
	}
	return root, info.ModTime()
}

func scanApplicationFiles(session string, active *string, tails map[string]tailHandle, generation uint64, startup bool, startTail func(string, bool), callbacks Callbacks) {
	entries, err := os.ReadDir(session)
	if err != nil {
		return
	}
	var newest string
	var newestMod time.Time
	for _, entry := range entries {
		if entry.IsDir() || !isApplicationLog(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err == nil && (newest == "" || info.ModTime().After(newestMod)) {
			newest, newestMod = filepath.Join(session, entry.Name()), info.ModTime()
		}
	}
	if newest == "" || newest == *active {
		return
	}
	for path, handle := range tails {
		close(handle.stop)
		_ = handle.value.Stop()
		delete(tails, path)
	}
	*active = newest
	fromEnd := startup
	// Install the tail before recovery. Lines appended while the recovery scan
	// runs are then queued and consumed after the recovered candidate.
	startTail(newest, fromEnd)
	if startup {
		if event, ok, err := recoverApplicationState(newest); err == nil && ok {
			event.InitialRead = true
			event.Generation = generation
			if callbacks.Log != nil {
				callbacks.Log(event)
			}
		} else if err != nil && callbacks.Diagnostic != nil {
			// Once per startup: the session starts fresh instead of restoring the last position.
			callbacks.Diagnostic("warn", "state_recovery_failed", fmt.Sprintf("Recover %q: %v", newest, err))
		}
	}
}

func recoverApplicationState(path string) (LogEvent, bool, error) {
	file, err := tail.OpenFile(path) //nolint:staticcheck // preserves Windows shared read/write/delete semantics
	if err != nil {
		return LogEvent{}, false, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return LogEvent{}, false, err
	}
	modeOffset := findLastAnchor(file, info.Size(), []byte("Session mode:"))
	mapOffset := findLastAnchor(file, info.Size(), []byte("scene preset path:"))
	if modeOffset < 0 && mapOffset < 0 {
		return LogEvent{}, false, nil
	}
	start := modeOffset
	if start < 0 || (mapOffset >= 0 && mapOffset < start) {
		start = mapOffset
	}
	return scanLogRange(file, start)
}

func scanLogRange(file *os.File, offset int64) (LogEvent, bool, error) {
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return LogEvent{}, false, err
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	var last LogEvent
	found := false
	for scanner.Scan() {
		if event, ok := ParseLogLine(scanner.Text()); ok {
			if event.Mode != "" {
				last.Mode = event.Mode
			}
			if event.Map != "" {
				last.Map = event.Map
			}
			found = true
		}
	}
	return last, found, scanner.Err()
}

func findLastAnchor(file *os.File, size int64, needle []byte) int64 {
	var suffix []byte
	for end := size; end > 0; {
		start := end - reverseChunkSize
		if start < 0 {
			start = 0
		}
		buf := make([]byte, end-start)
		if _, err := file.ReadAt(buf, start); err != nil && !errors.Is(err, io.EOF) {
			return -1
		}
		data := append(buf, suffix...)
		if index := bytes.LastIndex(data, needle); index >= 0 {
			return start + int64(index)
		}
		keep := len(needle) - 1
		if keep > len(buf) {
			keep = len(buf)
		}
		suffix = append([]byte(nil), buf[:keep]...)
		end = start
	}
	return -1
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
