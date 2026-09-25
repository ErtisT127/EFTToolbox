package server

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	contracts "efttoolbox/contracts"
)

var tileLocks [64]sync.Mutex

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
	sum := sha256.Sum256([]byte(source))
	key := hex.EncodeToString(sum[:])
	lock := &tileLocks[int(sum[0])%len(tileLocks)]
	lock.Lock()
	defer lock.Unlock()
	name := filepath.Join(s.root, "upstream", "tiles", key[:2], key+".png")
	data, err := os.ReadFile(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	etagSum := sha256.Sum256(data)
	etag := fmt.Sprintf(`"%x"`, etagSum)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = w.Write(data)
}
