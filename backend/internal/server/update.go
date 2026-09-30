package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	contracts "efttoolbox/contracts"
)

// The release feed the desktop build is published on. A test points it at its own server.
var updateFeedURL = "https://api.github.com/repos/ErtisT127/EFTToolbox/releases/latest"

// One attempt answers every launch inside this window, so opening the app a few times a day costs a
// single request to the feed instead of one per start.
const updateCheckInterval = 12 * time.Hour

// updateCheckState is what the last attempt left behind. It is internal bookkeeping, not a contract
// document, so it carries no schema version and the user settings repair flow never sees it.
type updateCheckState struct {
	CheckedAt time.Time `json:"checkedAt"`
	Latest    string    `json:"latest,omitempty"`
	Failed    bool      `json:"failed,omitempty"`
}

type updateManager struct {
	root    string
	version string
	client  *http.Client
	// mu keeps two launches - or a launch and a manual check - from asking the feed at the same time.
	mu sync.Mutex
}

func newUpdateManager(root, version string) *updateManager {
	return &updateManager{root: root, version: version, client: &http.Client{Timeout: 8 * time.Second}}
}

func (m *updateManager) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/update", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		status, err := m.status(r.Context(), r.URL.Query().Get("force") == "1")
		if err != nil {
			log.Printf("update check: %v", err)
			apiError(w, http.StatusBadGateway, "update_check_failed")
			return
		}
		jsonResponse(w, status)
	})
}

// status answers with what is known about the newest release. The running version is always read
// from the process, so a package the user just replaced reports itself as current even when the
// stored answer still names the release it was built from.
func (m *updateManager) status(ctx context.Context, force bool) (contracts.UpdateStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.version
	state, err := m.readState()
	if err == nil && !force && time.Since(state.CheckedAt) < updateCheckInterval {
		if state.Failed {
			return contracts.UpdateStatus{Current: current}, errors.New("previous update check failed")
		}
		return contracts.UpdateStatus{
			Current:         current,
			Latest:          state.Latest,
			UpdateAvailable: newerVersion(state.Latest, current),
		}, nil
	}
	latest, err := m.fetchLatest(ctx)
	if err != nil {
		// The attempt is remembered even when it failed: a launch inside the window must not turn
		// into another request just because the feed was unreachable.
		m.writeState(updateCheckState{CheckedAt: time.Now().UTC(), Failed: true})
		return contracts.UpdateStatus{Current: current}, err
	}
	m.writeState(updateCheckState{CheckedAt: time.Now().UTC(), Latest: latest})
	return contracts.UpdateStatus{
		Current:         current,
		Latest:          latest,
		UpdateAvailable: newerVersion(latest, current),
	}, nil
}

func (m *updateManager) fetchLatest(ctx context.Context) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, updateFeedURL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	// The API rejects requests without a user agent.
	request.Header.Set("User-Agent", "EFTToolbox")
	response, err := m.client.Do(request)
	if err != nil {
		return "", err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return "", errors.New("release feed status " + strconv.Itoa(response.StatusCode))
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 256<<10))
	if err != nil {
		return "", err
	}
	var release struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(data, &release); err != nil {
		return "", err
	}
	latest := strings.TrimSpace(release.TagName)
	if latest == "" {
		return "", errors.New("release feed has no tag")
	}
	return latest, nil
}

func (m *updateManager) statePath() string {
	return filepath.Join(m.root, "user", "update-check.json")
}

func (m *updateManager) readState() (updateCheckState, error) {
	var state updateCheckState
	data, err := os.ReadFile(m.statePath())
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return updateCheckState{}, err
	}
	return state, nil
}

// A state file that cannot be written only costs the next launch one extra request, so the failure
// is logged rather than reported: the answer the user asked for is already known.
func (m *updateManager) writeState(state updateCheckState) {
	if err := (&VersionedFileStore{root: m.root}).Save(filepath.Join("user", "update-check.json"), state); err != nil {
		log.Printf("save update check state: %v", err)
	}
}

// newerVersion reports whether latest is a release the running version does not have yet. Both sides
// are read as major.minor.patch; a version carrying a suffix ("0.0.0-dev") compares by its numbers,
// so a development build counts as older than any release.
func newerVersion(latest, current string) bool {
	latestParts, ok := parseVersion(latest)
	if !ok {
		return false
	}
	currentParts, _ := parseVersion(current)
	for index := range latestParts {
		if latestParts[index] != currentParts[index] {
			return latestParts[index] > currentParts[index]
		}
	}
	return false
}

func parseVersion(value string) ([3]int, bool) {
	var parts [3]int
	value = strings.TrimPrefix(strings.TrimSpace(value), "v")
	value = strings.TrimPrefix(value, "V")
	if value == "" {
		return parts, false
	}
	numbers := strings.SplitN(value, "-", 2)[0]
	segments := strings.Split(numbers, ".")
	for index, segment := range segments {
		if index == len(parts) {
			break
		}
		number, err := strconv.Atoi(strings.TrimSpace(segment))
		if err != nil || number < 0 {
			return parts, false
		}
		parts[index] = number
	}
	return parts, true
}
