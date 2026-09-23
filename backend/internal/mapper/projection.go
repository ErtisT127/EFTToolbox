package mapper

import (
	contracts "efttoolbox/contracts"
	"math"
)

func Project(m contracts.MapData, p contracts.WorldPosition) contracts.MapPoint {
	a := m.Projection.Rotation * math.Pi / 180
	c, s := math.Cos(a), math.Sin(a)
	rotate := func(x, z float64) (float64, float64) { return x*c - z*s, x*s + z*c }
	b := m.Projection.Bounds
	minX, minZ, maxX, maxZ := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, q := range []contracts.WorldXZ{b[0], b[1], {X: b[0].X, Z: b[1].Z}, {X: b[1].X, Z: b[0].Z}} {
		x, z := rotate(q.X, q.Z)
		minX, maxX = math.Min(minX, x), math.Max(maxX, x)
		minZ, maxZ = math.Min(minZ, z), math.Max(maxZ, z)
	}
	x, z := rotate(p.X, p.Z)
	box := m.Projection.ViewBox
	return contracts.MapPoint{X: box[0] + (x-minX)/(maxX-minX)*box[2], Y: box[1] + (maxZ-z)/(maxZ-minZ)*box[3]}
}
