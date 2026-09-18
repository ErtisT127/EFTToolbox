import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type {
  Annotation,
  MapData,
  MapPreference,
  Point,
  Sticker,
} from '../../../../contracts/ts/ipc.gen';
import { pixelToWorld } from './lib/geometry';
import {
  accent,
  latLng,
  isAnnotationVisible,
  paintAnnotations,
  hitAnnotation,
} from './lib/annotations';
import { BuiltinMarkers } from './lib/BuiltinMarkers';
import { zoomRange } from './lib/zoom';
import { useLocale } from '../../hooks/useLocale';

export type Tool = 'select' | 'edit' | 'brush' | 'marker' | 'text' | 'eraser';
export type ToolOptions = {
  color: string;
  width: number;
  emoji: string;
  imageId: string;
  text: string;
  textSize: number;
  eraserSize: number;
};
type Props = {
  data: MapData;
  preference: MapPreference;
  stickers: Map<string, Sticker>;
  items: Annotation[];
  tool: Tool;
  options: ToolOptions;
  onCommit: (items: Annotation[]) => void;
  onView: (center: number[], zoom: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSelectTool: (tool: Tool) => void;
  onTemporaryHand: (active: boolean) => void;
  onActivateFloor: (floorId: string) => void;
  onCursor: (point: Point | null) => void;
  onZoomChange: (state: { zoom: number; min: number; max: number }) => void;
  onReady: (map: L.Map | null) => void;
};
const point = (value: L.LatLng): Point => ({ x: value.lng, y: -value.lat });

export function MapCanvas(props: Props) {
  const { t } = useLocale();
  const container = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  useEffect(() => {
    current.current = props;
  });
  const mapRef = useRef<L.Map | null>(null);
  const baseRef = useRef<SVGElement | null>(null);
  const tileLayers = useRef<L.LayerGroup | null>(null);
  const userLayer = useRef<L.LayerGroup | null>(null);
  const builtins = useRef<BuiltinMarkers | null>(null);
  const renderUsers = useRef<(items: Annotation[]) => void>(() => {});
  const [ready, setReady] = useState(0);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const host = container.current!;
    const p = current.current;
    const affine = p.data.tiles[0]?.transform;
    const crs = affine
      ? L.extend({}, L.CRS.Simple, {
          transformation: new L.Transformation(affine[0], affine[1], -affine[2], affine[3]),
        })
      : L.CRS.Simple;
    const range = zoomRange(p.data, host.clientWidth, host.clientHeight);
    const map = L.map(host, {
      crs,
      zoomControl: false,
      markerZoomAnimation: false,
      attributionControl: false,
      minZoom: range.min,
      maxZoom: range.max,
      zoomSnap: 0.1,
      zoomDelta: 1,
      wheelPxPerZoomLevel: 120,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      preferCanvas: true,
    });
    mapRef.current = map;
    let zoomTimer: ReturnType<typeof setTimeout>;
    const fadeMarkers = () => {
      clearTimeout(zoomTimer);
      host.classList.add('markers-zooming');
    };
    const settleMarkers = () => {
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(() => host.classList.remove('markers-zooming'), 160);
    };
    const wheelMarkers = () => {
      fadeMarkers();
      zoomTimer = setTimeout(settleMarkers, 400);
    };
    map.on('zoomstart', fadeMarkers);
    map.on('zoomend', settleMarkers);
    host.addEventListener('wheel', wheelMarkers, { passive: true });
    const [x, y, width, height] = p.data.projection.viewBox;
    const bounds = L.latLngBounds([
      [-y - height, x],
      [-y, x + width],
    ]);
    const navigable = L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast());
    for (const marker of p.data.markers) navigable.extend(latLng(marker.position));
    map.setMaxBounds(navigable.pad(1));
    if (p.preference.center.length === 2)
      map.setView(p.preference.center as L.LatLngTuple, p.preference.zoom);
    else map.fitBounds(bounds, { padding: [48, 48] });
    const basePane = map.createPane('base');
    basePane.style.zIndex = '200';
    basePane.style.pointerEvents = 'none';
    const tilePane = map.createPane('satellite');
    tilePane.style.zIndex = '190';
    tilePane.style.pointerEvents = 'none';
    const landmarkPane = map.createPane('landmarks');
    landmarkPane.style.zIndex = '450';
    landmarkPane.style.pointerEvents = 'none';
    tileLayers.current = L.layerGroup().addTo(map);
    userLayer.current = L.layerGroup().addTo(map);
    builtins.current = new BuiltinMarkers(
      p.data,
      () => userLayer.current?.getLayers() || [],
      (floorId) => current.current.onActivateFloor(floorId),
    ).addTo(map);
    const preview = L.layerGroup().addTo(map);
    const selection = new Set<string>();
    const controller = new AbortController();
    setError('');
    setReady((value) => value + 1);
    if (p.data.svgUrl)
      fetch(p.data.svgUrl, { signal: controller.signal, cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error('map.canvas.loadFailed');
          const text = await response.text();
          if (controller.signal.aborted) return;
          const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
          if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg')
            throw new Error('map.canvas.svgInvalid');
          doc.querySelectorAll('script, foreignObject, iframe, image').forEach((e) => e.remove());
          doc.querySelectorAll('*').forEach((e) =>
            Array.from(e.attributes).forEach((a) => {
              if (/^on/i.test(a.name) || (a.localName === 'href' && !a.value.startsWith('#')))
                e.removeAttribute(a.name);
            }),
          );
          const svg = document.importNode(doc.documentElement, true) as unknown as SVGElement;
          baseRef.current = svg;
          L.svgOverlay(svg, bounds, { pane: 'base', interactive: false }).addTo(map);
          setReady((value) => value + 1);
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setError(error instanceof Error ? error.message : 'map.canvas.loadFailed');
        });

    const isVisible = (a: Annotation) => isAnnotationVisible(a, current.current.preference);
    function paint(items: Annotation[]) {
      paintAnnotations(
        userLayer.current!,
        items,
        current.current.preference,
        current.current.stickers,
        selection,
      );
    }
    renderUsers.current = paint;
    paint(p.items);
    let space = false;
    type Gesture = {
      kind: Tool | 'pan' | 'box';
      builtin: number | null;
      start: L.Point;
      startPoint: Point;
      points: Point[];
      original: Annotation[];
      draft: Annotation[];
      dragIds: Set<string>;
      moved: boolean;
      pointerId: number;
      last: L.Point;
    };
    let gesture: Gesture | null = null;
    let builtinClick = false;
    const eventPixel = (event: PointerEvent) => map.mouseEventToContainerPoint(event);
    const toPoint = (pixel: L.Point) => point(map.containerPointToLatLng(pixel));
    function hit(a: Annotation, pixel: Point, radius = 8) {
      return hitAnnotation(map, a, pixel, current.current.preference, radius);
    }
    function erase(g: Gesture, pixel: Point) {
      const o = current.current.options;
      g.draft = g.draft.filter((a) => !hit(a, pixel, o.eraserSize / 2));
      paint(g.draft);
    }
    function down(event: PointerEvent) {
      builtinClick = false;
      if (event.button !== 0 && event.button !== 1) return;
      if (
        event.button === 0 &&
        !space &&
        ['select', 'edit'].includes(current.current.tool) &&
        event.target instanceof Element &&
        event.target.closest('.leaflet-popup')
      )
        return;
      host.focus();
      if (gesture) return;
      const pixel = eventPixel(event),
        original = current.current.items;
      const target = [...original].reverse().find((a) => hit(a, pixel));
      const mode = space ? 'edit' : current.current.tool;
      const tool =
        event.button === 1 ||
        (mode === 'select' && !event.shiftKey) ||
        (mode === 'edit' && !target && !event.shiftKey)
          ? 'pan'
          : event.shiftKey && ['select', 'edit'].includes(mode)
            ? target
              ? 'select'
              : 'box'
            : mode;
      const dragIds = new Set<string>();
      if (tool === 'edit' || tool === 'select') {
        if (target) {
          if (!selection.has(target.id) && !event.shiftKey) selection.clear();
          if (event.shiftKey && selection.has(target.id)) selection.delete(target.id);
          else selection.add(target.id);
          if (tool === 'edit')
            selection.forEach((id) => {
              if (original.some((a) => a.id === id && isVisible(a))) dragIds.add(id);
            });
        } else if (!event.shiftKey) selection.clear();
      }
      gesture = {
        kind: tool,
        builtin: !target ? (builtins.current?.hit(pixel, event.target) ?? null) : null,
        start: pixel,
        startPoint: toPoint(pixel),
        points: [toPoint(pixel)],
        original,
        draft: original,
        dragIds,
        moved: false,
        pointerId: event.pointerId,
        last: pixel,
      };
      if (
        gesture.builtin === null ||
        !['select', 'edit'].includes(mode) ||
        event.button !== 0 ||
        event.shiftKey ||
        space
      )
        builtins.current?.clearHover();
      map.dragging.disable();
      host.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      if (tool === 'eraser') erase(gesture, pixel);
      else paint(original);
    }
    function move(event: PointerEvent) {
      const pixel = eventPixel(event),
        p = toPoint(pixel),
        g = gesture;
      current.current.onCursor(pixelToWorld(p, current.current.data.projection));
      if (!g) return;
      if (g.start.distanceTo(pixel) > 3) g.moved = true;
      if (g.moved && (g.kind === 'pan' || (g.kind === 'edit' && g.dragIds.size)))
        host.classList.add('panning');
      if (g.kind === 'pan') map.panBy(g.last.subtract(pixel), { animate: false });
      if (g.kind === 'brush' && g.last.distanceTo(pixel) >= 2) {
        g.points.push(p);
        preview.clearLayers();
        L.polyline(g.points.map(latLng), {
          color: current.current.options.color,
          weight: current.current.options.width,
          interactive: false,
        }).addTo(preview);
      }
      if (g.kind === 'eraser') erase(g, pixel);
      if ((g.kind === 'edit' || g.kind === 'box') && g.moved) {
        if (g.dragIds.size) {
          const dx = p.x - g.startPoint.x,
            dy = p.y - g.startPoint.y;
          g.draft = g.original.map((a) =>
            g.dragIds.has(a.id)
              ? { ...a, points: a.points.map((v) => ({ x: v.x + dx, y: v.y + dy })) }
              : a,
          );
          paint(g.draft);
        } else {
          preview.clearLayers();
          L.rectangle([latLng(g.startPoint), latLng(p)], {
            color: accent(),
            weight: 1,
            fillOpacity: 0.1,
            interactive: false,
          }).addTo(preview);
        }
      }
      g.last = pixel;
      event.preventDefault();
      event.stopPropagation();
    }
    function finish(event: PointerEvent, cancel = false) {
      const g = gesture;
      if (!g) return;
      gesture = null;
      host.classList.remove('panning');
      preview.clearLayers();
      if (host.hasPointerCapture(g.pointerId)) host.releasePointerCapture(g.pointerId);
      if (cancel) {
        paint(current.current.items);
        return;
      }
      const p = current.current,
        o = p.options;
      if ((g.kind === 'marker' || (g.kind === 'text' && o.text.trim())) && !g.moved)
        g.draft = [
          ...g.original,
          {
            id: crypto.randomUUID(),
            floorId: p.preference.floorId,
            kind: 'marker',
            points: [g.startPoint],
            color: o.color,
            width: o.width,
            // A sticker and an emoji are mutually exclusive glyphs for the same marker.
            emoji: g.kind === 'marker' && !o.imageId ? o.emoji : '',
            imageId: g.kind === 'marker' ? o.imageId : '',
            text: o.text.trim(),
            textSize: o.textSize,
          },
        ];
      if (g.kind === 'brush')
        g.draft = [
          ...g.original,
          {
            id: crypto.randomUUID(),
            floorId: p.preference.floorId,
            kind: 'stroke',
            points: g.points.length > 1 ? g.points : [...g.points, g.points[0]],
            color: o.color,
            width: o.width,
            emoji: '',
            imageId: '',
            text: '',
            textSize: o.textSize,
          },
        ];
      if (g.kind === 'pan' && !g.moved && p.tool === 'select' && !space && event.button === 0) {
        selection.clear();
        const target = [...g.original].reverse().find((a) => hit(a, g.start));
        if (target) selection.add(target.id);
      }
      if ((g.kind === 'edit' || g.kind === 'box') && !g.dragIds.size && g.moved) {
        const end = toPoint(eventPixel(event));
        for (const a of g.original.filter(isVisible)) {
          if (
            a.points.some(
              (v) =>
                v.x >= Math.min(g.startPoint.x, end.x) &&
                v.x <= Math.max(g.startPoint.x, end.x) &&
                v.y >= Math.min(g.startPoint.y, end.y) &&
                v.y <= Math.max(g.startPoint.y, end.y),
            )
          )
            selection.add(a.id);
        }
      }
      if (g.draft !== g.original) p.onCommit(g.draft);
      paint(g.draft);
      if (
        !g.moved &&
        g.builtin !== null &&
        ['select', 'edit'].includes(p.tool) &&
        !event.shiftKey &&
        !space &&
        event.button === 0
      ) {
        builtinClick = true;
        builtins.current?.activate(g.builtin);
      }
      event.preventDefault();
      event.stopPropagation();
    }
    function context(event: MouseEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (current.current.tool !== 'edit') return;
      const pixel = map.mouseEventToContainerPoint(event),
        target = [...current.current.items].reverse().find((a) => hit(a, pixel));
      if (!target) return;
      const ids = selection.has(target.id) ? selection : new Set([target.id]);
      current.current.onCommit(
        current.current.items.filter((a) => !ids.has(a.id) || !isVisible(a)),
      );
      selection.clear();
    }
    const typing = (event: KeyboardEvent) =>
      event.target instanceof HTMLElement &&
      (event.target.closest('input,textarea,select,button,a,[role="button"]') !== null ||
        event.target.isContentEditable);
    function cancelGesture() {
      if (!gesture) return;
      if (host.hasPointerCapture(gesture.pointerId)) host.releasePointerCapture(gesture.pointerId);
      paint(gesture.original);
      gesture = null;
      preview.clearLayers();
      host.classList.remove('panning');
    }
    function keydown(event: KeyboardEvent) {
      if (typing(event)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (!space) {
          cancelGesture();
          space = true;
          current.current.onTemporaryHand(true);
        }
      }
      if (event.key === 'Escape') {
        space = false;
        current.current.onTemporaryHand(false);
        cancelGesture();
        selection.clear();
        paint(current.current.items);
        current.current.onSelectTool('select');
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) current.current.onRedo();
        else current.current.onUndo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        current.current.onRedo();
      }
      if (current.current.tool === 'edit' && event.key === 'Delete' && selection.size) {
        event.preventDefault();
        current.current.onCommit(
          current.current.items.filter((a) => !selection.has(a.id) || !isVisible(a)),
        );
        selection.clear();
      }
      if (
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) &&
        document.activeElement === host
      ) {
        event.preventDefault();
        const dx = event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0,
          dy = event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 : 0;
        if (current.current.tool === 'edit' && selection.size) {
          current.current.onCommit(
            current.current.items.map((a) =>
              selection.has(a.id) && isVisible(a)
                ? {
                    ...a,
                    points: a.points.map((p) =>
                      toPoint(map.latLngToContainerPoint(latLng(p)).add([dx, dy])),
                    ),
                  }
                : a,
            ),
          );
        } else map.panBy([dx * 4, dy * 4]);
      }
    }
    function keyup(event: KeyboardEvent) {
      if (event.code === 'Space') {
        cancelGesture();
        space = false;
        host.classList.remove('panning');
        current.current.onTemporaryHand(false);
      }
    }
    function blur() {
      space = false;
      current.current.onTemporaryHand(false);
      host.classList.remove('panning');
      cancelGesture();
    }
    const up = (e: PointerEvent) => finish(e),
      cancel = (e: PointerEvent) => finish(e, true),
      leave = () => current.current.onCursor(null);
    const preventDrag = (event: DragEvent) => event.preventDefault();
    const consumeBuiltinClick = (event: MouseEvent) => {
      if (!builtinClick) return;
      builtinClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    map.dragging.disable();
    host.addEventListener('pointerdown', down, true);
    host.addEventListener('pointermove', move, true);
    host.addEventListener('pointerup', up, true);
    host.addEventListener('pointercancel', cancel, true);
    host.addEventListener('contextmenu', context, true);
    host.addEventListener('pointerleave', leave);
    host.addEventListener('dragstart', preventDrag);
    host.addEventListener('click', consumeBuiltinClick, true);
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    const onMove = () => {
      const center = map.getCenter();
      current.current.onView([center.lat, center.lng], map.getZoom());
    };
    map.on('moveend', onMove);
    const publishZoom = () =>
      current.current.onZoomChange({
        zoom: map.getZoom(),
        min: map.getMinZoom(),
        max: map.getMaxZoom(),
      });
    map.on('zoomend zoomlevelschange', publishZoom);
    // The lower bound follows the window, so a small window can still show the whole map.
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
      map.setMinZoom(zoomRange(current.current.data, host.clientWidth, host.clientHeight).min);
    });
    observer.observe(host);
    current.current.onReady(map);
    publishZoom();
    setReady((value) => value + 1);
    return () => {
      controller.abort();
      current.current.onTemporaryHand(false);
      clearTimeout(zoomTimer);
      host.removeEventListener('wheel', wheelMarkers);
      host.removeEventListener('dragstart', preventDrag);
      host.removeEventListener('click', consumeBuiltinClick, true);
      host.classList.remove('markers-zooming');
      observer.disconnect();
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
      host.removeEventListener('pointerdown', down, true);
      host.removeEventListener('pointermove', move, true);
      host.removeEventListener('pointerup', up, true);
      host.removeEventListener('pointercancel', cancel, true);
      host.removeEventListener('contextmenu', context, true);
      host.removeEventListener('pointerleave', leave);
      map.off('moveend', onMove);
      map.off('zoomend zoomlevelschange', publishZoom);
      current.current.onReady(null);
      builtins.current?.remove();
      builtins.current = null;
      map.remove();
      mapRef.current = null;
      baseRef.current = null;
    };
  }, [retry]);

  const { data, preference, items } = props;
  const raster = preference.basemap === 'tiles';
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const size = map.getSize();
    const max = zoomRange(data, size.x, size.y).max;
    const clampZoom = () => {
      if (map.getZoom() > max) map.setZoom(max, { animate: false });
    };
    // A zoom already animating can finish above a newly lowered basemap limit.
    map.on('zoomend', clampZoom);
    map.setMaxZoom(max);
    clampZoom();
    return () => {
      map.off('zoomend', clampZoom);
    };
  }, [data, preference.basemap, ready]);
  useEffect(() => {
    const group = tileLayers.current;
    if (!group) return;
    group.clearLayers();
    if (!raster) return;
    const active = data.tiles.find((t) => t.floorId === preference.floorId);
    const base = data.tiles.find((t) => t.floorId === data.baseFloor) || data.tiles[0];
    for (const tile of [base, ...(active && active !== base ? [active] : [])]) {
      if (!tile) continue;
      L.tileLayer(tile.url, {
        pane: 'satellite',
        tileSize: tile.tileSize,
        minNativeZoom: tile.minZoom,
        maxNativeZoom: tile.maxZoom,
        minZoom: -10,
        maxZoom: 12,
        noWrap: true,
        bounds: L.latLngBounds(tile.bounds.map(latLng)),
        opacity: tile === base && preference.floorId !== base.floorId ? 0.2 : 1,
      })
        .on('tileerror', () => setError('map.canvas.tileFailed'))
        .addTo(group);
    }
    return () => {
      group.clearLayers();
    };
  }, [data, preference.floorId, raster, ready]);
  useEffect(() => {
    const svg = baseRef.current;
    if (!svg) return;
    const active = data.floors.find((f) => f.id === preference.floorId)!;
    const base = data.floors.find((f) => f.id === data.baseFloor)!;
    const tileFloor = data.tiles.some((t) => t.floorId === active.id);
    svg.style.display = raster && tileFloor ? 'none' : '';
    const groups = new Set(data.floors.flatMap((f) => f.svgGroups));
    for (const child of Array.from(svg.children))
      if (child.tagName.toLowerCase() === 'g') {
        const linked = child.getAttribute('data-keep-with-group');
        if (groups.has(child.id) || linked || child.id) {
          const belongs = (ids: string[]) =>
            ids.includes(child.id) || (!!linked && ids.includes(linked));
          const selected = belongs(active.svgGroups),
            background = !raster && belongs(base.svgGroups);
          (child as SVGElement).style.display = selected || background ? '' : 'none';
          (child as SVGElement).style.opacity = background && !selected ? '0.2' : '1';
          if (selected) svg.appendChild(child);
        }
      }
  }, [data, preference.floorId, raster, ready]);
  useEffect(() => {
    builtins.current?.setPreference(preference);
  }, [
    data,
    preference,
    preference.floorId,
    preference.hiddenCategories,
    preference.selectedTasks,
    preference.taskFilterActive,
    ready,
  ]);
  useEffect(() => {
    renderUsers.current(items);
  }, [items, preference.floorId, preference.showAnnotations, ready]);
  useEffect(() => {
    if (props.tool === 'select' || props.tool === 'edit') mapRef.current?.doubleClickZoom.enable();
    else mapRef.current?.doubleClickZoom.disable();
  }, [props.tool, ready]);
  return (
    <>
      <div
        ref={container}
        className={`leaflet-container map-canvas tool-${props.tool}`}
        tabIndex={0}
        aria-label={t('map.canvas.aria', { name: props.data.name })}
      />
      {error && (
        <div className="canvas-error" role="alert">
          {t(error)}
          <button onClick={() => setRetry((v) => v + 1)}>{t('map.canvas.reload')}</button>
        </div>
      )}
    </>
  );
}
