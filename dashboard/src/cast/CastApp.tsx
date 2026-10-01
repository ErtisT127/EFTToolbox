import { Layers } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type L from 'leaflet';
import type {
  Annotation,
  Annotations,
  MapData,
  MapPreference,
  MarkerPreferences,
  MobileFiltersChanged,
  MultiplayerStatus,
  OverlaySettings,
  PlayerState,
  Preferences,
  ServerEvent,
  Sticker,
} from '../../../contracts/ts/ipc.gen';
import { MapCanvas, type ToolOptions } from '../pages/map/MapCanvas';
const CastLayers = lazy(() => import('./CastLayers'));
import { selectableFloors } from '../pages/map/lib/floors';
import { useLocale, type LocaleKey } from '../hooks/useLocale';
import { api } from '../stores/api';
import { store } from '../stores/store';
import i18n from '../i18n';
import { ownerVisibilityFor } from '../pages/map/lib/visibility';

// The API recognizes the app's own locale values; a bare "en" from a browser would silently fall
// back to Chinese. cast/main.tsx only seeds the browser language at boot: the cast runs on another
// device, so the app's interface language arrives with the snapshot (see applyLanguage) and the
// boot value is what shows until it does.
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
  color: '#FF6B35',
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

// A tile batch that stays in flight longer than this is worth explaining; anything faster would
// only flicker. The full-screen overlay gates the first paint, so it must never outlive a load:
// without the watchdog a stalled progress source would strand the cast on "loading resources".
const TILE_BUSY_DELAY = 500;
const READY_WATCHDOG = 8000;

