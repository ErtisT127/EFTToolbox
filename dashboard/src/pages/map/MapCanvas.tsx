import { mapDisplay } from '../../../../contracts/ts/map-display.gen';
import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { useTranslation } from 'react-i18next';
import type {
  Annotation,
  MapData,
  MapPreference,
  PlayerState,
  MapPoint,
  WorldXZ,
  Sticker,
} from '../../../../contracts/ts/ipc.gen';
import { pixelToWorld } from './lib/geometry';
import {
  accent,
  latLng,
  isAnnotationVisible,
  paintAnnotations,
  hitAnnotation,
  type OwnerVisibility,
} from './lib/annotations';
import { BuiltinMarkers } from './lib/BuiltinMarkers';
import { MapViewport } from './MapViewport';

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
  onCursor: (point: WorldXZ | null) => void;
  onZoomChange: (state: { zoom: number; min: number; max: number }) => void;
  onReady: (map: L.Map | null) => void;
  onError?: (error: string) => void;
  onProgress?: (value: number) => void;
  onTileBusy?: (busy: boolean) => void;
  players: Map<string, PlayerState>;
  playerSource?: {
    current: Map<string, PlayerState>;
    subscribe: (listener: () => void) => () => void;
  };
  playerFollow?: boolean;
  playerAutoZoom?: { enabled: boolean; zoomLevel: number };
  readOnly?: boolean;
  /** The local player's id, stamped onto every annotation this client creates. */
  ownerId: string;
  /** Teammate visibility context; absent in read-only mirrors and tests (no owner filtering). */
  ownerVisibility?: OwnerVisibility;
};
const point = (value: L.LatLng): MapPoint => ({ x: value.lng, y: -value.lat });

