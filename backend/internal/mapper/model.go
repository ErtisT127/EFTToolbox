package mapper

import (
	"math"
	"sort"

	contracts "efttoolbox/contracts"
)

type Index struct {
	root      *node
	fullCover []contracts.CalibrationRegion
}

type bounds struct{ minX, maxX, minY, maxY, minZ, maxZ float64 }
type item struct {
	region contracts.CalibrationRegion
	box    bounds
}
type node struct {
	box      bounds
	children []*node
	items    []item
}

func Build(regions []contracts.CalibrationRegion) *Index {
	items := make([]item, 0, len(regions))
	fullCover := make([]contracts.CalibrationRegion, 0)
	for _, region := range regions {
		if region.CoversEntireMap {
			fullCover = append(fullCover, region)
			continue
		}
		box := bounds{region.Rectangle.MinX, region.Rectangle.MaxX, region.YRange.Min, region.YRange.Max, region.Rectangle.MinZ, region.Rectangle.MaxZ}
		items = append(items, item{region: region, box: box})
	}
	return &Index{root: buildNode(items), fullCover: fullCover}
}

func buildNode(items []item) *node {
	if len(items) == 0 {
		return nil
	}
	n := &node{box: unionItems(items)}
	if len(items) <= 8 {
		n.items = items
		return n
	}
	dx, dy, dz := n.box.maxX-n.box.minX, n.box.maxY-n.box.minY, n.box.maxZ-n.box.minZ
	axis := 0
	if dy > dx && dy >= dz {
		axis = 1
	} else if dz > dx {
		axis = 2
	}
	sort.Slice(items, func(i, j int) bool { return center(items[i].box, axis) < center(items[j].box, axis) })
	step := (len(items) + 7) / 8
	for start := 0; start < len(items); start += step {
		end := start + step
		if end > len(items) {
			end = len(items)
		}
		n.children = append(n.children, buildNode(items[start:end]))
	}
	return n
}

func center(b bounds, axis int) float64 {
	switch axis {
	case 1:
		return (b.minY + b.maxY) / 2
	case 2:
		return (b.minZ + b.maxZ) / 2
	default:
		return (b.minX + b.maxX) / 2
	}
}
func unionItems(items []item) bounds {
	b := items[0].box
	for _, v := range items[1:] {
		b = union(b, v.box)
	}
	return b
}
func union(a, b bounds) bounds {
	return bounds{math.Min(a.minX, b.minX), math.Max(a.maxX, b.maxX), math.Min(a.minY, b.minY), math.Max(a.maxY, b.maxY), math.Min(a.minZ, b.minZ), math.Max(a.maxZ, b.maxZ)}
}
func contains(b bounds, p contracts.WorldPosition) bool {
	return p.X >= b.minX && p.X < b.maxX && p.Y >= b.minY && p.Y < b.maxY && p.Z >= b.minZ && p.Z < b.maxZ
}

func (i *Index) Query(p contracts.WorldPosition) []contracts.CalibrationRegion {
	if i == nil {
		return nil
	}
	var out []contracts.CalibrationRegion
	for _, region := range i.fullCover {
		if p.Y >= region.YRange.Min && p.Y < region.YRange.Max {
			out = append(out, region)
		}
	}
	if i.root == nil {
		return out
	}
	var walk func(*node)
	walk = func(n *node) {
		if n == nil || !contains(n.box, p) {
			return
		}
		for _, child := range n.children {
			walk(child)
		}
		for _, v := range n.items {
			if contains(v.box, p) {
				out = append(out, v.region)
			}
		}
	}
	walk(i.root)
	return out
}
