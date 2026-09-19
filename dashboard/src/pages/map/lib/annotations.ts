import { mapDisplay } from '../../../../../contracts/ts/map-display.gen';
import L from 'leaflet';
import type {
  Annotation,
  MapPreference,
  Point,
  Sticker,
} from '../../../../../contracts/ts/ipc.gen';
import { segmentDistance } from './geometry';
import { rimmedArtwork } from './artwork';

export const latLng = (point: Point): L.LatLngTuple => [-point.y, point.x];

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

export const isAnnotationVisible = (a: Annotation, preference: MapPreference) =>
  a.floorId === preference.floorId && preference.showAnnotations;

export function paintAnnotations(
  layer: L.LayerGroup,
  items: Annotation[],
  preference: MapPreference,
  stickers: Map<string, Sticker>,
  selection: Set<string>,
) {
  layer.clearLayers();
  for (const a of items.filter((a) => isAnnotationVisible(a, preference))) {
    const selected = selection.has(a.id);
    if (a.kind === 'stroke') {
      if (selected)
        // A dashed ring under the stroke, opaque so it is not swallowed by a translucent halo.
        L.polyline(a.points.map(latLng), {
          color: accent(),
          weight: a.width + 5,
          opacity: 1,
          dashArray: '6 4',
          interactive: false,
        }).addTo(layer);
      L.polyline(a.points.map(latLng), {
        color: a.color,
        weight: a.width,
        interactive: false,
      }).addTo(layer);
    } else {
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
        const code = mapDisplay.emoji[a.emoji as keyof typeof mapDisplay.emoji];
        if (code) {
          const emoji = document.createElement('img');
          emoji.className = 'annotation-emoji';
          emoji.src = `/api/map-assets/emoji-${code}.png`;
          emoji.alt = a.emoji;
          element.append(emoji);
        } else if (a.emoji) {
          const fallback = document.createElement('span');
          fallback.className = 'annotation-sticker-missing';
          fallback.textContent = '?';
          element.append(fallback);
        }
      }
      L.marker(latLng(a.points[0]), {
        icon: L.divIcon({
          html: element,
          className: 'annotation-anchor',
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        }),
        interactive: false,
        keyboard: false,
      }).addTo(layer);
    }
  }
}

export function hitAnnotation(
  map: L.Map,
  a: Annotation,
  pixel: Point,
  preference: MapPreference,
  radius = 8,
) {
  const screen = (p: Point) => {
    const v = map.latLngToContainerPoint(latLng(p));
    return { x: v.x, y: v.y };
  };

  if (!isAnnotationVisible(a, preference)) return false;
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
