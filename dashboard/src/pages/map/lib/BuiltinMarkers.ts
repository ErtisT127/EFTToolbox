import { mapDisplay } from '../../../../../contracts/ts/map-display.gen';
import L from 'leaflet';
import KDBush from 'kdbush';
import type { MapData, MapPreference } from '../../../../../contracts/ts/ipc.gen';
import { latLng } from './annotations';
import { artwork } from './artwork';

type Entry = {
  id: number;
  marker: MapData['markers'][number];
  category: MapData['categories'][number];
  named: boolean;
  art: boolean;
  visible: boolean;
  active: boolean;
  native?: L.Marker;
};
type Sprite = {
  image: HTMLImageElement;
  art: boolean;
  canvas?: HTMLCanvasElement;
};

// Stable map coordinates are indexed once. Screen-space queries are converted through the
// active Leaflet CRS, so hit radii also work with nonuniform and rotated tile projections.
export class BuiltinMarkers extends L.Layer {
  private entries: Entry[];
  private index: KDBush;
  private canvas = document.createElement('canvas');
  private sprites = new Map<string, Sprite>();
  private pendingImages = new Set<HTMLImageElement>();
  private nativeLayers = L.layerGroup();
  private tooltip = L.tooltip({ direction: 'top', offset: [0, -12] });
  private outlines = L.layerGroup();
  private raised: number | L.Marker | null = null;
  private raisedOffset = 0;
  private hovered: number | null = null;
  private pinned: number | null = null;
  private frame = 0;
  private hoverFrame = 0;
  private cursor: L.Point | null = null;
  private cursorTarget: EventTarget | null = null;
  private zooming = false;
  private restoreFade = false;
  private fadeFrame = 0;
  private readonly chromiumFade =
    typeof navigator !== 'undefined' &&
    /Chrome|Chromium|Electron/.test(navigator.userAgent) &&
    !/Firefox|FxiOS/.test(navigator.userAgent);
  private attached = false;
  private dpr = 0;
  private iconSize = 24;
  private laidOut = false;
  private settled = false;

  constructor(
    private data: MapData,
    private annotations: () => L.Layer[],
    private activateFloor: (floor: string) => void,
    private onIconsSettled: () => void = () => {},
  ) {
    super();
    const categories = new Map(data.categories.map((c) => [c.id, c]));
    this.entries = data.markers
      .filter((m) => categories.get(m.categoryId)!.symbol !== 'label')
      .map((marker, id) => {
        const category = categories.get(marker.categoryId)!;
        return {
          id,
          marker,
          category,
          named: ['exit', 'btr'].includes(category.symbol),
          // Item and handbook-category assets share the item- filename prefix. Only a
          // concrete item needs an outline; multi-item markers reuse the category icon.
          art: marker.iconUrl.includes('/item-') && marker.iconUrl !== category.iconUrl,
          visible: false,
          active: false,
        };
      });
    this.index = new KDBush(this.entries.length);
    for (const { marker } of this.entries) this.index.add(marker.position.x, marker.position.y);
    this.index.finish();
    this.canvas.className = 'builtin-canvas';
    if (this.chromiumFade) this.canvas.classList.add('builtin-canvas-fade');
  }

  onAdd(map: L.Map) {
    this.attached = true;
    const pane = map.getPane('builtin-icons') || map.createPane('builtin-icons');
    pane.style.zIndex = String(mapDisplay.iconPane);
    pane.style.pointerEvents = 'none';
    pane.append(this.canvas);
    this.iconSize =
      parseFloat(getComputedStyle(map.getContainer()).getPropertyValue('--map-icon-size')) || 24;
    this.nativeLayers.addTo(map);
    this.outlines.addTo(map);
    map.on('move resize viewreset zoomend', this.schedule, this);
    map.on('zoomstart', this.startZoom, this);
    map.on('zoomend', this.endZoom, this);
    map.on('movestart', this.clearHover, this);
    map.on('layerremove', this.layerRemoved, this);
    const host = map.getContainer();
    host.addEventListener('pointermove', this.pointerMove, true);
    host.addEventListener('pointerleave', this.clearHover);
    document.addEventListener('click', this.dismissPinned, true);
    this.schedule();
    return this;
  }

