import { mapDisplay } from '../../../../../contracts/ts/map-display.gen';
// Bare artwork — a loose-loot icon on the map, or a sticker that is not a badge — is drawn straight
// onto the map, so it gets a white silhouette rim to read apart from what is underneath. Four offset
// copies are baked into a canvas rather than left to a chained CSS drop-shadow: chained shadows
// compound (each one shadows the previous result), which made the same rim read heavier on stickers
// than on the map's own icons, and a fractional outline is lost altogether in Firefox.
//
// The offset stays well under a pixel — any more and it stops tracking the silhouette, reading
// instead as a soft pad behind the icon.
const RimOffset = mapDisplay.rimOffset;
// Room around the icon box for the rim to spill into.
const Pad = mapDisplay.iconPad;

/** The drawn pixels of an image, since item art carries transparent inventory-cell padding. */
function visibleBounds(image: HTMLImageElement): [number, number, number, number] {
  const { naturalWidth: width, naturalHeight: height } = image;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, width, height).data;
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (pixels[(y * width + x) * 4 + 3]) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
  return right < 0 ? [0, 0, width, height] : [left, top, right - left + 1, bottom - top + 1];
}

type Bake = {
  canvas?: HTMLCanvasElement;
  waiting: ((canvas: HTMLCanvasElement) => void)[];
  failedAt?: number;
};
const bakes = new Map<string, Bake>();
const Budget = 32 * 1024 * 1024;
function trimBakes() {
  let bytes = [...bakes.values()].reduce(
    (sum, bake) => sum + (bake.canvas ? bake.canvas.width * bake.canvas.height * 4 : 0),
    0,
  );
  for (const [key, bake] of bakes) {
    if (bytes <= Budget && bakes.size <= 512) break;
    if (!bake.canvas && !bake.failedAt) continue;
    bytes -= bake.canvas ? bake.canvas.width * bake.canvas.height * 4 : 0;
    bakes.delete(key);
  }
}

// Every caller needs its own element: an appended node is *moved*, so handing the same canvas to
// two stickers would leave one of them blank — and a clone comes out empty, so the baked pixels are
// drawn into a fresh canvas instead. This is what BuiltinMarkers.icon does with a cached sprite.
const copy = (canvas: HTMLCanvasElement): HTMLCanvasElement => {
  const duplicate = document.createElement('canvas');
  duplicate.width = canvas.width;
  duplicate.height = canvas.height;
  duplicate.getContext('2d')!.drawImage(canvas, 0, 0);
  duplicate.style.width = canvas.style.width;
  duplicate.style.height = canvas.style.height;
  duplicate.style.margin = canvas.style.margin;
  return duplicate;
};

/**
 * Rimmed artwork for one image, baked once per session. The first call answers `null` and calls back
 * when the bake lands; every later call answers synchronously — a repaint must never have to fall
 * back to the plain image, and dragging an annotation repaints the layer on every step.
 */
export function rimmedArtwork(
  url: string,
  box: number,
  dpr: number,
  ready: (canvas: HTMLCanvasElement) => void,
  rim = true,
): HTMLCanvasElement | null {
  const key = `${url}:${box}:${dpr}:${rim}`;
  let bake = bakes.get(key);
  if (bake?.failedAt && Date.now() - bake.failedAt > 10000) {
    bakes.delete(key);
    bake = undefined;
  }
  if (!bake) {
    bake = { waiting: [] };
    bakes.set(key, bake);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      const canvas = artwork(image, box, dpr, rim, true);
      bake!.canvas = canvas;
      for (const notify of bake!.waiting.splice(0)) notify(copy(canvas));
      trimBakes();
    };
    image.onerror = () => {
      bake!.failedAt = Date.now();
      bake!.waiting.length = 0;
      trimBakes();
    };
    image.src = url;
  }
  bakes.delete(key);
  bakes.set(key, bake);
  if (bake.canvas) return copy(bake.canvas);
  if (!bake.failedAt) bake.waiting.push(ready);
  return null;
}

/** The image fitted into a `box`-sized square, rimmed when asked, sized for the DOM slot. */
export function artwork(
  image: HTMLImageElement,
  box: number,
  dpr: number,
  rim: boolean,
  crop = rim,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.round((box + Pad * 2) * dpr);
  const size = canvas.width / dpr;
  const context = canvas.getContext('2d')!;
  context.scale(dpr, dpr);
  const [x, y, sourceWidth, sourceHeight] = crop
    ? visibleBounds(image)
    : [0, 0, image.naturalWidth, image.naturalHeight];
  const scale = box / Math.max(sourceWidth, sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  context.drawImage(
    image,
    x,
    y,
    sourceWidth,
    sourceHeight,
    (size - width) / 2,
    (size - height) / 2,
    width,
    height,
  );
  if (rim) {
    const shadow = document.createElement('canvas');
    shadow.width = shadow.height = canvas.width;
    const shadowContext = shadow.getContext('2d')!;
    context.resetTransform();
    for (const [dx, dy] of [
      [1, 1],
      [-1, -1],
      [-1, 1],
      [1, -1],
    ]) {
      shadowContext.clearRect(0, 0, shadow.width, shadow.height);
      shadowContext.drawImage(canvas, dx * RimOffset * dpr, dy * RimOffset * dpr);
      shadowContext.globalCompositeOperation = 'source-in';
      shadowContext.fillStyle = '#fff';
      shadowContext.fillRect(0, 0, shadow.width, shadow.height);
      shadowContext.globalCompositeOperation = 'source-over';
      shadowContext.drawImage(canvas, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(shadow, 0, 0);
    }
  }
  // The rim overhangs the icon box, so the canvas is sized past it and pulled back into place.
  canvas.style.width = canvas.style.height = `${size}px`;
  canvas.style.margin = `${(box - size) / 2}px`;
  return canvas;
}
