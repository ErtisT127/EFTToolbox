package server

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type clientLog struct {
	Time      string `json:"time"`
	Level     string `json:"level"`
	Component string `json:"component"`
	Event     string `json:"event"`
	Message   string `json:"message"`
	Error     string `json:"error,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

type dailyLogWriter struct {
	root string
	mu   sync.Mutex
	day  string
}

func newDailyLogWriter(root string) (io.Writer, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	w := &dailyLogWriter{root: root}
	if err := w.rotate(time.Now().UTC()); err != nil {
		return nil, err
	}
	w.cleanup()
	return w, nil
}

func (w *dailyLogWriter) rotate(now time.Time) error {
	day := now.UTC().Format("2006-01-02")
	if w.day == day {
		return nil
	}
	w.day = day
	return nil
}

func (w *dailyLogWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.rotate(time.Now().UTC()); err != nil {
		return 0, err
	}
	entry := clientLog{
		Time:      time.Now().UTC().Format(time.RFC3339Nano),
		Level:     "info",
		Component: "backend",
		Event:     "standard_log",
		Message:   strings.TrimSpace(string(p)),
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return 0, err
	}
	data = append(data, '\n')
	f, err := os.OpenFile(filepath.Join(w.root, "efttoolbox-"+w.day+".jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return 0, err
	}
	defer func() { _ = f.Close() }()
	_, err = f.Write(data)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

func (w *dailyLogWriter) write(entry clientLog) error {
	if entry.Time == "" {
		entry.Time = time.Now().UTC().Format(time.RFC3339Nano)
	}
	return w.writeValue(entry)
}

func (w *dailyLogWriter) writeValue(entry any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.rotate(time.Now().UTC()); err != nil {
		return err
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(w.root, "efttoolbox-"+w.day+".jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	_, err = fmt.Fprintln(f, string(data))
	return err
}

func (w *dailyLogWriter) cleanup() {
	entries, err := os.ReadDir(w.root)
	if err != nil {
		return
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), "efttoolbox-") && strings.HasSuffix(entry.Name(), ".jsonl") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	cutoff := time.Now().UTC().AddDate(0, 0, -6).Format("2006-01-02")
	for _, name := range names {
		if len(name) >= len("efttoolbox-2006-01-02") && strings.TrimSuffix(strings.TrimPrefix(name, "efttoolbox-"), ".jsonl") < cutoff {
			_ = os.Remove(filepath.Join(w.root, name))
		}
	}
}

func (h *overlayHub) monitorDiagnostic(level, event, message string) {
	if h.logWriter == nil {
		return
	}
	if err := h.logWriter.write(clientLog{Level: level, Component: "gamewatch", Event: event, Message: message}); err != nil {
		log.Printf("write game monitor log: %v", err)
	}
}