  onRemove(map: L.Map) {
    this.pinned = null;
    this.clearHover();
    this.attached = false;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.fadeFrame);
    map.off('move resize viewreset zoomend', this.schedule, this);
    map.off('zoomstart', this.startZoom, this);
    map.off('zoomend', this.endZoom, this);
    map.off('movestart', this.clearHover, this);
    map.off('layerremove', this.layerRemoved, this);
    map.getContainer().removeEventListener('pointermove', this.pointerMove, true);
    map.getContainer().removeEventListener('pointerleave', this.clearHover);
    document.removeEventListener('click', this.dismissPinned, true);
    this.nativeLayers.remove();
    this.outlines.remove();
    this.tooltip.remove();
    this.canvas.remove();
    this.pendingImages.clear();
    for (const sprite of this.sprites.values()) sprite.image.onload = sprite.image.onerror = null;
    this.sprites.clear();
    return this;
  }

  setPreference(preference: MapPreference) {
    this.restoreRaised();
    this.clearHover();
    this.nativeLayers.clearLayers();
    this.pendingImages.clear();
    const hidden = new Set(preference.hiddenCategories),
      tasks = new Set(preference.selectedTasks);
    for (const entry of this.entries) {
      const m = entry.marker;
      entry.visible =
        !m.categoryIds.every((id) => hidden.has(id)) &&
        !(m.taskId && preference.taskFilterActive && !tasks.has(m.taskId));
      entry.active = !m.floorIds.length || m.floorIds.includes(preference.floorId);
      entry.native = undefined;
      if (entry.visible && entry.named) {
        entry.native = L.marker(latLng(m.position), {
          icon: this.icon(entry),
          keyboard: false,
          opacity: entry.active ? 1 : 0.2,
          zIndexOffset: entry.active ? 1000 : 0,
        }).addTo(this.nativeLayers);
      }
    }
    const categories = new Map(this.data.categories.map((c) => [c.id, c]));
    for (const m of this.data.markers) {
      if (
        categories.get(m.categoryId)!.symbol !== 'label' ||
        !m.floorIds.includes(preference.floorId) ||
        m.categoryIds.every((id) => hidden.has(id)) ||
        (m.taskId && preference.taskFilterActive && !tasks.has(m.taskId))
      )
        continue;
      const caption = document.createElement('div');
      caption.className = 'landmark-text';
      caption.textContent = m.name;
      caption.style.fontSize = `${m.labelSize || 100}%`;
      caption.style.transform = `translate(-50%, -50%) rotate(${m.labelRotation || 0}deg)`;
      L.marker(latLng(m.position), {
        pane: 'landmarks',
        icon: L.divIcon({
          html: caption,
          className: 'landmark-label',
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        }),
        interactive: false,
        keyboard: false,
        zIndexOffset: -100000,
      }).addTo(this.nativeLayers);
    }
    if (this.pinned !== null && !this.entries[this.pinned].visible) this.pinned = null;
    this.hovered = this.pinned;
    this.raise(this.pinned);
    this.updateTooltip();
    this.updateOutlines();
    this.laidOut = true;
    this.schedule();
  }

  private query(min: L.Point, max: L.Point) {
    const corners = [min, max, L.point(min.x, max.y), L.point(max.x, min.y)].map((p) =>
      this._map.containerPointToLatLng(p),
    );
    return this.index.range(
      Math.min(...corners.map((p) => p.lng)),
      Math.min(...corners.map((p) => -p.lat)),
      Math.max(...corners.map((p) => p.lng)),
      Math.max(...corners.map((p) => -p.lat)),
    );
  }

  private position(id: number) {
    return this._map.latLngToContainerPoint(latLng(this.entries[id].marker.position));
  }

  // Actual icon bounds, not the larger hover/raise radius. Named captions keep their DOM bounds.
  hit(pixel: L.Point, target?: EventTarget | null): number | null {
    if (this.zooming || this._map.getContainer().classList.contains('markers-zooming')) return null;
    const radius = this.iconSize / 2;
    const candidates = this.query(pixel.subtract([radius, radius]), pixel.add([radius, radius]));
    if (target instanceof Element) {
      const named = target.closest<HTMLElement>('[data-builtin-id]');
      if (named) {
        const id = Number(named.dataset.builtinId);
        if (this.entries[id]?.visible) return id;
      }
    }
    let result: number | null = null,
      top = -Infinity;
    for (const id of candidates) {
      const entry = this.entries[id],
        p = this.position(id);
      if (!entry.visible || Math.abs(p.x - pixel.x) > radius || Math.abs(p.y - pixel.y) > radius)
        continue;
      const order = id === this.raised ? Infinity : p.y + (entry.active ? 1000 : 0);
      if (order > top || (order === top && (result === null || id > result))) {
        top = order;
        result = id;
      }
    }
    return result;
  }

  activate(id: number) {
    const entry = this.entries[id];
    if (!entry?.visible) return;
    if (this.pinned === id) {
      this.pinned = null;
      this.clearHover();
      return;
    }
    this.pinned = id;
    this.hovered = id;
    this.raise(id);
    this.updateTooltip();
    this.updateOutlines();
    if (!entry.active && entry.marker.floorIds.length === 1)
      this.activateFloor(entry.marker.floorIds[0]);
  }

  getPosition(id: number) {
    return this.entries[id]?.marker.position || null;
  }

  private dismissPinned = (event: MouseEvent) => {
    if (this.pinned === null) return;
    const host = this._map.getContainer();
    if (
      event.target instanceof Node &&
      host.contains(event.target) &&
      this.hit(this._map.mouseEventToContainerPoint(event), event.target) === this.pinned
    )
      return;
    this.pinned = null;
    this.clearHover();
  };

  private updateTooltip() {
    const id = this.pinned ?? this.hovered;
    if (id === null) {
      this.tooltip.remove();
      return;
    }
    const label = document.createElement('div');
    label.className = 'marker-tooltip';
    label.textContent = this.entries[id].marker.name;
    this.tooltip.setLatLng(latLng(this.entries[id].marker.position)).setContent(label);
    if (!this._map.hasLayer(this.tooltip)) this.tooltip.addTo(this._map);
  }

  private icon(entry: Entry) {
    const element = document.createElement('div');
    element.className = `builtin-marker${entry.named ? ' named-marker' : ''}${entry.art ? ' marker-art' : ''}`;
    element.dataset.category = entry.category.id;
    element.dataset.builtinId = String(entry.id);
    const url = entry.marker.iconUrl || entry.category.iconUrl;
    const sprite = !entry.named && this.sprite(entry);
    if (sprite) {
      // Reuse the same outlined device pixels as the stationary canvas icon.
      const canvas = document.createElement('canvas');
      canvas.width = sprite.width;
      canvas.height = sprite.height;
      canvas.getContext('2d')!.drawImage(sprite, 0, 0);
      const size = sprite.width / this.dpr;
      canvas.style.width = canvas.style.height = `${size}px`;
      canvas.style.margin = `${(this.iconSize - size) / 2}px`;
      element.append(canvas);
    } else if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.draggable = false;
      img.width = img.height = this.iconSize;
      // Settling only needs a re-check; the icon itself paints whenever the browser is done.
      img.onload = img.onerror = () => {
        this.pendingImages.delete(img);
        this.schedule();
      };
      element.append(img);
      if (!img.complete) this.pendingImages.add(img);
    }
    if (entry.named) {
      const caption = document.createElement('span');
      caption.className = 'marker-name';
      caption.textContent = entry.marker.name;
      element.append(caption);
    }
    return L.divIcon({
      html: element,
      className: 'builtin-anchor',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  }

  private sprite(entry: Entry) {
    const url = entry.marker.iconUrl || entry.category.iconUrl;
    if (!url) return;
    const art = entry.art,
      key = `${url}:${art}`;
    let sprite = this.sprites.get(key);
    if (!sprite) {
      const image = new Image();
      sprite = { image, art };
      this.sprites.set(key, sprite);
      image.onload = () => {
        if (this.attached) this.schedule();
      };
      image.src = url;
    }
    if (!sprite.image.complete || !sprite.image.naturalWidth) return;
    if (!sprite.canvas) sprite.canvas = artwork(sprite.image, this.iconSize, this.dpr, art);
    return sprite.canvas;
  }

  private schedule = () => {
    if (this.attached && !this.frame) this.frame = requestAnimationFrame(this.draw);
  };
  private startZoom = () => {
    this.zooming = true;
    this.restoreFade = false;
    cancelAnimationFrame(this.fadeFrame);
    this.canvas.style.visibility = 'hidden';
    if (this.chromiumFade) this.canvas.style.opacity = '0';
    this.clearHover();
  };
  private endZoom = () => {
    this.zooming = false;
    this.restoreFade = this.chromiumFade;
    this.schedule();
  };
  private draw = () => {
    this.frame = 0;
    if (!this.attached || this.zooming) return;
    const size = this._map.getSize(),
      dpr = window.devicePixelRatio || 1;
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      for (const sprite of this.sprites.values()) sprite.canvas = undefined;
    }
    if (
      this.canvas.width !== Math.round(size.x * dpr) ||
      this.canvas.height !== Math.round(size.y * dpr)
    ) {
      this.canvas.width = Math.round(size.x * dpr);
      this.canvas.height = Math.round(size.y * dpr);
      this.canvas.style.width = `${this.canvas.width / dpr}px`;
      this.canvas.style.height = `${this.canvas.height / dpr}px`;
    }
    L.DomUtil.setPosition(this.canvas, this._map.containerPointToLayerPoint([0, 0]));
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const pad = this.iconSize / 2 + 4;
    const visible = this.query(L.point(-pad, -pad), size.add([pad, pad]))
      .filter((id) => this.entries[id].visible && !this.entries[id].named && id !== this.raised)
      .map((id) => ({ id, p: this.position(id) }));
    visible.sort(
      (a, b) =>
        a.p.y +
          (this.entries[a.id].active ? 1000 : 0) -
          (b.p.y + (this.entries[b.id].active ? 1000 : 0)) || a.id - b.id,
    );
    // Any icon still decoding keeps the map "unfinished" for the caller's loading overlay, so the
    // cast does not drop the overlay onto a map whose markers have not painted yet.
    let pending = false;
    const drawEntry = (id: number, p: L.Point) => {
      const entry = this.entries[id];
      const url = entry.marker.iconUrl || entry.category.iconUrl;
      const sprite = url ? this.sprite(entry) : undefined;
      if (!sprite) {
        if (url && !this.sprites.get(`${url}:${entry.art}`)?.image.complete) pending = true;
        return;
      }
      ctx.globalAlpha = entry.active ? 1 : 0.2;
      // Copy cached device pixels directly; fractional-DPR resampling softens the thin outline.
      ctx.drawImage(
        sprite,
        Math.round(p.x * dpr - sprite.width / 2),
        Math.round(p.y * dpr - sprite.height / 2),
      );
    };
    for (const { id, p } of visible) drawEntry(id, p);
    if (typeof this.raised === 'number') {
      const entry = this.entries[this.raised];
      if (entry.visible && !entry.named) drawEntry(this.raised, this.position(this.raised));
    }
    if (this.pendingImages.size) pending = true;
    if (this.laidOut && !pending && !this.settled) {
      this.settled = true;
      this.onIconsSettled();
    }
    this.canvas.style.visibility = '';
    if (this.restoreFade) {
      this.restoreFade = false;
      this.canvas.style.opacity = '0';
      this.fadeFrame = requestAnimationFrame(() => {
        this.fadeFrame = 0;
        if (this.attached) this.canvas.style.opacity = '1';
      });
    }
  };

  private pointerMove = (event: PointerEvent) => {
    // Preserve the hovered icon while a click is held; actual map movement clears it.
    if (this.pinned !== null || event.buttons) return;
    if (
      this._map.getContainer().classList.contains('markers-zooming') ||
      (event.target instanceof Element && event.target.closest('.leaflet-popup'))
    ) {
      this.clearHover();
      return;
    }
    this.cursor = this._map.mouseEventToContainerPoint(event);
    this.cursorTarget = event.target;
    if (!this.hoverFrame) this.hoverFrame = requestAnimationFrame(this.updateHover);
  };
  private updateHover = () => {
    this.hoverFrame = 0;
    const cursor = this.cursor;
    if (!cursor || this.pinned !== null) return;
    let nearest: number | L.Marker | null = null,
      distance = 32;
    for (const id of this.query(cursor.subtract([32, 32]), cursor.add([32, 32])).sort(
      (a, b) => a - b,
    )) {
      if (!this.entries[id].visible) continue;
      const next = this.position(id).distanceTo(cursor);
      if (next < distance) {
        nearest = id;
        distance = next;
      }
    }
    for (const layer of this.annotations()) {
      if (!(layer instanceof L.Marker)) continue;
      const next = this._map.latLngToContainerPoint(layer.getLatLng()).distanceTo(cursor);
      if (next < distance) {
        nearest = layer;
        distance = next;
      }
    }
    if (this.raised !== null) {
      const p =
        typeof this.raised === 'number'
          ? this.position(this.raised)
          : this._map.latLngToContainerPoint(this.raised.getLatLng());
      const current = p.distanceTo(cursor);
      if (current <= 44 && (nearest === null || current - distance < 8)) nearest = this.raised;
    }
    this.raise(nearest);
    const id = nearest instanceof L.Marker ? null : this.hit(cursor, this.cursorTarget);
    if (id !== this.hovered) {
      this.hovered = id;
      this.updateTooltip();
      this.updateOutlines();
    }
  };
  private raise(nearest: number | L.Marker | null) {
    if (nearest !== this.raised) {
      this.restoreRaised();
      this.raised = nearest;
      if (typeof nearest === 'number') {
        const entry = this.entries[nearest];
        if (entry.native) {
          this.raisedOffset = entry.native.options.zIndexOffset || 0;
          entry.native.setZIndexOffset(1000000);
        }
      } else if (nearest) {
        this.raisedOffset = nearest.options.zIndexOffset || 0;
        nearest.setZIndexOffset(1000000);
      }
      // Hover itself runs in rAF. Complete both sides of the DOM/canvas handoff before paint.
      cancelAnimationFrame(this.frame);
      this.draw();
    }
  }
  private restoreRaised() {
    const marker = typeof this.raised === 'number' ? this.entries[this.raised].native : this.raised;
    marker?.setZIndexOffset(this.raisedOffset);
    this.raised = null;
  }
  clearHover = () => {
    cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = 0;
    this.cursor = null;
    if (this.pinned === null) this.raise(null);
    this.hovered = this.pinned;
    this.updateTooltip();
    if (this.attached) {
      this.updateOutlines();
      this.schedule();
    }
  };
  private layerRemoved = (event: L.LayerEvent) => {
    if (event.layer === this.raised) this.clearHover();
  };
  private updateOutlines() {
    this.outlines.clearLayers();
    for (const id of new Set([this.pinned, this.hovered])) {
      if (id === null) continue;
      const { marker, category, active, visible } = this.entries[id];
      if (!visible || marker.outline.length <= 2) continue;
      L.polygon(marker.outline.map(latLng), {
        color: category.color,
        weight: 1,
        opacity: active ? 1 : 0.2,
        fillOpacity: active ? 0.08 : 0.02,
        interactive: false,
      }).addTo(this.outlines);
    }
  }
}
