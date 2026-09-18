package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	"image/png"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	contracts "efttoolbox/contracts"
)

var tileLocks [64]sync.Mutex
var tileDownloads = make(chan struct{}, 8)
var tileClient = &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(r *http.Request, _ []*http.Request) error {
	if !allowedTileURL(r.URL) {
		return fmt.Errorf("tile redirect rejected")
	}
	return nil
}}

func allowedTileURL(u *url.URL) bool {
	return u.Scheme == "https" && u.Host == "assets.tarkov.dev" && strings.HasPrefix(u.Path, "/maps/") && u.User == nil
}

func tileInBounds(t contracts.TileLayer, z, x, y int) bool {
	if z < t.MinZoom || z > t.MaxZoom || z < 0 || z > 20 || len(t.Transform) != 4 || len(t.Bounds) != 2 || t.TileSize <= 0 {
		return false
	}
	a := t.Transform
	scale := math.Exp2(float64(z)) / float64(t.TileSize)
	x1, x2 := (a[0]*t.Bounds[0].X+a[1])*scale, (a[0]*t.Bounds[1].X+a[1])*scale
	y1, y2 := (a[2]*t.Bounds[0].Y+a[3])*scale, (a[2]*t.Bounds[1].Y+a[3])*scale
	return float64(x) >= math.Floor(math.Min(x1, x2)) && float64(x) < math.Ceil(math.Max(x1, x2)) && float64(y) >= math.Floor(math.Min(y1, y2)) && float64(y) < math.Ceil(math.Max(y1, y2))
}

func (s *mapStore) tile(w http.ResponseWriter, r *http.Request) {
	m, err := s.load(r.PathValue("map"))
	if err != nil {
		dataError(w, err)
		return
	}
	var layer *contracts.TileLayer
	for i := range m.Tiles {
		if m.Tiles[i].Id == r.PathValue("layer") {
			layer = &m.Tiles[i]
			break
		}
	}
	z, ez := strconv.Atoi(r.PathValue("z"))
	x, ex := strconv.Atoi(r.PathValue("x"))
	y, ey := strconv.Atoi(strings.TrimSuffix(r.PathValue("y"), ".png"))
	if layer == nil || ez != nil || ex != nil || ey != nil || !tileInBounds(*layer, z, x, y) {
		http.NotFound(w, r)
		return
	}
	source := strings.NewReplacer("{z}", strconv.Itoa(z), "{x}", strconv.Itoa(x), "{y}", strconv.Itoa(y)).Replace(layer.SourceUrl)
	u, err := url.Parse(source)
	if err != nil || !allowedTileURL(u) {
		http.Error(w, "invalid tile source", 500)
		return
	}
	sum := sha256.Sum256([]byte(source))
	key := hex.EncodeToString(sum[:])
	lock := &tileLocks[int(sum[0])%len(tileLocks)]
	lock.Lock()
	defer lock.Unlock()
	name := filepath.Join(s.root, "upstream", "tiles", key[:2], key+".png")
	data, err := os.ReadFile(name)
	if err != nil {
		select {
		case tileDownloads <- struct{}{}:
			defer func() { <-tileDownloads }()
		case <-r.Context().Done():
			return
		}
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, source, nil)
		if err != nil {
			http.Error(w, "invalid tile request", 500)
			return
		}
		response, err := tileClient.Do(req)
		if err != nil {
			http.Error(w, "tile upstream unavailable", http.StatusBadGateway)
			return
		}
		defer func() { _ = response.Body.Close() }()
		if response.StatusCode == http.StatusNotFound {
			var blank bytes.Buffer
			_ = png.Encode(&blank, image.NewNRGBA(image.Rect(0, 0, 1, 1)))
			data = blank.Bytes()
		} else if response.StatusCode != http.StatusOK {
			http.Error(w, "tile upstream unavailable", http.StatusBadGateway)
			return
		} else {
			data, err = io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
			if err != nil || len(data) > 4<<20 {
				http.Error(w, "invalid tile response", http.StatusBadGateway)
				return
			}
			config, decodeErr := png.DecodeConfig(bytes.NewReader(data))
			if decodeErr != nil || config.Width > 4096 || config.Height > 4096 {
				http.Error(w, "invalid tile image", http.StatusBadGateway)
				return
			}
		}
		dir := filepath.Dir(name)
		if err = os.MkdirAll(dir, 0o755); err != nil {
			dataError(w, err)
			return
		}
		file, err := os.CreateTemp(dir, ".tile-*")
		if err != nil {
			dataError(w, err)
			return
		}
		temp := file.Name()
		defer func() { _ = os.Remove(temp) }()
		_, err = file.Write(data)
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
		if err == nil {
			err = os.Rename(temp, name)
		}
		if err != nil {
			dataError(w, err)
			return
		}
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(data)
}