export function CastApp() {
  const { t, locale } = useLocale();
  const [model, setModel] = useState<Model>();
  const [loading, setLoading] = useState<Loading>({ value: 0, key: 'cast.connecting' });
  const [terminal, setTerminal] = useState<'' | 'cast.expired' | 'cast.ended'>('');
  const mapRef = useRef<L.Map | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const modelRef = useRef<Model | undefined>(undefined);
  const playersRef = useRef(new Map<string, PlayerState>());
  const playerListenersRef = useRef(new Set<() => void>());
  const playerSource = useRef({
    current: playersRef.current,
    subscribe: (listener: () => void) => {
      playerListenersRef.current.add(listener);
      return () => playerListenersRef.current.delete(listener);
    },
  }).current;
  const annotationRequestRef = useRef(0);
  const loadRef = useRef<{ id: string; epoch: number; promise: Promise<Model | undefined> } | null>(
    null,
  );
  const desiredRef = useRef({ id: '', epoch: -1 });
  const settingsRef = useRef<OverlaySettings | undefined>(undefined);
  const terminalRef = useRef(false);
  const gestureRef = useRef(false);
  const pendingRef = useRef<(() => void) | null>(null);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const epochRef = useRef(0);
  const readyRef = useRef(false);
  const readyTimerRef = useRef<number | undefined>(undefined);
  const busyTimerRef = useRef<number | undefined>(undefined);
  const layersButtonRef = useRef<HTMLButtonElement>(null);
  const castRootRef = useRef<HTMLElement>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [markerPreferences, setMarkerPreferences] = useState<MarkerPreferences>();
  const [ownerId, setOwnerId] = useState('');
  const [multiplayerStatus, setMultiplayerStatus] = useState<MultiplayerStatus>();
  const [loadError, setLoadError] = useState('');
  const [portrait, setPortrait] = useState(() => window.innerHeight > window.innerWidth);
  const [canvasKey, setCanvasKey] = useState(0);
  const [tileBusy, setTileBusy] = useState(false);
  // The map data is served per language, so the ref keeps the reload that follows a language change
  // from reading the stale value of the render that started it.
  const localeRef = useRef(locale);
  localeRef.current = locale;

  // The phone cannot read user settings (the LAN handler keeps them on the host), so the interface
  // language rides on the snapshot. Applying it before the preferences makes the map reload follow
  // into the new language instead of keeping the old map names and marker labels.
  const applyLanguage = useCallback(async (next: ServerEvent['language']) => {
    if (!next || next === i18n.language) return;
    await i18n.changeLanguage(next);
    localeRef.current = next;
  }, []);

  useEffect(() => {
    const updateOrientation = () => setPortrait(window.innerHeight > window.innerWidth);
    window.addEventListener('resize', updateOrientation);
    return () => window.removeEventListener('resize', updateOrientation);
  }, []);

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(
    () => () => {
      window.clearTimeout(readyTimerRef.current);
      window.clearTimeout(busyTimerRef.current);
    },
    [],
  );

  const setStage = useCallback((value: number, key: CastLoadKey) => setLoading({ value, key }), []);

  const markReady = useCallback(() => {
    // Idempotent per load generation: the tile pipeline keeps re-reporting 95-ish progress while the
    // phone pans, and re-staging an identical state would re-render the whole cast tree each batch.
    if (readyRef.current) return;
    readyRef.current = true;
    window.clearTimeout(readyTimerRef.current);
    readyTimerRef.current = undefined;
    setStage(100, 'cast.ready');
  }, [setStage]);

  // Every load generation starts back at the full-screen overlay; the ready flag only suppresses the
  // tile activity that keeps arriving after the map has already painted.
  const beginLoad = useCallback(
    (epoch: number) => {
      readyRef.current = false;
      window.clearTimeout(readyTimerRef.current);
      readyTimerRef.current = window.setTimeout(() => {
        if (epoch === epochRef.current && modelRef.current) markReady();
      }, READY_WATCHDOG);
      window.clearTimeout(busyTimerRef.current);
      busyTimerRef.current = undefined;
      setTileBusy(false);
    },
    [markReady],
  );

  const onTileBusy = useCallback((busy: boolean) => {
    window.clearTimeout(busyTimerRef.current);
    busyTimerRef.current = undefined;
    if (!busy) {
      setTileBusy(false);
      return;
    }
    // Until the first paint the full-screen progress overlay owns the feedback.
    if (!readyRef.current) return;
    busyTimerRef.current = window.setTimeout(() => {
      busyTimerRef.current = undefined;
      setTileBusy(true);
    }, TILE_BUSY_DELAY);
  }, []);

  const loadModel = useCallback(
    async (
      preferences: Preferences,
      players: Map<string, PlayerState>,
      id?: string,
      epoch = epochRef.current,
      force = false,
    ) => {
      const mapId = id || preferences.selectedMap;
      if (!mapId) throw new Error('cast.mapUnavailable');
      // One preferences change fans out into map/floor/basemap/center events, and every one of them
      // asks for the same map. Sharing one load keeps a late duplicate from re-staging the overlay
      // after the map has already painted, which stranded the cast on "loading resources".
      const inflight = loadRef.current;
      if (inflight && inflight.id === mapId && inflight.epoch === epoch && !force)
        return inflight.promise;
      const promise = (async () => {
        beginLoad(epoch);
        setStage(25, 'cast.loadingMap');
        const [data, annotations, stickers] = await Promise.all([
          store
            .dispatch(
              api.endpoints.getMap.initiate(
                { id: mapId, locale: localeRef.current },
                { forceRefetch: force },
              ),
            )
            .unwrap(),
          store
            .dispatch(api.endpoints.getAnnotations.initiate(mapId, { forceRefetch: force }))
            .unwrap(),
          store
            .dispatch(api.endpoints.getStickers.initiate(undefined, { forceRefetch: force }))
            .unwrap(),
        ]);
        if (epoch !== epochRef.current) return undefined;
        // A newer request for another map owns the view now, so this stale load must not apply.
        if (desiredRef.current.epoch === epoch && desiredRef.current.id !== mapId) return undefined;
        const value: Annotations = annotations.value;
        setStage(38, 'cast.loadingMap');
        const next: Model = {
          data,
          preference: preferenceFor(data, preferences, mapId),
          items: value.items || [],
          stickers: new Map(stickers.map((sticker) => [sticker.id, sticker])),
          players: playersRef.current,
        };
        if (settingsRef.current?.followCenter === false) next.preference.center = [];
        if (settingsRef.current?.followZoom === false) next.preference.zoom = 0;
        setLoadError('');
        // The viewport is keyed per load: a map that is already in the query cache keeps its
        // identity, so without a fresh key it would never report progress and the overlay would
        // stay stranded on the last staging value.
        setCanvasKey((key) => key + 1);
        setModel(next);
        modelRef.current = next;
        return next;
      })();
      loadRef.current = { id: mapId, epoch, promise };
      return promise;
    },
    [beginLoad, setStage],
  );

  const applyPreferences = useCallback(
    async (
      preferences: Preferences,
      players?: Map<string, PlayerState>,
      epoch = epochRef.current,
      force = false,
    ) => {
      if (epoch !== epochRef.current) return;
      const current = modelRef.current;
      const nextPlayers = players || playersRef.current;
      const id = preferences.selectedMap || current?.data.id;
      if (!id) return;
      desiredRef.current = { id, epoch };
      // A resource reload keeps the same map id but must still re-read the map and its annotations.
      if (force || !current || current.data.id !== id) {
        await loadModel(preferences, nextPlayers, id, epoch, force);
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
    const epoch = epochRef.current;
    const request = ++annotationRequestRef.current;
    const next = await store
      .dispatch(api.endpoints.getAnnotations.initiate(current.data.id, { forceRefetch: true }))
      .unwrap();
    if (
      request !== annotationRequestRef.current ||
      epoch !== epochRef.current ||
      modelRef.current?.data.id !== current.data.id
    )
      return;
    setModel((previous) => (previous ? { ...previous, items: next.value.items || [] } : previous));
  }, []);

  const handle = useCallback(
    async (event: MessageEvent<string>) => {
      const value = eventData(event);
      if (value.type === 'snapshot') {
        const epoch = ++epochRef.current;
        annotationRequestRef.current++;
        setModel(undefined);
        modelRef.current = undefined;
        beginLoad(epoch);
        setLayersOpen(false);
        setLoadError('');
        setStage(18, 'cast.waitingSnapshot');
        settingsRef.current = value.overlaySettings;
        setMarkerPreferences(value.markerPreferences);
        setOwnerId(value.ownerId || '');
        setMultiplayerStatus(value.multiplayerStatus);
        terminalRef.current = false;
        playersRef.current = new Map(
          (value.players || []).map((player) => [player.playerId, player]),
        );
        playerSource.current = playersRef.current;
        playerListenersRef.current.forEach((listener) => listener());
        await applyLanguage(value.language);
        try {
          if (value.preferences)
            // Force the re-read: a cached map or annotation document would otherwise survive a
            // reconnect made within the query cache's window.
            await applyPreferences(value.preferences, playersRef.current, epoch, true);
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
      if (value.type === 'marker_preferences_changed' && value.markerPreferences) {
        setMarkerPreferences(value.markerPreferences);
        return;
      }
      if (value.type === 'multiplayer_changed') {
        setMultiplayerStatus(value.multiplayerStatus);
        return;
      }
      if (value.type === 'resources_changed') {
        // The mode or the data root moved: everything the cast mirrors has to be re-read, and any
        // load already in flight belongs to the previous repository.
        const epoch = ++epochRef.current;
        annotationRequestRef.current++;
        try {
          const result = await store
            .dispatch(api.endpoints.getMapPreferences.initiate(undefined, { forceRefetch: true }))
            .unwrap();
          if (epoch !== epochRef.current) return;
          await applyPreferences(result.value, playersRef.current, epoch, true);
        } catch (error) {
          if (epoch === epochRef.current)
            setLoadError(error instanceof Error ? error.message : 'errors.request_failed');
        }
        return;
      }
      if (value.type === 'player_upsert' && value.player) {
        playersRef.current.set(value.player.playerId, value.player);
        playerListenersRef.current.forEach((listener) => listener());
        return;
      }
      if (value.type === 'player_remove' && value.playerId) {
        playersRef.current.delete(value.playerId);
        playerListenersRef.current.forEach((listener) => listener());
        return;
      }
      if (value.type === 'annotations_changed') {
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
          const result = await store
            .dispatch(api.endpoints.getMapPreferences.initiate(undefined, { forceRefetch: true }))
            .unwrap();
          await applyPreferences(result.value);
        }
        return;
      }
      if (value.type === 'session_end' || value.type === 'session_expired') {
        terminalRef.current = true;
        eventSourceRef.current?.close();
        setTerminal(value.type === 'session_expired' ? 'cast.expired' : 'cast.ended');
      }
    },
    [applyLanguage, applyPreferences, beginLoad, reloadAnnotations, setStage, playerSource],
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
      'marker_preferences_changed',
      'multiplayer_changed',
      'resources_changed',
      'player_upsert',
      'player_remove',
      'annotations_changed',
      'session_end',
      'session_expired',
    ]) {
      source.addEventListener(name, (event) => {
        void handle(event as MessageEvent<string>).catch((error: unknown) => {
          if (!terminalRef.current) {
            setLoadError(error instanceof Error ? error.message : 'errors.request_failed');
          }
        });
      });
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

  // Marker visibility mirrors the dashboard map through the shared rule: a manual hide always wins,
  // the local owner's markers render unless the dashboard hid them, explicitly shown owners render,
  // room members default visible, departed owners default hidden. No identity means "show all".
  const ownerVisibility = useMemo(() => {
    const hiddenOwners = markerPreferences?.hiddenOwners;
    const shownOwners = markerPreferences?.shownOwners;
    return ownerVisibilityFor({
      selfId: ownerId,
      activeOwners: (multiplayerStatus?.members || []).map((member) => member.peerId),
      hiddenOwners: hiddenOwners || [],
      shownOwners: shownOwners || [],
    });
  }, [ownerId, multiplayerStatus, markerPreferences]);

  return (
    <main ref={castRootRef} className="cast-root">
      {model && (
        <>
          <MapCanvas
            key={canvasKey}
            data={model.data}
            preference={model.preference}
            stickers={model.stickers}
            items={model.items}
            players={playersRef.current}
            playerSource={playerSource}
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
            ownerVisibility={ownerVisibility}
            onProgress={(value) => {
              if (value >= 95) {
                const epoch = epochRef.current;
                requestAnimationFrame(() => {
                  if (epoch === epochRef.current) markReady();
                });
                return;
              }
              // Tile batches keep reporting while the phone pans; once the map has painted they must
              // not re-open the full-screen overlay, which is what made every gesture flash.
              if (!readyRef.current) setStage(Math.max(42, value), 'cast.loadingResources');
            }}
            onTileBusy={onTileBusy}
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
          {layersOpen && (
            <Suspense fallback={null}>
              <CastLayers
                reference={layersButtonRef}
                boundaryRef={castRootRef}
                portrait={portrait}
                data={model.data}
                items={model.items}
                preference={model.preference}
                onPreference={setPreference}
                onClose={() => setLayersOpen(false)}
              />
            </Suspense>
          )}
          {tileBusy && !terminal && (
            <div className="cast-busy" role="status" aria-label={t('cast.loadingResources')}>
              <span className="spinner" />
            </div>
          )}
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
