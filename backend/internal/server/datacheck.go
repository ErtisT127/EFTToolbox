package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	contracts "efttoolbox/contracts"
)

func checkWritable(paths ...string) error {
	for _, dir := range paths {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("%s: %w", filepath.Clean(dir), err)
		}
		file, err := os.CreateTemp(dir, ".write-check-*")
		if err != nil {
			return fmt.Errorf("%s: %w", filepath.Clean(dir), err)
		}
		name := file.Name()
		if err := file.Close(); err != nil {
			_ = os.Remove(name)
			return fmt.Errorf("%s: %w", filepath.Clean(dir), err)
		}
		if err := os.Remove(name); err != nil {
			return fmt.Errorf("%s: %w", filepath.Clean(dir), err)
		}
	}
	return nil
}

func dataDirError(w http.ResponseWriter, err error) {
	detail := err.Error()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusInternalServerError)
	_ = json.NewEncoder(w).Encode(contracts.ErrorBody{Code: "data_dir_not_writable", Detail: &detail})
}
