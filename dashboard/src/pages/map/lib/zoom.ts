import type { MapData } from '../../../../../contracts/ts/ipc.gen';

// SVG-only maps use L.CRS.Simple
export const SVG_MAX_ZOOM = 4;
// Room below the fit zoom, so the lower bound is a soft edge instead of a stop that feels stuck.
export const ZOOM_FIT_SLACK = 0.5;
// The map snaps zoom to 0.1, so bound comparisons allow half a step instead of testing equality.
export const ZOOM_BOUND_EPSILON = 0.05;

// Screen pixels per world unit at zoom 0. The map CRS is built from the first tile layer's
// transform (L.Transformation(a, b, -c, d)); SVG-only maps map one viewBox unit to one pixel.
function unitScale(data: MapData): [number, number] {
  const transform = data.tiles[0]?.transform;
  return transform ? [Math.abs(transform[0]), Math.abs(transform[2])] : [1, 1];
}

// Zoom bounds for one map: the deepest level keeps tiles upscaled one step past their native max
// (as tarkov.dev does), and the shallowest is where the whole map still fits the window. Every
// zoom entry point shares these two numbers - wheel, zoom buttons and Fit - so the control and the
// wheel can never disagree about where the map stops.
export function zoomRange(data: MapData, width: number, height: number, padding = 48) {
  const nativeMin = data.tiles.length ? Math.min(...data.tiles.map((t) => t.minZoom)) : undefined;
  const max = data.tiles.length ? Math.max(...data.tiles.map((t) => t.maxZoom)) + 1 : SVG_MAX_ZOOM;
  const [scaleX, scaleY] = unitScale(data);
  const [, , mapWidth, mapHeight] = data.projection.viewBox;
  // The same "contain" fit Leaflet's getBoundsZoom computes for the Fit button, whose 48px padding
  // is subtracted once per axis. It is read from the container rather than asked of the map,
  // because getBoundsZoom clamps to the map's own bound and would ratchet the floor upward for good.
  const contain = Math.min(
    (width - padding) / (scaleX * mapWidth),
    (height - padding) / (scaleY * mapHeight),
  );
  // Before the container has been measured there is no fit zoom; tiled maps know their floor anyway.
  if (!(contain > 0)) return { min: nativeMin ?? 0, max };
  const fit = Math.log2(contain) - ZOOM_FIT_SLACK;
  return { min: nativeMin === undefined ? fit : Math.min(nativeMin, fit), max };
}
