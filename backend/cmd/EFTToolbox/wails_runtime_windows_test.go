//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func startupFixture(t *testing.T) (string, string, string) {
	t.Helper()
	root := t.TempDir()
	assets := filepath.Join(root, "dashboard")
	dataRoot := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(dataRoot, "upstream", "modes"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dataRoot, "upstream", "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assets, "index.html"), []byte("test"), 0o600); err != nil {
		t.Fatal(err)
	}
	overlay := filepath.Join(root, "overlay.exe")
	if err := os.WriteFile(overlay, []byte("test"), 0o600); err != nil {
		t.Fatal(err)
	}
	return assets, dataRoot, overlay
}

func TestValidateStartupDirectories(t *testing.T) {
	assets, dataRoot, overlay := startupFixture(t)
	if err := validateStartup(assets, dataRoot, overlay); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		filepath.Join(dataRoot, "user"),
		filepath.Join(dataRoot, "webview2"),
		filepath.Join(filepath.Dir(dataRoot), "logs"),
	} {
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			t.Fatalf("startup directory %s was not created: %v", path, err)
		}
	}
}

func TestValidateStartupRejectsBlockedDirectory(t *testing.T) {
	tests := []struct {
		name string
		key  string
		path func(string) string
	}{
		{name: "user", key: "host.startupDataDirectory", path: func(root string) string { return filepath.Join(root, "user") }},
		{name: "webview2", key: "host.startupDataDirectory", path: func(root string) string { return filepath.Join(root, "webview2") }},
		{name: "logs", key: "host.startupLog", path: func(root string) string { return filepath.Join(filepath.Dir(root), "logs") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assets, dataRoot, overlay := startupFixture(t)
			blocked := tt.path(dataRoot)
			if err := os.WriteFile(blocked, []byte("blocked"), 0o600); err != nil {
				t.Fatal(err)
			}
			err := validateStartup(assets, dataRoot, overlay)
			if err == nil {
				t.Fatal("validateStartup accepted a blocked directory")
			}
			var keyed keyedFailure
			if !errors.As(err, &keyed) || keyed.key != tt.key {
				t.Fatalf("error key = %v, want %s", err, tt.key)
			}
			if !strings.Contains(err.Error(), blocked) {
				t.Fatalf("error %q does not name blocked directory %s", err, blocked)
			}
		})
	}
}
