import { OverlaySettingsLimits, MapPointLimits } from '../../../contracts/ts/ipc.gen';
import type { OverlaySettings } from '../../../contracts/ts/ipc.gen';

const size = OverlaySettingsLimits.width;

/** Rounds a size to the integer the contract allows. */
export function clampSize(value: number) {
  return Math.round(Math.min(size.max, Math.max(size.min, value)));
}

/** Rounds a coordinate for display. */
export function formatCoordinate(value: number) {
  return value.toFixed(MapPointLimits.x.precision);
}

/**
 * The one place the dashboard resolves a width/height edit: a circle stays square and a linked
 * aspect ratio scales both dimensions by the same factor, including when a bound stops it. The
 * overlay applies the same rule while dragging a handle.
 */
export function resizeOverlay(
  settings: OverlaySettings,
  key: 'width' | 'height',
  next: number,
): Partial<OverlaySettings> {
  if (settings.shape === 'circle') {
    const value = clampSize(next);
    return { width: value, height: value };
  }
  if (!settings.lockAspect) return { [key]: clampSize(next) };
  const factor = Math.min(
    size.max / settings.width,
    size.max / settings.height,
    Math.max(size.min / settings.width, size.min / settings.height, next / settings[key]),
  );
  return { width: clampSize(settings.width * factor), height: clampSize(settings.height * factor) };
}
