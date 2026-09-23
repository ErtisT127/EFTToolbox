import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type {
  CalibrationRegion,
  MapData,
  MapPreference,
  WorldRectXZ,
  WorldXZ,
} from '../../../../contracts/ts/ipc.gen';
import { pixelToWorld, worldToPixel } from '../map/lib/geometry';
import { accent, latLng } from '../map/lib/annotations';
import { MapViewport } from '../map/MapViewport';

export const MIN_REGION_SIZE = 5;
const HANDLE_HIT_RADIUS = 18;
export type CalibrationTool = 'select' | 'edit' | 'rect' | 'resize';
type Props = {
  data: MapData;
  preference: MapPreference;
  regions: CalibrationRegion[];
  selectedId: string | null;
  tool: CalibrationTool;
  onCreate: (r: WorldRectXZ) => void;
  onSelect: (id: string | null) => void;
  onChangeRectangle: (id: string, r: WorldRectXZ) => void;
  onCommitRectangle: () => void;
  onTool: (tool: CalibrationTool) => void;
  onCursor: (p: WorldXZ | null) => void;
  onReady?: (map: L.Map) => void;
  onMapError?: (error: string) => void;
};
type Handle = { x: -1 | 0 | 1; z: -1 | 0 | 1 };
type RegionView = {
  shape: L.Polygon;
  label: L.Tooltip | null;
  hoverTooltip: L.Tooltip | null;
  rectangleKey: string;
  name: string;
};
const handles: Handle[] = [
  { x: -1, z: -1 },
  { x: 0, z: -1 },
  { x: 1, z: -1 },
  { x: 1, z: 0 },
  { x: 1, z: 1 },
  { x: 0, z: 1 },
  { x: -1, z: 1 },
  { x: -1, z: 0 },
];
const corners = (r: WorldRectXZ): WorldXZ[] => [
  { x: r.minX, z: r.minZ },
  { x: r.maxX, z: r.minZ },
  { x: r.maxX, z: r.maxZ },
  { x: r.minX, z: r.maxZ },
];
const handlePoint = (r: WorldRectXZ, h: Handle): WorldXZ => ({
  x: h.x < 0 ? r.minX : h.x > 0 ? r.maxX : (r.minX + r.maxX) / 2,
  z: h.z < 0 ? r.minZ : h.z > 0 ? r.maxZ : (r.minZ + r.maxZ) / 2,
});
const rectangleKey = (r: WorldRectXZ) => `${r.minX},${r.maxX},${r.minZ},${r.maxZ}`;

