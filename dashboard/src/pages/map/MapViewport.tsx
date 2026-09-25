import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type { MapData, MapPreference } from '../../../../contracts/ts/ipc.gen';
import { latLng } from './lib/annotations';
import { zoomRange } from './lib/zoom';
import { useLocale } from '../../hooks/useLocale';
import { notices } from '../../stores/noticeStore';

type Props = {
  data: MapData;
  preference: MapPreference;
  className?: string;
  onMount: (map: L.Map) => () => void;
  onError?: (error: string) => void;
  onProgress?: (value: number) => void;
};

// The only owner of Leaflet and basemap lifetime. Feature layers attach via onMount.
export function MapViewport(props: Props) {
  const { t } = useLocale();
  const container = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const mapRef = useRef<L.Map | null>(null);
  const svgRef = useRef<SVGElement | null>(null);
  const tiles = useRef<L.LayerGroup | null>(null);
  const [ready, setReady] = useState(0);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const reportError = (message: string) => {
    if (current.current.onError) current.current.onError(message);
    else setError(message);
  };
  useEffect(() => {
    if (error) notices.push(t(error), () => setRetry((n) => n + 1));
  }, [error, t]);
  useEffect(() => {
    const host = container.current!;
    const { data, preference, onMount } = current.current;
    current.current.onProgress?.(30);
    const affine = data.tiles[0]?.transform;
    const crs = affine
      ? L.extend({}, L.CRS.Simple, {
          transformation: new L.Transformation(affine[0], affine[1], -affine[2], affine[3]),
        })
      : L.CRS.Simple;
    const range = zoomRange(data, host.clientWidth, host.clientHeight);
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
    const [x, y, width, height] = data.projection.viewBox;
    const bounds = L.latLngBounds([
      [-y - height, x],
      [-y, x + width],
    ]);
    const navigable = L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast());
    for (const marker of data.markers) navigable.extend(latLng(marker.position));
    map.setMaxBounds(navigable.pad(1));
    if (preference.center.length === 2)
      map.setView(preference.center as L.LatLngTuple, preference.zoom);
    else map.fitBounds(bounds, { padding: [48, 48] });
    for (const [name, zIndex] of [
      ['base', '200'],
      ['satellite', '190'],
    ]) {
      const pane = map.createPane(name);
      pane.style.zIndex = zIndex;
      pane.style.pointerEvents = 'none';
    }
    tiles.current = L.layerGroup().addTo(map);
    const controller = new AbortController();
    setError('');
    if (data.svgUrl)
      void fetch(data.svgUrl, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('map.canvas.loadFailed');
          const text = await response.text();
          if (controller.signal.aborted) return;
          current.current.onProgress?.(58);
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
          svgRef.current = svg;
          L.svgOverlay(svg, bounds, { pane: 'base', interactive: false }).addTo(map);
          current.current.onProgress?.(70);
          setReady((n) => n + 1);
          requestAnimationFrame(() => current.current.onProgress?.(95));
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            const message = e instanceof Error ? e.message : '';
            reportError(message.startsWith('map.canvas.') ? message : 'errors.request_failed');
          }
        });
    const unmount = onMount(map);
    let size = map.getSize();
    const observer = new ResizeObserver(() => {
      if (size.x === host.clientWidth && size.y === host.clientHeight) return;
      map.invalidateSize();
      size = map.getSize();
      map.setMinZoom(zoomRange(data, size.x, size.y).min);
    });
    observer.observe(host);
    current.current.onProgress?.(40);
    setReady((n) => n + 1);
    if (!data.svgUrl && !data.tiles.length) current.current.onProgress?.(95);
    return () => {
      controller.abort();
      observer.disconnect();
      unmount();
      map.remove();
      mapRef.current = null;
      svgRef.current = null;
      tiles.current = null;
    };
  }, [props.data, retry]);
  const { data, preference } = props;
  const raster = preference.basemap === 'tiles';
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const size = map.getSize();
    const max = zoomRange(data, size.x, size.y).max;
    const clamp = () => {
      if (map.getZoom() > max) map.setZoom(max, { animate: false });
    };
    map.on('zoomend', clamp);
    map.setMaxZoom(max);
    clamp();
    return () => {
      map.off('zoomend', clamp);
    };
  }, [data, ready]);
  useEffect(() => {
    const group = tiles.current;
    if (!group) return;
    group.clearLayers();
    if (!raster) return;
    const active = data.tiles.find((tile) => tile.floorId === preference.floorId);
    const base = data.tiles.find((tile) => tile.floorId === data.baseFloor) || data.tiles[0];
    let tileErrorReported = false;
    for (const tile of [base, ...(active && active !== base ? [active] : [])]) {
      if (!tile) continue;
      current.current.onProgress?.(76);
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
        .on('tileloadstart', () => current.current.onProgress?.(78))
        .on('tileload', () => current.current.onProgress?.(90))
        .on('tileerror', () => {
          if (tileErrorReported) return;
          tileErrorReported = true;
          current.current.onProgress?.(90);
          notices.push(t('map.canvas.tileFailed'), undefined, 'warning');
        })
        .on('load', () => requestAnimationFrame(() => current.current.onProgress?.(95)))
        .addTo(group);
    }
    return () => {
      group.clearLayers();
    };
  }, [data, preference.floorId, raster, ready, t]);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const active = data.floors.find((floor) => floor.id === preference.floorId)!;
    const base = data.floors.find((floor) => floor.id === data.baseFloor)!;
    svg.style.display =
      raster && data.tiles.some((tile) => tile.floorId === active.id) ? 'none' : '';
    const groups = new Set(data.floors.flatMap((floor) => floor.svgGroups));
    for (const child of Array.from(svg.children)) {
      if (child.tagName.toLowerCase() !== 'g') continue;
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
  return (
    <div
      ref={container}
      className={`map-canvas ${props.className || ''}`}
      tabIndex={0}
      aria-label={t('map.canvas.aria', { name: data.name })}
    />
  );
}
