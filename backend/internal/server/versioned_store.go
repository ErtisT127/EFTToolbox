package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
)

var errRevisionConflict = errors.New("revision_conflict")

type VersionedFileStore struct {
	root string
	mu   sync.Mutex
}

func revisionOf(value any) (string, string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", "", err
	}
	sum := sha256.Sum256(data)
	revision := hex.EncodeToString(sum[:])
	return revision, `"` + revision + `"`, nil
}

func (s *VersionedFileStore) readLocked(name string, fallback any) (any, error) {
	data, err := os.ReadFile(filepath.Join(s.root, name))
	if errors.Is(err, os.ErrNotExist) {
		return fallback, nil
	}
	if err != nil {
		return nil, err
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, errors.New("null JSON document")
	}
	if filepath.Clean(name) == filepath.Join("user", "user-settings.json") {
		data = migrateUserSettings(data)
	}
	value := fallback
	if kind := reflect.TypeOf(fallback); kind != nil {
		if kind.Kind() == reflect.Pointer {
			value = reflect.New(kind.Elem()).Interface()
		} else {
			value = reflect.New(kind).Interface()
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return nil, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("multiple JSON values")
	}
	return value, nil
}

func migrateUserSettings(data []byte) []byte {
	var value map[string]json.RawMessage
	if json.Unmarshal(data, &value) != nil {
		return data
	}
	if raw, ok := value["settingsVersion"]; ok {
		var version int
		if json.Unmarshal(raw, &version) != nil {
			return data
		}
		if version == currentUserSettingsVersion {
			return data
		}
		if version != 0 {
			return data
		}
	}
	var recognition map[string]json.RawMessage
	if raw, ok := value["recognition"]; ok {
		if json.Unmarshal(raw, &recognition) != nil {
			return data
		}
	} else {
		recognition = map[string]json.RawMessage{}
	}
	if _, ok := recognition["ocrWarmup"]; !ok {
		recognition["ocrWarmup"] = json.RawMessage("true")
	}
	encoded, err := json.Marshal(recognition)
	if err != nil {
		return data
	}
	value["recognition"] = encoded
	value["settingsVersion"], _ = json.Marshal(currentUserSettingsVersion)
	result, _ := json.Marshal(value)
	return result
}

func ReadVersioned[T any](s *VersionedFileStore, name string, fallback T) (T, string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, err := s.readLocked(name, &fallback)
	if err != nil {
		return fallback, "", "", err
	}
	result := *value.(*T)
	revision, etag, err := revisionOf(result)
	return result, revision, etag, err
}

// ReadVersionedRepair returns a revision for the normalized body and persists a
// changed normalized value atomically before returning it.
func ReadVersionedRepair[T any](s *VersionedFileStore, name string, fallback T, repair func(*T) error) (T, string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, err := s.readLocked(name, &fallback)
	if err != nil {
		return fallback, "", "", err
	}
	result := *value.(*T)
	before, err := json.Marshal(result)
	if err != nil {
		return fallback, "", "", err
	}
	if repair != nil {
		if err := repair(&result); err != nil {
			return fallback, "", "", err
		}
	}
	after, err := json.Marshal(result)
	if err != nil {
		return fallback, "", "", err
	}
	if !bytes.Equal(before, after) {
		if err := s.writeLocked(name, result); err != nil {
			return fallback, "", "", err
		}
	}
	revision, etag, err := revisionOf(result)
	return result, revision, etag, err
}

func (s *VersionedFileStore) writeLocked(name string, value any) error {
	target := filepath.Join(s.root, name)
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".saving-*")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer func() { _ = os.Remove(temp) }()
	if _, err = file.Write(append(data, '\n')); err != nil {
		_ = file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(temp, target)
}

func (s *VersionedFileStore) Save(name string, value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writeLocked(name, value)
}

func (s *VersionedFileStore) Update(name, expected string, fallback, value any, validate func(any) error) (string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.readLocked(name, fallback)
	if err != nil {
		return "", "", err
	}
	revision, _, err := revisionOf(current)
	if err != nil {
		return "", "", err
	}
	if strings.Trim(expected, `"`) != revision {
		return revision, `"` + revision + `"`, errRevisionConflict
	}
	if validate != nil {
		if err := validate(value); err != nil {
			return revision, `"` + revision + `"`, err
		}
	}
	if err := s.writeLocked(name, value); err != nil {
		return "", "", err
	}
	return revisionOf(value)
}

func (s *VersionedFileStore) Mutate(name string, fallback any, update func(any) error) (any, string, string, error) {
	return s.mutate(name, fallback, update, false)
}

func (s *VersionedFileStore) MutateRepair(name string, fallback any, update func(any) error) (any, string, string, error) {
	return s.mutate(name, fallback, update, true)
}

func (s *VersionedFileStore) mutate(name string, fallback any, update func(any) error, repair bool) (any, string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, err := s.readLocked(name, fallback)
	if err != nil {
		var syntax *json.SyntaxError
		var valueError *json.UnmarshalTypeError
		repairable := errors.As(err, &syntax) || errors.As(err, &valueError) || errors.Is(err, io.ErrUnexpectedEOF) ||
			strings.HasPrefix(err.Error(), "json: unknown field ") || err.Error() == "multiple JSON values" || err.Error() == "null JSON document"
		if !repair || !repairable {
			return nil, "", "", err
		}
		value = fallback
	}
	if err := update(value); err != nil {
		return nil, "", "", err
	}
	if err := s.writeLocked(name, value); err != nil {
		return nil, "", "", err
	}
	revision, etag, err := revisionOf(value)
	return value, revision, etag, err
}

func (s *VersionedFileStore) CompareAndMutate(name, expected string, fallback any, update func(any) error) (any, string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, err := s.readLocked(name, fallback)
	if err != nil {
		return nil, "", "", err
	}
	revision, etag, err := revisionOf(value)
	if err != nil {
		return nil, "", "", err
	}
	if strings.Trim(expected, `"`) != revision {
		return nil, revision, etag, errRevisionConflict
	}
	if err := update(value); err != nil {
		return nil, revision, etag, err
	}
	if err := s.writeLocked(name, value); err != nil {
		return nil, "", "", err
	}
	revision, etag, err = revisionOf(value)
	return value, revision, etag, err
}

func expectedRevision(ifMatch, expected string) string {
	if ifMatch != "" {
		return strings.TrimSpace(ifMatch)
	}
	return strings.TrimSpace(expected)
}
