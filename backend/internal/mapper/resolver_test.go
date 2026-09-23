package mapper

import (
	contracts "efttoolbox/contracts"
	"testing"
)

func TestResolvePriorityAndHalfOpenY(t *testing.T) {
	index := Build([]contracts.CalibrationRegion{
		{Id: "ground", FloorId: "g", Name: "Ground", Rectangle: contracts.WorldRectXZ{MinX: 0, MaxX: 10, MinZ: 0, MaxZ: 10}, YRange: contracts.YRange{Min: 0, Max: 5}, Priority: 1},
		{Id: "upper", FloorId: "u", Name: "Upper", Rectangle: contracts.WorldRectXZ{MinX: 0, MaxX: 10, MinZ: 0, MaxZ: 10}, YRange: contracts.YRange{Min: 5, Max: 10}, Priority: 1},
	})
	if got := Resolve(index, contracts.WorldPosition{X: 1, Y: 5, Z: 1}, true); got.FloorId == nil || *got.FloorId != "u" {
		t.Fatalf("upper boundary: %+v", got)
	}
	if got := Resolve(index, contracts.WorldPosition{X: 1, Y: 10, Z: 1}, true); got.Status != "unresolved" {
		t.Fatalf("max boundary: %+v", got)
	}
	if got := Resolve(index, contracts.WorldPosition{X: 1, Y: 2, Z: 1}, false); got.Status != "skipped" || len(got.Candidates) != 0 {
		t.Fatalf("skipped: %+v", got)
	}
}

func TestResolveFullCoverIgnoresPlaceholderGeometry(t *testing.T) {
	region := contracts.CalibrationRegion{
		Id:              "base",
		FloorId:         "ground",
		Name:            "Base",
		Rectangle:       contracts.WorldRectXZ{MinX: 100, MaxX: 101, MinZ: 100, MaxZ: 101},
		YRange:          contracts.YRange{Min: 0, Max: 10},
		Priority:        0,
		CoversEntireMap: true,
	}
	index := Build([]contracts.CalibrationRegion{region})
	got, _ := ResolveWithDiagnostics(index, contracts.WorldPosition{X: -10000, Y: 5, Z: 9000}, true)
	if got.Status != "resolved" || got.RegionId == nil || *got.RegionId != "base" {
		t.Fatalf("full-cover result: %+v", got)
	}
}

func TestResolveSamePriorityUsesDeterministicWinner(t *testing.T) {
	index := Build([]contracts.CalibrationRegion{
		{Id: "large", FloorId: "f", Rectangle: contracts.WorldRectXZ{MinX: 0, MaxX: 20, MinZ: 0, MaxZ: 20}, YRange: contracts.YRange{Min: 0, Max: 10}, Priority: 5},
		{Id: "small", FloorId: "f", Rectangle: contracts.WorldRectXZ{MinX: 0, MaxX: 10, MinZ: 0, MaxZ: 10}, YRange: contracts.YRange{Min: 0, Max: 10}, Priority: 5},
	})
	got, overlaps := ResolveWithDiagnostics(index, contracts.WorldPosition{X: 1, Y: 1, Z: 1}, true)
	if got.Status != "resolved" || got.RegionId == nil || *got.RegionId != "small" {
		t.Fatalf("same-priority result: %+v", got)
	}
	if len(overlaps) != 1 || overlaps[0].FirstID != "large" || overlaps[0].SecondID != "small" {
		t.Fatalf("overlaps: %+v", overlaps)
	}
}

func TestValidDocumentFullCoverUniquenessAndPriorityBounds(t *testing.T) {
	mapData := contracts.MapData{Id: "map", Floors: []contracts.Floor{{Id: "f"}, {Id: "other"}}}
	base := contracts.CalibrationRegion{Id: "a", FloorId: "f", Name: "A", Rectangle: contracts.WorldRectXZ{MinX: 0, MaxX: 1, MinZ: 0, MaxZ: 1}, YRange: contracts.YRange{Min: 0, Max: 1}, Priority: 0, CoversEntireMap: true}
	doc := contracts.CalibrationDocument{SchemaVersion: 1, MapId: "map", Basemap: "svg", NextRegionNumber: 1, Regions: []contracts.CalibrationRegion{base}}
	if !ValidDocument(doc, mapData) {
		t.Fatal("priority 0/full-cover document rejected")
	}
	doc.Regions = append(doc.Regions, contracts.CalibrationRegion{Id: "b", FloorId: "f", Name: "B", Rectangle: base.Rectangle, YRange: base.YRange, Priority: 9999, CoversEntireMap: true})
	if ValidDocument(doc, mapData) {
		t.Fatal("duplicate full-cover Region accepted")
	}
	doc.Regions[1].FloorId = "other"
	if !ValidDocument(doc, mapData) {
		t.Fatal("full-cover Regions on different floors rejected")
	}
	doc.Regions[1].Priority = 10000
	if ValidDocument(doc, mapData) {
		t.Fatal("priority 10000 accepted")
	}
}
