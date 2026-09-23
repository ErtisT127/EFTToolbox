package mapper

import (
	"math"
	"regexp"
	"sort"

	contracts "efttoolbox/contracts"
)

var idPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func Resolve(index *Index, p contracts.WorldPosition, followFloor bool) contracts.LocationResolution {
	result, _ := ResolveWithDiagnostics(index, p, followFloor)
	return result
}

type OverlapPair struct {
	FirstID  string
	SecondID string
}

func ResolveWithDiagnostics(index *Index, p contracts.WorldPosition, followFloor bool) (contracts.LocationResolution, []OverlapPair) {
	if !followFloor {
		// FollowFloor=false deliberately skips Region lookup; callers must keep the current floor.
		return contracts.LocationResolution{Status: "skipped", Candidates: []string{}}, nil
	}
	candidates := index.Query(p)
	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if a.Priority != b.Priority {
			return a.Priority > b.Priority
		}
		aw, bw := a.YRange.Max-a.YRange.Min, b.YRange.Max-b.YRange.Min
		if aw != bw {
			return aw < bw
		}
		if a.CoversEntireMap != b.CoversEntireMap {
			return !a.CoversEntireMap
		}
		if a.CoversEntireMap {
			return a.Id < b.Id
		}
		aa := (a.Rectangle.MaxX - a.Rectangle.MinX) * (a.Rectangle.MaxZ - a.Rectangle.MinZ)
		ba := (b.Rectangle.MaxX - b.Rectangle.MinX) * (b.Rectangle.MaxZ - b.Rectangle.MinZ)
		if aa != ba {
			return aa < ba
		}
		return a.Id < b.Id
	})
	overlaps := make([]OverlapPair, 0)
	for i := 0; i < len(candidates); i++ {
		for j := i + 1; j < len(candidates); j++ {
			if candidates[i].Priority != candidates[j].Priority {
				continue
			}
			first, second := candidates[i].Id, candidates[j].Id
			if first > second {
				first, second = second, first
			}
			overlaps = append(overlaps, OverlapPair{FirstID: first, SecondID: second})
		}
	}
	ids := make([]string, 0, len(candidates))
	for _, region := range candidates {
		ids = append(ids, region.Id)
	}
	if len(candidates) == 0 {
		return contracts.LocationResolution{Status: "unresolved", Candidates: ids}, overlaps
	}
	best := candidates[0]
	return contracts.LocationResolution{Status: "resolved", FloorId: &best.FloorId, RegionId: &best.Id, Candidates: ids}, overlaps
}

func ValidDocument(doc contracts.CalibrationDocument, mapData contracts.MapData) bool {
	if doc.SchemaVersion != 1 || doc.MapId != mapData.Id || (doc.Basemap != "svg" && doc.Basemap != "tiles") || doc.Revision < 0 || doc.NextRegionNumber < 1 || len(doc.Regions) > 10000 {
		return false
	}
	ids := map[string]bool{}
	fullCoverFloors := map[string]bool{}
	for _, r := range doc.Regions {
		if !idPattern.MatchString(r.Id) || len(r.Id) > 100 || ids[r.Id] || r.Name == "" || len(r.Name) > 64 || r.Priority < 0 || r.Priority > 9999 || !finite(r.Rectangle.MinX) || !finite(r.Rectangle.MaxX) || !finite(r.Rectangle.MinZ) || !finite(r.Rectangle.MaxZ) || !finite(r.YRange.Min) || !finite(r.YRange.Max) || r.YRange.Min >= r.YRange.Max {
			return false
		}
		if !r.CoversEntireMap && (r.Rectangle.MinX >= r.Rectangle.MaxX || r.Rectangle.MinZ >= r.Rectangle.MaxZ) {
			return false
		}
		if r.CoversEntireMap {
			key := r.FloorId
			if fullCoverFloors[key] {
				return false
			}
			fullCoverFloors[key] = true
		}
		found := false
		for _, f := range mapData.Floors {
			if f.Id == r.FloorId {
				found = true
				break
			}
		}
		if !found {
			return false
		}
		ids[r.Id] = true
	}
	return true
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