export function MapCanvas(props: Props) {
  const { t } = useTranslation();
  const current = useRef(props);
  useEffect(() => {
    current.current = props;
  });
  const mapRef = useRef<L.Map | null>(null);
  const userLayer = useRef<L.LayerGroup | null>(null);
  const playerLayer = useRef<L.LayerGroup | null>(null);
  const builtins = useRef<BuiltinMarkers | null>(null);
  const renderUsers = useRef<(items: Annotation[]) => void>(() => {});
  const renderPlayers = useRef<(players: Map<string, PlayerState>) => void>(() => {});
  const basemapProgress = useRef(0);
  const iconsSettled = useRef(false);
  const [ready, setReady] = useState(0);
  // Progress arrives from several sources (basemap, tiles, marker icons) and can land out of order,
  // so the loading overlay only ever moves forward. It holds at 92 until the builtin icons have
  // painted too; otherwise a phone would show the map with its markers still missing.
  const reportSettled = () => {
    if (iconsSettled.current && basemapProgress.current >= 92) current.current.onProgress?.(95);
  };
  const reportProgress = (value: number) => {
    if (value > basemapProgress.current) basemapProgress.current = value;
    current.current.onProgress?.(basemapProgress.current);
    reportSettled();
  };
  const mount = (map: L.Map) => {
    const host = map.getContainer();
    const p = current.current;
    mapRef.current = map;
    basemapProgress.current = 0;
    iconsSettled.current = false;
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
    const landmarkPane = map.createPane('landmarks');
    landmarkPane.style.zIndex = String(mapDisplay.landmarkPane);
    landmarkPane.style.pointerEvents = 'none';
    const playerPane = map.createPane('player');
    playerPane.style.zIndex = String(mapDisplay.playerPane);
    playerPane.style.pointerEvents = 'none';
    map.getPane('overlayPane')!.style.zIndex = String(mapDisplay.strokePane);
    map.getPane('markerPane')!.style.zIndex = String(mapDisplay.markerPane);
    userLayer.current = L.layerGroup().addTo(map);
    playerLayer.current = L.layerGroup().addTo(map);
    builtins.current = new BuiltinMarkers(
      p.data,
      () => userLayer.current?.getLayers() || [],
      (floorId) => current.current.onActivateFloor(floorId),
      () => {
        iconsSettled.current = true;
        reportSettled();
      },
    ).addTo(map);
    const preview = L.layerGroup().addTo(map);
    const selection = new Set<string>();
    const isVisible = (a: Annotation) =>
      isAnnotationVisible(a, current.current.preference, current.current.ownerVisibility);
    // Only the local player's markers are editable; teammates' synced markers render but never
    // move, delete or get erased here.
    const canModify = (a: Annotation) =>
      !current.current.ownerVisibility || a.ownerId === current.current.ownerVisibility.selfId;
    function paint(items: Annotation[]) {
      paintAnnotations(
        userLayer.current!,
        items,
        current.current.preference,
        current.current.stickers,
        selection,
        current.current.ownerVisibility,
      );
    }
    renderUsers.current = paint;
    paint(p.items);
    let pixelRatio = window.devicePixelRatio;
    const refreshPixelRatio = () => {
      if (pixelRatio === window.devicePixelRatio) return;
      pixelRatio = window.devicePixelRatio;
      paint(current.current.items);
      map.fire('resize');
    };
    window.addEventListener('resize', refreshPixelRatio);
    let followedPosition = '';
    const playerMarkers = new Map<string, { marker: L.Marker; element: HTMLDivElement }>();
    function paintPlayers(players: Map<string, PlayerState>) {
      const p = current.current;
      const layer = playerLayer.current;
      if (!layer) return;
      const visibleIds = new Set<string>();
      const self = [...players.values()].find(
        (player) => player.isSelf && player.mapId === p.data.id,
      );
      const positionKey = self
        ? `${self.playerId}:${self.mapPosition.x}:${self.mapPosition.y}`
        : '';
      if (self && positionKey !== followedPosition) {
        // Centre and zoom follow independently: the settings expose them as separate switches, so
        // either one is allowed to be on alone. A position that follows neither is left alone.
        const center = p.playerFollow === false ? undefined : latLng(self.mapPosition);
        const zoom = p.playerAutoZoom?.enabled ? p.playerAutoZoom.zoomLevel : undefined;
        if (center || zoom !== undefined) {
          followedPosition = positionKey;
          map.setView(center ?? map.getCenter(), zoom ?? map.getZoom(), { animate: false });
        }
      }
      for (const player of players.values()) {
        if (player.mapId !== p.data.id) continue;
        visibleIds.add(player.playerId);
        let entry = playerMarkers.get(player.playerId);
        if (!entry) {
          const element = document.createElement('div');
          element.className = 'player-marker';
          entry = {
            element,
            marker: L.marker(latLng(player.mapPosition), {
              pane: 'player',
              icon: L.divIcon({
                html: element,
                className: 'player-anchor',
                iconSize: [28, 28],
                iconAnchor: [14, 14],
              }),
              interactive: false,
              keyboard: false,
            }),
          };
          playerMarkers.set(player.playerId, entry);
          layer.addLayer(entry.marker);
        } else {
          entry.marker.setLatLng(latLng(player.mapPosition));
        }
        const element = entry.element;
        // Every arrow carries its owner's multiplayer colour — your own included, so the panel's
        // choice is what you see; the CSS keeps the accent for an unset one.
        element.style.background = player.color || '';
        // The arrow tip points up at zero degrees; rotate it to the player's heading.
        element.style.transform = `rotate(${player.heading}deg)`;
        element.style.opacity =
          player.resolution.status === 'resolved' &&
          player.resolution.floorId !== null &&
          player.resolution.floorId !== p.preference.floorId
            ? '0.35'
            : '1';
        element.title = player.displayName;
      }
      for (const [playerId, entry] of playerMarkers) {
        if (visibleIds.has(playerId)) continue;
        layer.removeLayer(entry.marker);
        playerMarkers.delete(playerId);
      }
    }
    renderPlayers.current = paintPlayers;
    paintPlayers(p.playerSource?.current || p.players);
    const unsubscribePlayers = p.playerSource?.subscribe(() =>
      paintPlayers(p.playerSource!.current),
    );
    let space = false;
    type Gesture = {
      kind: Tool | 'pan' | 'box';
      builtin: number | null;
      start: L.Point;
      startPoint: MapPoint;
      points: MapPoint[];
      original: Annotation[];
      draft: Annotation[];
      dragIds: Set<string>;
      moved: boolean;
      pointerId: number;
      last: L.Point;
      accepted: L.Point;
    };
    let gesture: Gesture | null = null;
    let brushFrame = 0;
    let brushPreview: L.Polyline | null = null;
    let dragFrame = 0;
    let pendingDragDraft: Annotation[] | null = null;
    const scheduleDragPaint = (draft: Annotation[]) => {
      pendingDragDraft = draft;
      if (dragFrame) return;
      dragFrame = requestAnimationFrame(() => {
        dragFrame = 0;
        if (pendingDragDraft) paint(pendingDragDraft);
        pendingDragDraft = null;
      });
    };
    function clearBrush() {
      cancelAnimationFrame(brushFrame);
      brushFrame = 0;
      brushPreview = null;
    }
    let builtinClick = false;
    const readOnlyTooltip = L.tooltip({ direction: 'top', offset: [0, -12] });
    let pinnedAnnotationId: string | null = null;
    let singleTouch: { started: number; x: number; y: number; moved: boolean } | null = null;
    let suppressSyntheticClick: { x: number; y: number; until: number } | null = null;
    let touchTap: { started: number; center: L.Point; distance: number; moved: boolean } | null =
      null;
    let lastTwoFingerTap = 0;
    const eventPixel = (event: PointerEvent) => map.mouseEventToContainerPoint(event);
    const toPoint = (pixel: L.Point) => point(map.containerPointToLatLng(pixel));
    function hit(a: Annotation, pixel: MapPoint, radius = 8) {
      return hitAnnotation(
        map,
        a,
        pixel,
        current.current.preference,
        radius,
        current.current.ownerVisibility,
      );
    }
    function erase(g: Gesture, pixel: MapPoint) {
      const o = current.current.options;
      g.draft = g.draft.filter((a) => !canModify(a) || !hit(a, pixel, o.eraserSize / 2));
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
      const target = current.current.readOnly
        ? undefined
        : [...original].reverse().find((a) => hit(a, pixel) && canModify(a));
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
              if (original.some((a) => a.id === id && isVisible(a) && canModify(a)))
                dragIds.add(id);
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
        accepted: pixel,
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
      if (g.kind === 'brush') {
        const samples = event.getCoalescedEvents?.();
        for (const sample of samples?.length ? samples : [event]) {
          const position = eventPixel(sample);
          if (g.accepted.distanceTo(position) >= 2) {
            g.points.push(toPoint(position));
            g.accepted = position;
          }
        }
        if (!brushFrame)
          brushFrame = requestAnimationFrame(() => {
            brushFrame = 0;
            if (gesture !== g) return;
            brushPreview ??= L.polyline([], {
              color: current.current.options.color,
              weight: current.current.options.width,
              interactive: false,
            }).addTo(preview);
            brushPreview.setLatLngs(g.points.map(latLng));
          });
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
          scheduleDragPaint(g.draft);
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
      if (!cancel && g.kind === 'brush') {
        const endpoint = eventPixel(event);
        if (g.accepted.distanceTo(endpoint) > 0) g.points.push(toPoint(endpoint));
      }
      clearBrush();
      cancelAnimationFrame(dragFrame);
      dragFrame = 0;
      pendingDragDraft = null;
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
            ownerId: current.current.ownerId,
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
            ownerId: current.current.ownerId,
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
        const target = [...g.original].reverse().find((a) => hit(a, g.start) && canModify(a));
        if (target) selection.add(target.id);
      }
      if ((g.kind === 'edit' || g.kind === 'box') && !g.dragIds.size && g.moved) {
        const end = toPoint(eventPixel(event));
        for (const a of g.original.filter((a) => isVisible(a) && canModify(a))) {
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
      if (!p.readOnly && g.draft !== g.original) p.onCommit(g.draft);
      paint(g.draft);
      if (
        !g.moved &&
        g.builtin !== null &&
        !p.readOnly &&
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
      if (current.current.readOnly || current.current.tool !== 'edit') return;
      const pixel = map.mouseEventToContainerPoint(event),
        target = [...current.current.items].reverse().find((a) => hit(a, pixel));
      if (!target) return;
      const ids = selection.has(target.id) ? selection : new Set([target.id]);
      current.current.onCommit(
        current.current.items.filter((a) => !ids.has(a.id) || !isVisible(a) || !canModify(a)),
      );
      selection.clear();
    }
    const typing = (event: KeyboardEvent) =>
      event.target instanceof HTMLElement &&
      (event.target.closest('input,textarea,select,button,a,[role="button"]') !== null ||
        event.target.isContentEditable);
    function cancelGesture() {
      clearBrush();
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
      if (
        !current.current.readOnly &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'z'
      ) {
        event.preventDefault();
        if (event.shiftKey) current.current.onRedo();
        else current.current.onUndo();
      }
      if (
        !current.current.readOnly &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'y'
      ) {
        event.preventDefault();
        current.current.onRedo();
      }
      if (
        !current.current.readOnly &&
        current.current.tool === 'edit' &&
        event.key === 'Delete' &&
        selection.size
      ) {
        event.preventDefault();
        current.current.onCommit(
          current.current.items.filter(
            (a) => !selection.has(a.id) || !isVisible(a) || !canModify(a),
          ),
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
        if (!current.current.readOnly && current.current.tool === 'edit' && selection.size) {
          current.current.onCommit(
            current.current.items.map((a) =>
              selection.has(a.id) && isVisible(a) && canModify(a)
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
    const handledReadOnlyEvents = new WeakSet<Event>();
    const readOnlyClick = (
      pixel: L.Point,
      target: EventTarget | null,
      originalEvent?: Event,
    ): boolean => {
      if (!current.current.readOnly) return false;
      if (originalEvent) {
        if (handledReadOnlyEvents.has(originalEvent)) return false;
        handledReadOnlyEvents.add(originalEvent);
      }
      const builtin = builtins.current?.hit(pixel, target);
      if (builtin !== null && builtin !== undefined) {
        pinnedAnnotationId = null;
        readOnlyTooltip.remove();
        const position = builtins.current?.getPosition(builtin);
        if (position)
          map.setView(latLng(position), map.getZoom(), { animate: true, duration: 0.12 });
        builtins.current?.activate(builtin);
        return true;
      }
      const annotation = [...current.current.items].reverse().find((item) => hit(item, pixel));
      if (annotation) {
        if (pinnedAnnotationId === annotation.id) {
          pinnedAnnotationId = null;
          readOnlyTooltip.remove();
          return true;
        }
        pinnedAnnotationId = annotation.id;
        map.setView(latLng(annotation.points[0]), map.getZoom(), { animate: true, duration: 0.12 });
        const content = annotation.text || annotation.emoji || t('map.canvas.annotation');
        const label = document.createElement('span');
        label.textContent = content;
        readOnlyTooltip.setLatLng(latLng(annotation.points[0])).setContent(label).addTo(map);
        return true;
      }
      pinnedAnnotationId = null;
      readOnlyTooltip.remove();
      return false;
    };
    const readOnlyDomClick = (event: MouseEvent) => {
      if (suppressSyntheticClick && performance.now() < suppressSyntheticClick.until) {
        const x = event.clientX - host.getBoundingClientRect().left;
        const y = event.clientY - host.getBoundingClientRect().top;
        if (L.point(x, y).distanceTo([suppressSyntheticClick.x, suppressSyntheticClick.y]) <= 24) {
          suppressSyntheticClick = null;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      if (readOnlyClick(map.mouseEventToContainerPoint(event), event.target, event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const readOnlyMapClick = (event: L.LeafletMouseEvent) => {
      readOnlyClick(event.containerPoint, event.originalEvent.target, event.originalEvent);
    };
    const touchStart = (event: TouchEvent) => {
      if (!current.current.readOnly) return;
      suppressSyntheticClick = null;
      if (event.touches.length === 1) {
        const touch = event.touches[0];
        singleTouch = {
          started: performance.now(),
          x: touch.clientX,
          y: touch.clientY,
          moved: false,
        };
        touchTap = null;
        return;
      }
      singleTouch = null;
      if (event.touches.length !== 2) return;
      const a = event.touches[0],
        b = event.touches[1];
      touchTap = {
        started: performance.now(),
        center: L.point((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2),
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        moved: false,
      };
    };
    const touchMove = (event: TouchEvent) => {
      if (singleTouch && event.touches.length === 1) {
        const touch = event.touches[0];
        if (Math.hypot(touch.clientX - singleTouch.x, touch.clientY - singleTouch.y) > 12)
          singleTouch.moved = true;
      }
      if (!touchTap || event.touches.length !== 2) return;
      const a = event.touches[0],
        b = event.touches[1];
      const center = L.point((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (center.distanceTo(touchTap.center) > 12 || Math.abs(distance - touchTap.distance) > 12)
        touchTap.moved = true;
    };
    const touchEnd = (event: TouchEvent) => {
      if (event.touches.length === 0 && singleTouch) {
        const tap = singleTouch;
        singleTouch = null;
        const touch = event.changedTouches[0];
        const rect = host.getBoundingClientRect();
        if (touch && !tap.moved && performance.now() - tap.started <= 300) {
          const pixel = L.point(touch.clientX - rect.left, touch.clientY - rect.top);
          if (readOnlyClick(pixel, event.target, event)) {
            event.preventDefault();
            event.stopPropagation();
            suppressSyntheticClick = { x: pixel.x, y: pixel.y, until: performance.now() + 300 };
          }
        }
      }
      if (!touchTap || event.touches.length !== 0) return;
      const tap = touchTap;
      touchTap = null;
      if (tap.moved || performance.now() - tap.started > 250) return;
      const now = performance.now();
      if (now - lastTwoFingerTap <= 350) {
        event.preventDefault();
        map.setZoom(Math.max(map.getMinZoom(), map.getZoom() - 1), {
          animate: true,
          duration: 0.12,
        });
        lastTwoFingerTap = 0;
      } else lastTwoFingerTap = now;
    };
    if (current.current.readOnly) {
      map.dragging.enable();
      map.touchZoom.enable();
      host.addEventListener('click', readOnlyDomClick, true);
      map.on('click', readOnlyMapClick);
      host.addEventListener('touchstart', touchStart, { passive: true });
      host.addEventListener('touchmove', touchMove, { passive: true });
      host.addEventListener('touchend', touchEnd, { passive: false });
    } else {
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
    }
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
    current.current.onReady(map);
    publishZoom();
    setReady((value) => value + 1);
    return () => {
      window.removeEventListener('resize', refreshPixelRatio);
      unsubscribePlayers?.();
      current.current.onTemporaryHand(false);
      clearTimeout(zoomTimer);
      clearBrush();
      host.removeEventListener('wheel', wheelMarkers);
      if (!current.current.readOnly) {
        host.removeEventListener('dragstart', preventDrag);
        host.removeEventListener('click', consumeBuiltinClick, true);
      }
      if (current.current.readOnly) {
        host.removeEventListener('click', readOnlyDomClick, true);
        map.off('click', readOnlyMapClick);
        host.removeEventListener('touchstart', touchStart);
        host.removeEventListener('touchmove', touchMove);
        host.removeEventListener('touchend', touchEnd);
        readOnlyTooltip.remove();
      }
      host.classList.remove('markers-zooming');
      if (!current.current.readOnly) {
        window.removeEventListener('keydown', keydown);
        window.removeEventListener('keyup', keyup);
        window.removeEventListener('blur', blur);
        host.removeEventListener('pointerdown', down, true);
        host.removeEventListener('pointermove', move, true);
        host.removeEventListener('pointerup', up, true);
        host.removeEventListener('pointercancel', cancel, true);
        host.removeEventListener('contextmenu', context, true);
        host.removeEventListener('pointerleave', leave);
      }
      map.off('moveend', onMove);
      map.off('zoomend zoomlevelschange', publishZoom);
      current.current.onReady(null);
      builtins.current?.remove();
      builtins.current = null;
      playerLayer.current?.clearLayers();
      playerLayer.current = null;
      mapRef.current = null;
    };
  };

  const { data, preference, items } = props;
  // The workspace hands out a fresh preference object (and fresh arrays) on every render, so key the
  // marker refresh on the values that actually change what it draws. Depending on the object itself
  // rebuilt every marker on each render and wiped the hover tooltip as the pointer moved.
  const hiddenCategories = preference.hiddenCategories.join('\u0000');
  const selectedTasks = preference.selectedTasks.join('\u0000');
  useEffect(() => {
    builtins.current?.setPreference(current.current.preference);
  }, [
    data,
    preference.floorId,
    preference.taskFilterActive,
    hiddenCategories,
    selectedTasks,
    ready,
  ]);
  useEffect(() => {
    renderUsers.current(items);
  }, [items, preference.floorId, preference.showAnnotations, props.ownerVisibility, ready]);
  useEffect(() => {
    if (!props.playerSource) renderPlayers.current(props.players);
  }, [
    props.players,
    props.playerSource,
    preference.floorId,
    props.playerFollow,
    props.playerAutoZoom,
    ready,
  ]);
  useEffect(() => {
    if (props.tool === 'select' || props.tool === 'edit') mapRef.current?.doubleClickZoom.enable();
    else mapRef.current?.doubleClickZoom.disable();
  }, [props.tool, ready]);
  return (
    <MapViewport
      data={data}
      preference={preference}
      className={`tool-${props.tool}`}
      onMount={mount}
      onError={props.onError}
      onProgress={reportProgress}
      onTileBusy={props.onTileBusy}
      readOnly={props.readOnly}
    />
  );
}
