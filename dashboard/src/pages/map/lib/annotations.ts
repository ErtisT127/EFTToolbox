import { mapDisplay } from '../../../../../contracts/ts/map-display.gen';
import L from 'leaflet';
import type {
  Annotation,
  MapPreference,
  MapPoint,
  Sticker,
} from '../../../../../contracts/ts/ipc.gen';
import { segmentDistance } from './geometry';
import { rimmedArtwork } from './artwork';
import { isAnnotationVisible, type OwnerVisibility } from './visibility';

export { isAnnotationVisible } from './visibility';
export type { OwnerVisibility } from './visibility';

export const latLng = (MapPoint: MapPoint): L.LatLngTuple => [-MapPoint.y, MapPoint.x];

// Leaflet paints every vector layer onto a canvas (`preferCanvas`), so CSS never reaches these
// colours and the design token has to be read into JS. Cached because paint() also runs from
// pointer handlers, and each getComputedStyle would otherwise force a style recalculation.
let cachedAccent: string | undefined;
export function accent() {
  cachedAccent ??= getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return cachedAccent;
}

// A stored sticker id can outlive the catalogue entry it points at, since a refresh may drop an
// image upstream no longer ships. Leaving the marker blank would give the user nothing to aim the
// eraser or a selection at, so the placeholder keeps it visible and deletable.
function placeholderSticker() {
  const missing = document.createElement('span');
  missing.className = 'annotation-sticker annotation-sticker-missing';
  missing.textContent = '?';
  return missing;
}

// The sticker slot, matching .annotation-sticker's width in map.css.
const StickerSize = mapDisplay.stickerSize;

type AnnotationLayer = L.Polyline | L.Marker;

function createAnnotationLayers(
  a: Annotation,
  selected: boolean,
  stickers: Map<string, Sticker>,
): AnnotationLayer[] {
  if (a.kind === 'stroke') {
    const layers: AnnotationLayer[] = [];
    if (selected)
      // A dashed ring under the stroke, opaque so it is not swallowed by a translucent halo.
      layers.push(
        L.polyline(a.points.map(latLng), {
          color: accent(),
          weight: a.width + 5,
          opacity: 1,
          dashArray: '6 4',
          smoothFactor: 1,
          interactive: false,
        }),
      );
    layers.push(
      L.polyline(a.points.map(latLng), {
        color: a.color,
        weight: a.width,
        smoothFactor: 1,
        interactive: false,
      }),
    );
    return layers;
  }

  const element = document.createElement('div');
  const glyph = a.imageId ? 'sticker' : a.emoji ? 'emoji' : 'text';
  element.className = `annotation-marker glyph-${glyph}${selected ? ' selected' : ''}`;
  const label = document.createElement('span');
  label.textContent = a.text;
  label.style.color = a.color;
  label.style.fontSize = `${a.textSize}px`;
  element.append(label);
  if (glyph === 'sticker') {
    const icon = stickers.get(a.imageId);
    // Badges retain their padding; portraits are cropped but do not get an extra white rim.
    const bare = !!icon && icon.group !== 'extract' && icon.group !== 'container';
    const fallback = document.createElement(icon ? 'img' : 'span');
    fallback.className = 'annotation-sticker';
    const baked =
      icon && bare
        ? rimmedArtwork(
            icon.iconUrl,
            StickerSize,
            window.devicePixelRatio || 1,
            (canvas) => fallback.replaceWith(canvas),
            !['boss', 'trader'].includes(icon.group),
          )
        : null;
    if (baked) {
      element.append(baked);
    } else {
      if (icon && fallback instanceof HTMLImageElement) {
        fallback.src = icon.iconUrl;
        fallback.alt = '';
        fallback.draggable = false;
        fallback.decoding = 'async';
        // The catalogue is built from whatever was cached, so a stored id can still miss
        // after a refresh drops the image. Swap in the placeholder rather than leaving a
        // broken-image box the user cannot recognise.
        fallback.addEventListener('error', () => {
          fallback.replaceWith(placeholderSticker());
        });
      } else {
        fallback.append(placeholderSticker());
      }
      element.append(fallback);
    }
  } else {
    if (a.emoji) {
      const emoji = document.createElement('span');
      emoji.className = 'annotation-emoji';
      emoji.textContent = a.emoji;
      element.append(emoji);
    }
  }
  return [
    L.marker(latLng(a.points[0]), {
      icon: L.divIcon({
        html: element,
        className: 'annotation-anchor',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      }),
      interactive: false,
      keyboard: false,
    }),
  ];
}

export class AnnotationRenderer {
  private readonly entries = new Map<
    string,
    { annotation: Annotation; layers: AnnotationLayer[] }
  >();

  constructor(private readonly layer: L.LayerGroup) {}

  paint(
    items: Annotation[],
    preference: MapPreference,
    stickers: Map<string, Sticker>,
    selection: Set<string>,
    owners?: OwnerVisibility,
  ) {
    this.layer.clearLayers();
    this.entries.clear();
    for (const annotation of items) {
      if (!isAnnotationVisible(annotation, preference, owners)) continue;
      const layers = createAnnotationLayers(annotation, selection.has(annotation.id), stickers);
      for (const annotationLayer of layers) annotationLayer.addTo(this.layer);
      this.entries.set(annotation.id, { annotation, layers });
    }
  }

  move(ids: Set<string>, offset: MapPoint) {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      const points = entry.annotation.points.map((value) => ({
        x: value.x + offset.x,
        y: value.y + offset.y,
      }));
      if (entry.annotation.kind === 'stroke') {
        for (const annotationLayer of entry.layers)
          (annotationLayer as L.Polyline).setLatLngs(points.map(latLng));
      } else {
        (entry.layers[0] as L.Marker).setLatLng(latLng(points[0]));
      }
    }
  }
}

export function hitAnnotation(
  map: L.Map,
  a: Annotation,
  pixel: MapPoint,
  preference: MapPreference,
  radius = 8,
  owners?: OwnerVisibility,
) {
  const screen = (p: MapPoint) => {
    const v = map.latLngToContainerPoint(latLng(p));
    return { x: v.x, y: v.y };
  };

  if (!isAnnotationVisible(a, preference, owners)) return false;
  if (a.kind === 'marker')
    return (
      Math.hypot(screen(a.points[0]).x - pixel.x, screen(a.points[0]).y - pixel.y) <= 18 + radius
    );
  return a.points.some((p, i) =>
    i
      ? segmentDistance(pixel, screen(a.points[i - 1]), screen(p)) <= radius + a.width / 2
      : Math.hypot(screen(p).x - pixel.x, screen(p).y - pixel.y) <= radius + a.width / 2,
  );
}
