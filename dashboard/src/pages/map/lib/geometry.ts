import type { Point, Projection } from '../../../../../contracts/ts/ipc.gen';

function rotate(point: Point, degrees: number): Point {
  const angle = (degrees * Math.PI) / 180;
  return {
    x: point.x * Math.cos(angle) - point.y * Math.sin(angle),
    y: point.x * Math.sin(angle) + point.y * Math.cos(angle),
  };
}

function projectedBounds(projection: Projection) {
  const [a, b] = projection.bounds;
  const corners = [a, b, { x: a.x, y: b.y }, { x: b.x, y: a.y }].map((p) =>
    rotate(p, projection.rotation),
  );
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    maxX: Math.max(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxY: Math.max(...corners.map((p) => p.y)),
  };
}

// World horizontal coordinates are (x, z); SVG coordinates are (x, y), downwards.
export function worldToPixel(point: Point, projection: Projection): Point {
  const p = rotate(point, projection.rotation),
    b = projectedBounds(projection);
  const [x, y, width, height] = projection.viewBox;
  return {
    x: x + ((p.x - b.minX) / (b.maxX - b.minX)) * width,
    y: y + ((b.maxY - p.y) / (b.maxY - b.minY)) * height,
  };
}

export function pixelToWorld(point: Point, projection: Projection): Point {
  const b = projectedBounds(projection),
    [x, y, width, height] = projection.viewBox;
  return rotate(
    {
      x: b.minX + ((point.x - x) / width) * (b.maxX - b.minX),
      y: b.maxY - ((point.y - y) / height) * (b.maxY - b.minY),
    },
    -projection.rotation,
  );
}

// Affine mapping from our stable SVG/map coordinates to the upstream tile grid at zoom 0.
export function tileTransform(projection: Projection, transform: number[]): number[] {
  const project = (p: Point) => {
    const world = rotate(pixelToWorld(p, projection), projection.rotation);
    return { x: transform[0] * world.x + transform[1], y: -transform[2] * world.y + transform[3] };
  };
  const origin = project({ x: 0, y: 0 }),
    right = project({ x: 1, y: 0 }),
    down = project({ x: 0, y: 1 });
  return [right.x - origin.x, origin.x, down.y - origin.y, origin.y];
}

export function segmentDistance(point: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}
