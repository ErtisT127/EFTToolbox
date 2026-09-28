import { Layers } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type L from 'leaflet';
import type {
  Annotation,
  MapData,
  MapPreference,
  MobileFiltersChanged,
  OverlaySettings,
  PlayerState,
  Preferences,
  ServerEvent,
  Sticker,
} from '../../../contracts/ts/ipc.gen';
import { MapCanvas, type ToolOptions } from '../pages/map/MapCanvas';
import { LayerPanel } from '../pages/map/LayerPanel';
import { AppPopover } from '../components/AppPopover';
import { selectableFloors } from '../stores/workspaceStore';
import { useLocale, type LocaleKey } from '../hooks/useLocale';

// The API recognizes the app's own locale values; a bare "en" from a browser would silently fall
// back to Chinese. The cast page runs on whatever device opened the link and cannot read the app's
// own setting, so the browser language drives both its copy and the map data it fetches.
export function castLocale(): 'zh-CN' | 'en-US' {
  return navigator.language.startsWith('en') ? 'en-US' : 'zh-CN';
}

type Model = {
  data: MapData;
  preference: MapPreference;
  items: Annotation[];
  stickers: Map<string, Sticker>;
  players: Map<string, PlayerState>;
};

type CastLoadKey =
  | 'cast.connecting'
  | 'cast.waitingSnapshot'
  | 'cast.loadingMap'
  | 'cast.loadingResources'
  | 'cast.reconnecting'
  | 'cast.ready';

type Loading = { value: number; key: CastLoadKey };

const emptyOptions: ToolOptions = {
  color: '#5FD3C4',
  width: 3,
  emoji: '📍',
  imageId: '',
  text: '',
  textSize: 18,
  eraserSize: 24,
};

function preferenceFor(data: MapData, preferences: Preferences, id: string): MapPreference {
  const saved = preferences.maps.find((value) => value.mapId === id);
  const value: MapPreference = saved
    ? { ...saved }
    : {
        mapId: id,
        basemap: data.svgUrl ? 'svg' : 'tiles',
        floorId: data.defaultFloor,
        hiddenCategories: [],
        collapsedGroups: [],
        showAnnotations: true,
        selectedTasks: [],
        center: [],
        zoom: 0,
        taskFilterActive: false,
      };
  value.hiddenCategories = Array.isArray(value.hiddenCategories) ? value.hiddenCategories : [];
  value.collapsedGroups = Array.isArray(value.collapsedGroups) ? value.collapsedGroups : [];
  value.selectedTasks = Array.isArray(value.selectedTasks) ? value.selectedTasks : [];
  value.center = Array.isArray(value.center) ? value.center : [];
  if (!data.svgUrl) value.basemap = 'tiles';
  if (!data.tiles.length) value.basemap = 'svg';
  if (!data.floors.some((floor) => floor.id === value.floorId)) value.floorId = data.defaultFloor;
  if (
    value.floorId !== data.baseFloor &&
    !selectableFloors(data, value.basemap).some((floor) => floor.id === value.floorId)
  )
    value.floorId = data.baseFloor;
  return value;
}

