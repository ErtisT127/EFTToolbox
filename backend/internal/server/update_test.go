package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// stubFeed replaces the release feed for one test and reports how often it was asked.
func stubFeed(t *testing.T, status int, tag string) *int {
	t.Helper()
	calls := 0
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"tag_name": tag})
	}))
	t.Cleanup(feed.Close)
	previous := updateFeedURL
	updateFeedURL = feed.URL
	t.Cleanup(func() { updateFeedURL = previous })
	return &calls
}

func writeUpdateState(t *testing.T, root string, state updateCheckState) {
	t.Helper()
	if err := (&VersionedFileStore{root: root}).Save(filepath.Join("user", "update-check.json"), state); err != nil {
		t.Fatalf("write update state: %v", err)
	}
}

func TestUpdateStatusReportsNewerRelease(t *testing.T) {
	root := t.TempDir()
	calls := stubFeed(t, http.StatusOK, "v1.2.3")
	manager := newUpdateManager(root, "0.0.0-dev")

	status, err := manager.status(context.Background(), false)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !status.UpdateAvailable || status.Latest != "v1.2.3" || status.Current != "0.0.0-dev" {
		t.Fatalf("status = %+v", status)
	}
	if *calls != 1 {
		t.Fatalf("feed calls = %d, want 1", *calls)
	}
	state, err := manager.readState()
	if err != nil || state.Latest != "v1.2.3" || state.Failed {
		t.Fatalf("state = %+v (%v)", state, err)
	}
}

func TestUpdateStatusReportsCurrentRelease(t *testing.T) {
	manager := newUpdateManager(t.TempDir(), "1.2.3")
	stubFeed(t, http.StatusOK, "v1.2.3")

	status, err := manager.status(context.Background(), false)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if status.UpdateAvailable {
		t.Fatalf("status = %+v, want no update", status)
	}
}

func TestUpdateStatusReplaysInsideThrottleWindow(t *testing.T) {
	root := t.TempDir()
	calls := stubFeed(t, http.StatusOK, "v9.9.9")
	writeUpdateState(t, root, updateCheckState{CheckedAt: time.Now().UTC().Add(-time.Hour), Latest: "v2.0.0"})
	manager := newUpdateManager(root, "1.0.0")

	status, err := manager.status(context.Background(), false)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if status.Latest != "v2.0.0" || !status.UpdateAvailable {
		t.Fatalf("status = %+v, want the stored answer", status)
	}
	if *calls != 0 {
		t.Fatalf("feed calls = %d, want none inside the window", *calls)
	}
}

func TestUpdateStatusForceIgnoresThrottleWindow(t *testing.T) {
	root := t.TempDir()
	calls := stubFeed(t, http.StatusOK, "v2.0.0")
	writeUpdateState(t, root, updateCheckState{CheckedAt: time.Now().UTC(), Latest: "v2.0.0"})
	manager := newUpdateManager(root, "1.0.0")

	if _, err := manager.status(context.Background(), true); err != nil {
		t.Fatalf("status: %v", err)
	}
	if *calls != 1 {
		t.Fatalf("feed calls = %d, want 1", *calls)
	}
}

func TestUpdateStatusRemembersFailedCheck(t *testing.T) {
	root := t.TempDir()
	calls := stubFeed(t, http.StatusNotFound, "")
	manager := newUpdateManager(root, "1.0.0")

	if _, err := manager.status(context.Background(), false); err == nil {
		t.Fatal("status succeeded with a missing release")
	}
	if _, err := manager.status(context.Background(), false); err == nil {
		t.Fatal("status succeeded on the replay of a failed check")
	}
	if *calls != 1 {
		t.Fatalf("feed calls = %d, want a single attempt inside the window", *calls)
	}
	state, err := manager.readState()
	if err != nil || !state.Failed {
		t.Fatalf("state = %+v (%v), want a failed attempt", state, err)
	}
}

func TestUpdateStatusRecoversAfterThrottleWindow(t *testing.T) {
	root := t.TempDir()
	calls := stubFeed(t, http.StatusOK, "v2.0.0")
	writeUpdateState(t, root, updateCheckState{CheckedAt: time.Now().UTC().Add(-updateCheckInterval - time.Minute)})
	manager := newUpdateManager(root, "1.0.0")

	status, err := manager.status(context.Background(), false)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !status.UpdateAvailable || *calls != 1 {
		t.Fatalf("status = %+v, calls = %d", status, *calls)
	}
}

func TestUpdateCheckStateSurvivesMissingStateFile(t *testing.T) {
	root := t.TempDir()
	stubFeed(t, http.StatusOK, "v1.0.0")
	manager := newUpdateManager(root, "1.0.0")

	if _, err := os.Stat(manager.statePath()); !os.IsNotExist(err) {
		t.Fatalf("state file unexpectedly present: %v", err)
	}
	if _, err := manager.status(context.Background(), false); err != nil {
		t.Fatalf("status: %v", err)
	}
	if _, err := os.Stat(manager.statePath()); err != nil {
		t.Fatalf("state file was not written: %v", err)
	}
}

func TestNewerVersionComparesNumbers(t *testing.T) {
	cases := []struct {
		latest  string
		current string
		want    bool
	}{
		{"v1.2.3", "1.2.2", true},
		{"1.10.0", "1.9.9", true},
		{"v2.0.0", "2.0.0", false},
		{"v1.9.9", "1.10.0", false},
		{"1.0.0", "0.0.0-dev", true},
		{"v0.0.0", "0.0.0-dev", false},
		{"", "1.0.0", false},
		{"nightly", "1.0.0", false},
	}
	for _, test := range cases {
		if got := newerVersion(test.latest, test.current); got != test.want {
			t.Fatalf("newerVersion(%q, %q) = %t, want %t", test.latest, test.current, got, test.want)
		}
	}
}