export function CalibrationViewport(props: Props) {
  const current = useRef(props);
  current.current = props;
  const repaint = useRef(() => {});
  const cancelDrag = useRef(() => {});
  const mount = (map: L.Map) => {
    const host = map.getContainer(),
      regionLayer = L.layerGroup().addTo(map),
      labelLayer = L.layerGroup().addTo(map),
      handleLayer = L.layerGroup().addTo(map),
      preview = L.layerGroup().addTo(map);
    const regionViews = new Map<string, RegionView>();
    const labelWidths = new Map<string, number>();
    const measureContext = document.createElement('canvas').getContext('2d');
    const rootStyle = getComputedStyle(document.documentElement);
    if (measureContext)
      measureContext.font = `${rootStyle.getPropertyValue('--weight-bold').trim() || '600'} ${
        rootStyle.getPropertyValue('--text-sm').trim() || '12px'
      } ${rootStyle.getPropertyValue('--font-ui').trim() || 'sans-serif'}`;
    map.dragging.disable();
    const project = (p: WorldXZ) => latLng(worldToPixel(p, current.current.data.projection));
    const world = (event: PointerEvent) => {
      const p = map.containerPointToLatLng(map.mouseEventToContainerPoint(event));
      return pixelToWorld({ x: p.lng, y: -p.lat }, current.current.data.projection);
    };
    const hitAt = (point: WorldXZ) =>
      [...current.current.regions]
        .reverse()
        .find(
          ({ rectangle: r, coversEntireMap }) =>
            !coversEntireMap &&
            point.x >= r.minX &&
            point.x <= r.maxX &&
            point.z >= r.minZ &&
            point.z <= r.maxZ,
        );
    const handleAt = (region: CalibrationRegion | undefined, pixel: L.Point) =>
      region &&
      handles.find(
        (h) =>
          map.latLngToContainerPoint(project(handlePoint(region.rectangle, h))).distanceTo(pixel) <=
          HANDLE_HIT_RADIUS,
      );
    const handleCursor = (handle: Handle) =>
      handle.x === 0
        ? 'ns-resize'
        : handle.z === 0
          ? 'ew-resize'
          : handle.x === handle.z
            ? 'nwse-resize'
            : 'nesw-resize';
    const labelWidth = (name: string) => {
      const cached = labelWidths.get(name);
      if (cached !== undefined) return cached;
      const width = measureContext
        ? Math.ceil(measureContext.measureText(name).width) + 16
        : [...name].reduce(
            (total, character) => total + (character.codePointAt(0)! > 0x2e80 ? 14 : 8),
            0,
          ) + 12;
      labelWidths.set(name, width);
      return width;
    };
    let tooltipLocked = false;
    let hoveredRegionId: string | null = null;
    let tooltipTimer: ReturnType<typeof setTimeout> | null = null;
    let frame: number | null = null;
    let layoutLabelsPending = false;
    const closeRegionTooltip = (id: string | null) => {
      if (id) regionViews.get(id)?.hoverTooltip?.close();
    };
    const lockTooltips = () => {
      tooltipLocked = true;
      if (tooltipTimer) clearTimeout(tooltipTimer);
      tooltipTimer = null;
      closeRegionTooltip(hoveredRegionId);
    };
    const unlockTooltips = (reopen: boolean) => {
      if (tooltipTimer) clearTimeout(tooltipTimer);
      tooltipTimer = setTimeout(() => {
        tooltipLocked = false;
        tooltipTimer = null;
        if (reopen) closeRegionTooltip(hoveredRegionId);
        if (reopen && hoveredRegionId) regionViews.get(hoveredRegionId)?.hoverTooltip?.openOn(map);
      }, 80);
    };
    const updateLabel = (view: RegionView, region: CalibrationRegion) => {
      const points = corners(region.rectangle).map(project);
      const screenBounds = L.bounds(points.map((point) => map.latLngToContainerPoint(point)));
      const center = project({
        x: (region.rectangle.minX + region.rectangle.maxX) / 2,
        z: (region.rectangle.minZ + region.rectangle.maxZ) / 2,
      });
      const size = screenBounds.getSize();
      const showLabel = size.x >= labelWidth(region.name) && size.y >= 20;
      view.name = region.name;
      if (showLabel) {
        if (view.hoverTooltip) {
          view.hoverTooltip.close();
          labelLayer.removeLayer(view.hoverTooltip);
          view.hoverTooltip = null;
        }
        if (!view.label)
          view.label = L.tooltip({
            permanent: true,
            direction: 'center',
            offset: [0, 0],
            className: 'region-label',
          })
            .setLatLng(center)
            .setContent(region.name)
            .addTo(labelLayer);
        else view.label.setLatLng(center).setContent(region.name);
      } else {
        if (view.label) {
          labelLayer.removeLayer(view.label);
          view.label = null;
        }
        if (!view.hoverTooltip) {
          view.hoverTooltip = L.tooltip({
            direction: 'top',
            offset: [0, -8],
            className: 'region-label',
          })
            .setLatLng(center)
            .setContent(region.name)
            .addTo(labelLayer);
        } else view.hoverTooltip.setLatLng(center).setContent(region.name);
        if (hoveredRegionId === region.id && !tooltipLocked) view.hoverTooltip.openOn(map);
      }
    };
    const updateHandles = () => {
      handleLayer.clearLayers();
      const p = current.current;
      const selected = p.regions.find((region) => region.id === p.selectedId);
      if (!selected || selected.coversEntireMap || p.tool !== 'resize') return;
      for (const h of handles)
        L.circleMarker(project(handlePoint(selected.rectangle, h)), {
          radius: 5,
          color: accent(),
          fillColor: '#1a1e1d',
          fillOpacity: 1,
          weight: 2,
          className: `region-handle region-handle-${handleCursor(h)}`,
          interactive: false,
        }).addTo(handleLayer);
    };
    const syncRegions = () => {
      const p = current.current;
      const nextIds = new Set<string>();
      for (const region of p.regions) {
        if (region.coversEntireMap) continue;
        nextIds.add(region.id);
        const key = rectangleKey(region.rectangle);
        const selected = region.id === p.selectedId;
        const resizing = selected && p.tool === 'resize';
        const points = corners(region.rectangle).map(project);
        let view = regionViews.get(region.id);
        if (!view) {
          const shape = L.polygon(points, {
            color: accent(),
            weight: resizing ? 3 : selected ? 2.5 : 1.5,
            fillOpacity: resizing ? 0.22 : selected ? 0.18 : 0.1,
            interactive: true,
            dashArray: resizing || selected ? undefined : '5 4',
          }).addTo(regionLayer);
          view = {
            shape,
            label: null,
            hoverTooltip: null,
            rectangleKey: key,
            name: region.name,
          };
          regionViews.set(region.id, view);
          updateLabel(view, region);
        } else {
          const geometryChanged = view.rectangleKey !== key;
          const nameChanged = view.name !== region.name;
          if (geometryChanged) {
            view.shape.setLatLngs(points);
            view.rectangleKey = key;
          }
          view.shape.setStyle({
            weight: resizing ? 3 : selected ? 2.5 : 1.5,
            fillOpacity: resizing ? 0.22 : selected ? 0.18 : 0.1,
            dashArray: resizing || selected ? undefined : '5 4',
          });
          if (geometryChanged || nameChanged) updateLabel(view, region);
        }
      }
      for (const [id, view] of regionViews) {
        if (nextIds.has(id)) continue;
        if (view.label) labelLayer.removeLayer(view.label);
        view.hoverTooltip?.close();
        if (view.hoverTooltip) labelLayer.removeLayer(view.hoverTooltip);
        regionLayer.removeLayer(view.shape);
        regionViews.delete(id);
      }
      updateHandles();
    };
    const layoutLabels = () => {
      for (const region of current.current.regions) {
        const view = regionViews.get(region.id);
        if (view) updateLabel(view, region);
      }
    };
    let regionsPending = false;
    const queueFrame = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const sync = regionsPending;
        const layout = layoutLabelsPending;
        regionsPending = false;
        layoutLabelsPending = false;
        if (sync) syncRegions();
        if (layout) layoutLabels();
      });
    };
    const scheduleRegions = () => {
      regionsPending = true;
      queueFrame();
    };
    const scheduleMapLayout = () => {
      layoutLabelsPending = true;
      queueFrame();
    };
    repaint.current = scheduleRegions;
    map.on('zoomend resize', scheduleMapLayout);
    type Drag = {
      kind: 'pan' | 'rect' | 'move' | 'resize';
      pointerId: number;
      startPixel: L.Point;
      lastPixel: L.Point;
      start: WorldXZ;
      region?: CalibrationRegion;
      handle?: Handle;
      rectangle?: WorldRectXZ;
    };
    let drag: Drag | null = null;
    const cancel = () => {
      const g = drag;
      drag = null;
      if (g && host.hasPointerCapture(g.pointerId)) host.releasePointerCapture(g.pointerId);
      preview.clearLayers();
      host.classList.remove('panning');
      host.style.cursor = '';
      if (g) unlockTooltips(false);
    };
    cancelDrag.current = cancel;
    const down = (event: PointerEvent) => {
      if (![0, 1, 2].includes(event.button) || drag) return;
      host.focus();
      const p = current.current,
        start = world(event),
        pixel = map.mouseEventToContainerPoint(event),
        selected = p.regions.find((r) => r.id === p.selectedId),
        hit = hitAt(start);
      if (event.button === 1) {
        drag = {
          kind: 'pan',
          pointerId: event.pointerId,
          startPixel: pixel,
          lastPixel: pixel,
          start,
        };
      } else if (p.tool === 'resize') {
        if (
          event.button === 2 &&
          selected &&
          !selected.coversEntireMap &&
          hit?.id === selected.id
        ) {
          drag = {
            kind: 'move',
            pointerId: event.pointerId,
            startPixel: pixel,
            lastPixel: pixel,
            start,
            region: selected,
          };
        } else if (event.button === 0) {
          const handle =
            selected && !selected.coversEntireMap ? handleAt(selected, pixel) : undefined;
          if (selected && handle) {
            drag = {
              kind: 'resize',
              pointerId: event.pointerId,
              startPixel: pixel,
              lastPixel: pixel,
              start,
              region: selected,
              handle,
            };
            host.style.cursor = handleCursor(handle);
          } else if (hit) p.onSelect(hit.id);
          else p.onSelect(null);
        }
      } else if (p.tool === 'select' && event.button === 0) {
        if (hit) p.onSelect(hit.id);
        else {
          drag = {
            kind: 'pan',
            pointerId: event.pointerId,
            startPixel: pixel,
            lastPixel: pixel,
            start,
          };
        }
      } else if (p.tool === 'rect')
        drag = {
          kind: 'rect',
          pointerId: event.pointerId,
          startPixel: pixel,
          lastPixel: pixel,
          start,
        };
      else if (p.tool === 'edit' && event.button === 0) {
        if (hit) p.onSelect(hit.id);
        drag = {
          kind: hit ? 'move' : 'pan',
          pointerId: event.pointerId,
          startPixel: pixel,
          lastPixel: pixel,
          start,
          region: hit,
        };
      }
      hoveredRegionId = hit?.id || null;
      if (drag) {
        lockTooltips();
        host.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      event.stopPropagation();
    };
    const move = (event: PointerEvent) => {
      const p = world(event),
        pixel = map.mouseEventToContainerPoint(event),
        g = drag,
        hit = hitAt(p);
      if (!g) {
        const nextHoveredRegionId = hit?.id || null;
        if (nextHoveredRegionId !== hoveredRegionId) {
          closeRegionTooltip(hoveredRegionId);
          hoveredRegionId = nextHoveredRegionId;
          if (hoveredRegionId && !tooltipLocked)
            regionViews.get(hoveredRegionId)?.hoverTooltip?.openOn(map);
        }
      } else hoveredRegionId = hit?.id || null;
      current.current.onCursor(p);
      if (!g) {
        const selected = current.current.regions.find((r) => r.id === current.current.selectedId);
        const handle =
          current.current.tool === 'resize' && selected && !selected.coversEntireMap
            ? handleAt(selected, pixel)
            : undefined;
        host.style.cursor = handle
          ? handleCursor(handle)
          : (current.current.tool === 'edit' || current.current.tool === 'resize') &&
              selected?.coversEntireMap
            ? 'not-allowed'
            : '';
        return;
      }
      if (g.kind === 'resize' && g.handle) host.style.cursor = handleCursor(g.handle);
      if (g.kind === 'pan') {
        host.classList.add('panning');
        map.panBy(g.lastPixel.subtract(pixel), { animate: false });
      } else if (g.kind === 'rect') {
        g.rectangle = {
          minX: Math.min(p.x, g.start.x),
          maxX: Math.max(p.x, g.start.x),
          minZ: Math.min(p.z, g.start.z),
          maxZ: Math.max(p.z, g.start.z),
        };
        preview.clearLayers();
        L.polygon(corners(g.rectangle).map(project), {
          color: accent(),
          weight: 2,
          dashArray: '5 4',
          fillOpacity: 0.18,
          interactive: false,
        }).addTo(preview);
      } else if (g.region) {
        const r = g.region.rectangle,
          dx = p.x - g.start.x,
          dz = p.z - g.start.z;
        const next =
          g.kind === 'move'
            ? { minX: r.minX + dx, maxX: r.maxX + dx, minZ: r.minZ + dz, maxZ: r.maxZ + dz }
            : {
                minX: g.handle!.x < 0 ? Math.min(r.maxX - MIN_REGION_SIZE, r.minX + dx) : r.minX,
                maxX: g.handle!.x > 0 ? Math.max(r.minX + MIN_REGION_SIZE, r.maxX + dx) : r.maxX,
                minZ: g.handle!.z < 0 ? Math.min(r.maxZ - MIN_REGION_SIZE, r.minZ + dz) : r.minZ,
                maxZ: g.handle!.z > 0 ? Math.max(r.minZ + MIN_REGION_SIZE, r.maxZ + dz) : r.maxZ,
              };
        g.rectangle = next;
        current.current.onChangeRectangle(g.region.id, next);
      }
      g.lastPixel = pixel;
      event.preventDefault();
      event.stopPropagation();
    };
    const up = (event: PointerEvent) => {
      if (!drag) return;
      move(event);
      const g = drag;
      drag = null;
      if (host.hasPointerCapture(g.pointerId)) host.releasePointerCapture(g.pointerId);
      preview.clearLayers();
      host.classList.remove('panning');
      if (
        g.kind === 'rect' &&
        g.rectangle &&
        g.startPixel.distanceTo(g.lastPixel) > 5 &&
        g.rectangle.maxX - g.rectangle.minX >= MIN_REGION_SIZE &&
        g.rectangle.maxZ - g.rectangle.minZ >= MIN_REGION_SIZE
      )
        current.current.onCreate(g.rectangle);
      if (g.kind === 'pan' && g.startPixel.distanceTo(g.lastPixel) <= 5 && !hitAt(world(event)))
        current.current.onSelect(null);
      if (g.kind === 'move' || g.kind === 'resize') current.current.onCommitRectangle();
      host.style.cursor = '';
      unlockTooltips(true);
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('input,textarea,select,[contenteditable="true"]')
      )
        return;
      const tool = (
        { v: 'select', e: 'edit', r: 'rect', s: 'resize' } as Record<string, CalibrationTool>
      )[event.key.toLowerCase()];
      if (event.key === 'Escape' || tool) {
        event.preventDefault();
        cancel();
        if (tool !== 'resize' || current.current.selectedId)
          current.current.onTool(tool || 'select');
      }
    };
    const leave = () => {
      current.current.onCursor(null);
      if (!drag) {
        closeRegionTooltip(hoveredRegionId);
        hoveredRegionId = null;
        host.style.cursor = '';
      }
    };
    const contextMenu = (event: MouseEvent) => event.preventDefault();
    host.addEventListener('pointerdown', down, true);
    host.addEventListener('contextmenu', contextMenu);
    host.addEventListener('pointermove', move, true);
    host.addEventListener('pointerup', up, true);
    host.addEventListener('pointercancel', cancel);
    host.addEventListener('lostpointercapture', cancel);
    host.addEventListener('pointerleave', leave);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', cancel);
    syncRegions();
    return () => {
      cancel();
      if (tooltipTimer) clearTimeout(tooltipTimer);
      if (frame !== null) cancelAnimationFrame(frame);
      host.removeEventListener('pointerdown', down, true);
      host.removeEventListener('contextmenu', contextMenu);
      host.removeEventListener('pointermove', move, true);
      host.removeEventListener('pointerup', up, true);
      host.removeEventListener('pointercancel', cancel);
      host.removeEventListener('lostpointercapture', cancel);
      host.removeEventListener('pointerleave', leave);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', cancel);
      map.off('zoomend resize', scheduleMapLayout);
      regionLayer.remove();
      labelLayer.remove();
      handleLayer.remove();
      preview.remove();
      repaint.current = () => {};
      cancelDrag.current = () => {};
    };
  };
  useEffect(() => {
    repaint.current();
  }, [props.regions, props.selectedId, props.tool]);
  useEffect(() => {
    cancelDrag.current();
  }, [props.data.id, props.preference.floorId, props.preference.basemap, props.tool]);
  return (
    <MapViewport
      data={props.data}
      preference={props.preference}
      className="calibration-viewport"
      onMount={(map) => {
        props.onReady?.(map);
        return mount(map);
      }}
      onError={props.onMapError}
    />
  );
}