function eventData(event: MessageEvent<string>): ServerEvent {
  return JSON.parse(event.data) as ServerEvent;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function CastApp() {
  const { t } = useLocale();
  const [model, setModel] = useState<Model>();
  const [loading, setLoading] = useState<Loading>({ value: 0, key: 'cast.connecting' });
  const [terminal, setTerminal] = useState<'' | 'cast.expired' | 'cast.ended'>('');
  const mapRef = useRef<L.Map | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const modelRef = useRef<Model | undefined>(undefined);
  const settingsRef = useRef<OverlaySettings | undefined>(undefined);
  const terminalRef = useRef(false);
  const gestureRef = useRef(false);
  const pendingRef = useRef<(() => void) | null>(null);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const epochRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const layersButtonRef = useRef<HTMLButtonElement>(null);
  const castRootRef = useRef<HTMLElement>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [portrait, setPortrait] = useState(() => window.innerHeight > window.innerWidth);

  useEffect(() => {
    const updateOrientation = () => setPortrait(window.innerHeight > window.innerWidth);
    window.addEventListener('resize', updateOrientation);
    return () => window.removeEventListener('resize', updateOrientation);
  }, []);

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  const setStage = useCallback((value: number, key: CastLoadKey) => setLoading({ value, key }), []);

  const loadModel = useCallback(
    async (
      preferences: Preferences,
      players: Map<string, PlayerState>,
      id?: string,
      epoch = epochRef.current,
    ) => {
      const mapId = id || preferences.selectedMap;
      if (!mapId) throw new Error('cast.mapUnavailable');
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      setStage(25, 'cast.loadingMap');
      const locale = castLocale();
      let dataResponse: Response, annotationsResponse: Response, stickersResponse: Response;
      try {
        [dataResponse, annotationsResponse, stickersResponse] = await Promise.all([
          fetch(`/api/maps/${encodeURIComponent(mapId)}?locale=${encodeURIComponent(locale)}`, {
            signal: controller.signal,
          }),
          fetch(`/api/maps/${encodeURIComponent(mapId)}/annotations`, {
            signal: controller.signal,
          }),
          fetch('/api/stickers', { signal: controller.signal }),
        ]);
      } catch (error) {
        if (isAbortError(error)) return undefined;
        throw error;
      }
      if (epoch !== epochRef.current) return undefined;
      if (!dataResponse.ok || !annotationsResponse.ok || !stickersResponse.ok)
        throw new Error('cast.mapUnavailable');
      let data: MapData,
        annotations: { schemaVersion: number; items: Annotation[] },
        stickers: Sticker[];
      try {
        [data, annotations, stickers] = await Promise.all([
          dataResponse.json() as Promise<MapData>,
          annotationsResponse.json() as Promise<{ schemaVersion: number; items: Annotation[] }>,
          stickersResponse.json() as Promise<Sticker[]>,
        ]);
      } catch (error) {
        if (isAbortError(error)) return undefined;
        throw error;
      }
      if (epoch !== epochRef.current) return undefined;
      setStage(38, 'cast.loadingMap');
      const next: Model = {
        data,
        preference: preferenceFor(data, preferences, mapId),
        items: annotations.items || [],
        stickers: new Map(stickers.map((sticker) => [sticker.id, sticker])),
        players,
      };
      if (settingsRef.current?.followCenter === false) next.preference.center = [];
      if (settingsRef.current?.followZoom === false) next.preference.zoom = 0;
      setLoadError('');
      setModel(next);
      modelRef.current = next;
      return next;
    },
    [setStage],
  );

  const applyPreferences = useCallback(
    async (
      preferences: Preferences,
      players?: Map<string, PlayerState>,
      epoch = epochRef.current,
    ) => {
      if (epoch !== epochRef.current) return;
      const current = modelRef.current;
      const nextPlayers = players || current?.players || new Map<string, PlayerState>();
      const id = preferences.selectedMap || current?.data.id;
      if (!id) return;
      if (!current || current.data.id !== id) {
        await loadModel(preferences, nextPlayers, id, epoch);
        return;
      }
      const nextPreference = preferenceFor(current.data, preferences, id);
      if (settingsRef.current?.followFloor === false)
        nextPreference.floorId = current.preference.floorId;
      const update = () => {
        setModel((previous) => (previous ? { ...previous, preference: nextPreference } : previous));
        if (mapRef.current && nextPreference.center.length === 2) {
          const settings = settingsRef.current;
          const center =
            settings?.followCenter === false ? undefined : (nextPreference.center as L.LatLngTuple);
          const zoom = settings?.followZoom === false ? undefined : nextPreference.zoom;
          if (center || zoom !== undefined) {
            const currentMap = mapRef.current;
            currentMap.setView(center || currentMap.getCenter(), zoom ?? currentMap.getZoom(), {
              animate: false,
            });
          }
        }
      };
      if (gestureRef.current) pendingRef.current = update;
      else update();
    },
    [loadModel],
  );

  const reloadAnnotations = useCallback(async () => {
    const current = modelRef.current;
    if (!current) return;
    const response = await fetch(`/api/maps/${encodeURIComponent(current.data.id)}/annotations`);
    if (!response.ok) return;
    const next = (await response.json()) as { items?: Annotation[] };
    setModel((previous) => (previous ? { ...previous, items: next.items || [] } : previous));
  }, []);

  const handle = useCallback(
    async (event: MessageEvent<string>) => {
      const value = eventData(event);
      if (value.type === 'snapshot') {
        const epoch = ++epochRef.current;
        loadAbortRef.current?.abort();
        setModel(undefined);
        modelRef.current = undefined;
        setLayersOpen(false);
        setLoadError('');
        setStage(18, 'cast.waitingSnapshot');
        settingsRef.current = value.overlaySettings;
        terminalRef.current = false;
        const players = new Map((value.players || []).map((player) => [player.playerId, player]));
        try {
          if (value.preferences) await applyPreferences(value.preferences, players, epoch);
        } catch (error) {
          if (epoch === epochRef.current)
            setLoadError(error instanceof Error ? error.message : 'cast.mapUnavailable');
        }
        if (epoch === epochRef.current && modelRef.current) setStage(42, 'cast.loadingResources');
        return;
      }
      if (value.type === 'filters_changed' && value.filtersChanged) {
        const filters: MobileFiltersChanged = value.filtersChanged;
        setModel((previous) => {
          if (!previous || previous.data.id !== filters.mapId) return previous;
          return {
            ...previous,
            preference: {
              ...previous.preference,
              hiddenCategories: filters.hiddenCategories,
              collapsedGroups: filters.collapsedGroups,
              showAnnotations: filters.showAnnotations,
              selectedTasks: filters.selectedTasks,
              taskFilterActive: filters.taskFilterActive,
            },
          };
        });
        return;
      }
      if (value.type === 'player_upsert' && value.player) {
        setModel((previous) => {
          if (!previous) return previous;
          const players = new Map(previous.players);
          players.set(value.player!.playerId, value.player!);
          return { ...previous, players };
        });
        return;
      }
      if (value.type === 'player_remove' && value.playerId) {
        setModel((previous) => {
          if (!previous) return previous;
          const players = new Map(previous.players);
          players.delete(value.playerId!);
          return { ...previous, players };
        });
        return;
      }
      if (
        value.type === 'annotations_changed' ||
        value.type === 'annotation_upsert' ||
        value.type === 'annotation_remove'
      ) {
        await reloadAnnotations();
        return;
      }
      if (
        value.type === 'map_changed' ||
        value.type === 'floor_changed' ||
        value.type === 'basemap_changed' ||
        value.type === 'center_changed'
      ) {
        if (value.preferences) await applyPreferences(value.preferences);
        else {
          const response = await fetch('/api/map-preferences');
          if (response.ok) await applyPreferences((await response.json()) as Preferences);
        }
        return;
      }
      if (value.type === 'session_end' || value.type === 'session_expired') {
        terminalRef.current = true;
        eventSourceRef.current?.close();
        setTerminal(value.type === 'session_expired' ? 'cast.expired' : 'cast.ended');
      }
    },
    [applyPreferences, reloadAnnotations, setStage],
  );

  const connect = useCallback(() => {
    const token = new URLSearchParams(location.search).get('token');
    if (!token || document.visibilityState !== 'visible' || terminalRef.current) return;
    eventSourceRef.current?.close();
    setStage(5, 'cast.connecting');
    const source = new EventSource(`/cast/events?token=${encodeURIComponent(token)}`);
    eventSourceRef.current = source;
    source.onopen = () => setStage(12, 'cast.waitingSnapshot');
    source.onerror = () => {
      if (!terminalRef.current) setStage(8, 'cast.reconnecting');
    };
    for (const name of [
      'snapshot',
      'map_changed',
      'floor_changed',
      'basemap_changed',
      'center_changed',
      'filters_changed',
      'player_upsert',
      'player_remove',
      'annotation_upsert',
      'annotation_remove',
      'annotations_changed',
      'session_end',
      'session_expired',
    ]) {
      source.addEventListener(name, (event) => void handle(event as MessageEvent<string>));
    }
  }, [handle, setStage]);

  useEffect(() => {
    connect();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        return;
      }
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = window.setTimeout(connect, 500);
    };
    const onOnline = () => {
      if (document.visibilityState === 'visible') connect();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.clearTimeout(reconnectTimerRef.current);
      eventSourceRef.current?.close();
    };
  }, [connect]);

  const setPreference = (changes: Partial<MapPreference>) => {
    setModel((previous) => {
      if (!previous) return previous;
      const preference = { ...previous.preference, ...changes };
      if (changes.basemap && changes.basemap !== previous.preference.basemap) {
        const available = selectableFloors(previous.data, changes.basemap);
        if (
          preference.floorId !== previous.data.baseFloor &&
          !available.some((floor) => floor.id === preference.floorId)
        ) {
          preference.floorId = available[0]?.id || previous.data.baseFloor;
        }
      }
      return { ...previous, preference };
    });
  };

  const retry = () => {
    setLoadError('');
    connect();
  };

  const onReady = (map: L.Map | null) => {
    mapRef.current = map;
    if (!map) return;
    const host = map.getContainer();
    const start = () => {
      gestureRef.current = true;
    };
    const end = () => {
      gestureRef.current = false;
      const pending = pendingRef.current;
      pendingRef.current = null;
      pending?.();
    };
    host.addEventListener('pointerdown', start, { passive: true });
    host.addEventListener('pointerup', end, { passive: true });
    host.addEventListener('pointercancel', end, { passive: true });
    host.addEventListener('touchstart', start, { passive: true });
    host.addEventListener('touchend', end, { passive: true });
    map.once('unload', () => {
      host.removeEventListener('pointerdown', start);
      host.removeEventListener('pointerup', end);
      host.removeEventListener('pointercancel', end);
      host.removeEventListener('touchstart', start);
      host.removeEventListener('touchend', end);
    });
  };

  return (
    <main ref={castRootRef} className="cast-root">
      {model && (
        <>
          <MapCanvas
            data={model.data}
            preference={model.preference}
            stickers={model.stickers}
            items={model.items}
            players={model.players}
            tool="select"
            options={emptyOptions}
            ownerId=""
            readOnly
            playerFollow={false}
            onCommit={() => {}}
            onView={() => {}}
            onUndo={() => {}}
            onRedo={() => {}}
            onSelectTool={() => {}}
            onTemporaryHand={() => {}}
            onActivateFloor={(floorId) => setPreference({ floorId })}
            onCursor={() => {}}
            onZoomChange={() => {}}
            onReady={onReady}
            onError={(error) => setLoadError(error)}
            onProgress={(value) => {
              if (value >= 95) {
                requestAnimationFrame(() => setStage(100, 'cast.ready'));
              } else setStage(Math.max(42, value), 'cast.loadingResources');
            }}
          />
          <div className="cast-controls">
            <button
              ref={layersButtonRef}
              className={`cast-control ${layersOpen ? 'active' : ''}`}
              type="button"
              aria-label={t('map.view.layers')}
              aria-controls="cast-layer-panel"
              aria-expanded={layersOpen}
              onClick={() => setLayersOpen((open) => !open)}
            >
              <Layers size={20} fill="currentColor" />
            </button>
          </div>
          <AppPopover
            open={layersOpen}
            reference={layersButtonRef}
            placement={portrait ? 'bottom-start' : 'right-start'}
            boundaryRef={castRootRef}
          >
            <div
              id="cast-layer-panel"
              className="layer-panel floating cast-layer-panel"
              role="dialog"
              aria-modal="false"
              aria-label={t('map.layers.title')}
            >
              <LayerPanel
                data={model.data}
                items={[]}
                preference={model.preference}
                readOnly
                onPreference={setPreference}
                onClose={() => setLayersOpen(false)}
              />
            </div>
          </AppPopover>
        </>
      )}
      {!terminal && loading.value < 100 && (
        <div className="cast-loading" role="status">
          <div className="cast-loading-panel">
            <strong>{loading.value}%</strong>
            <span>{t(loading.key)}</span>
            <progress max="100" value={loading.value} />
            {loadError && (
              <>
                <span className="cast-error">{t(loadError as LocaleKey)}</span>
                <button type="button" onClick={retry}>
                  {t('cast.retry')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {terminal && (
        <div className="cast-terminal" role="alert">
          <div className="cast-terminal-panel">
            <strong>{t(terminal)}</strong>
          </div>
        </div>
      )}
    </main>
  );
}
