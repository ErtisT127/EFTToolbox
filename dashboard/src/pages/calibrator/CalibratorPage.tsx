import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { isImeComposing, useImeComposition } from '../../lib/ime';
import {
  Hand,
  MousePointer2,
  RectangleHorizontal,
  Scaling,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  X,
  Satellite,
  Shapes,
  TriangleAlert,
  Maximize,
  Minimize,
  Minus,
  Plus,
  RotateCcw,
  FileWarning,
  Star,
} from 'lucide-react';
import type L from 'leaflet';
import type {
  CalibrationDocument,
  CalibrationRegion,
  MapData,
  WorldXZ,
  WorldRectXZ,
} from '../../../../contracts/ts/ipc.gen';
import { isUsableMapData, workspace, useWorkspace } from '../../stores/workspaceStore';
import { useOverlay } from '../../stores/overlayStore';
import { CalibrationViewport, MIN_REGION_SIZE } from './CalibrationViewport';
import { useLocale, type LocaleKey } from '../../hooks/useLocale';
import { NumericField } from '../../components/NumericField';
import { NumberStepper } from '../../components/NumberStepper';
import { CalibrationRegionLimits } from '../../../../contracts/ts/ipc.gen';
import { notices } from '../../stores/noticeStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useRegisterConflictActions } from '../../stores/conflictActions';
import { ToolToolbar } from '../../components/ToolToolbar';
import { HintTooltip } from '../../components/HintTooltip';
import { MapUnavailableState } from '../../components/MapUnavailableState';
import { ErrorState } from '../../components/ErrorState';
import { ZOOM_BOUND_EPSILON } from '../map/lib/zoom';
import { DataLoadError, errorKeyOf } from '../../lib/errors';
import { api, isRevisionConflict } from '../../stores/api';
import { store, type RootState } from '../../stores/store';
import {
  clearCalibrationEditor,
  clearCalibrationEditorDraft,
  clearConflict,
  setCalibrationEditorDraft,
  setCalibrationEditorHistory,
  setCalibrationEditorSaveState,
  setConflict,
} from '../../stores/clientState';

const emptyRect: WorldRectXZ = {
  minX: 0,
  maxX: MIN_REGION_SIZE,
  minZ: 0,
  maxZ: MIN_REGION_SIZE,
};
type Tool = 'select' | 'edit' | 'rect' | 'resize';
type Basemap = 'svg' | 'tiles';
type TreeSelection =
  | { type: 'map'; mapId: string }
  | { type: 'floor'; mapId: string; floorId: string }
  | { type: 'region'; mapId: string; floorId: string; regionId: string };

function calibrationFloors(data: MapData, basemap: string) {
  return data.floors.filter((floor) =>
    basemap === 'tiles'
      ? data.tiles.some((tile) => tile.floorId === floor.id) || floor.svgGroups.length > 0
      : floor.svgGroups.length > 0,
  );
}

function isValidRegion(region: CalibrationRegion) {
  const rectangleValid = region.coversEntireMap
    ? Object.values(region.rectangle).every(Number.isFinite)
    : region.rectangle.maxX - region.rectangle.minX >= MIN_REGION_SIZE &&
      region.rectangle.maxZ - region.rectangle.minZ >= MIN_REGION_SIZE;
  return (
    region.name.trim().length > 0 &&
    region.name.length <= 64 &&
    Object.values(region.rectangle).every(Number.isFinite) &&
    Object.values(region.yRange).every(Number.isFinite) &&
    rectangleValid &&
    region.yRange.min < region.yRange.max &&
    Number.isInteger(region.priority) &&
    region.priority >= 0 &&
    region.priority <= 9999
  );
}

function placeholderRectangle(data: MapData): WorldRectXZ {
  const [a, b] = data.projection.bounds;
  return {
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minZ: Math.min(a.z, b.z),
    maxZ: Math.max(a.z, b.z),
  };
}

function regionsOverlap(a: CalibrationRegion, b: CalibrationRegion) {
  return (
    a.yRange.min < b.yRange.max &&
    b.yRange.min < a.yRange.max &&
    (a.coversEntireMap ||
      b.coversEntireMap ||
      (a.rectangle.minX < b.rectangle.maxX &&
        b.rectangle.minX < a.rectangle.maxX &&
        a.rectangle.minZ < b.rectangle.maxZ &&
        b.rectangle.minZ < a.rectangle.maxZ))
  );
}

const conflictCache = new WeakMap<CalibrationRegion[], Set<string>>();

function findConflicts(regions: CalibrationRegion[]) {
  const cached = conflictCache.get(regions);
  if (cached) return cached;
  const conflicts = new Set<string>();
  const left = (region: CalibrationRegion) =>
    region.coversEntireMap ? -Infinity : region.rectangle.minX;
  const right = (region: CalibrationRegion) =>
    region.coversEntireMap ? Infinity : region.rectangle.maxX;
  const order = regions
    .map((region, index) => ({ region, index }))
    .sort((a, b) => left(a.region) - left(b.region));
  const active: number[] = [];
  for (const current of order) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (right(regions[active[i]]) <= left(current.region)) active.splice(i, 1);
    }
    for (const index of active) {
      const a = regions[index],
        b = current.region;
      if (a.priority === b.priority && regionsOverlap(a, b)) {
        conflicts.add(a.id);
        conflicts.add(b.id);
      }
    }
    active.push(current.index);
  }
  conflictCache.set(regions, conflicts);
  return conflicts;
}

function sameCalibration(a: CalibrationDocument | undefined, b: CalibrationDocument) {
  if (!a) return false;
  return JSON.stringify({ ...a, revision: 0 }) === JSON.stringify({ ...b, revision: 0 });
}

function normalizeCalibrationDocument(document: CalibrationDocument): CalibrationDocument {
  return {
    ...document,
    regions: Array.isArray(document.regions) ? document.regions : [],
  };
}

function calibrationKey(mapId: string, basemap: Basemap) {
  return `${mapId}:${basemap}`;
}

export function CalibratorPage() {
  const { t, locale } = useLocale();
  const w = useWorkspace(workspace);
  const overlay = useOverlay();
  const [tool, setTool] = useState<Tool>('select');
  const [mapLoadError, setMapLoadError] = useState<string | null>(null);
  const [calibrationLoadError, setCalibrationLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const mapData = useSelector(
    (state: RootState) =>
      new Map(
        w.catalog.flatMap((map) => {
          const data = api.endpoints.getMap.select({ id: map.id, locale })(state).data;
          return data ? [[map.id, data] as const] : [];
        }),
      ),
    (a, b) => a.size === b.size && [...a].every(([id, data]) => b.get(id) === data),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<CalibrationRegion | null>(null);
  const [cursor, setCursor] = useState<WorldXZ | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const pageRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoom, setZoom] = useState<{ zoom: number; min: number; max: number } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const docRef = useRef<CalibrationDocument | null>(null);
  const confirmedDocRef = useRef<CalibrationDocument | null>(null);
  const rectangleHistory = useRef(false);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const treeContentRef = useRef<HTMLDivElement>(null);
  const treeScrollTopRef = useRef(0);
  const floorButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const consumedReloadToken = useRef(0);
  const calibratorPreference = w.calibratorPreference;
  const collapsed = calibratorPreference.sidebarCollapsed;
  const calibratorMapId =
    calibratorPreference.selection?.mapId || w.activeId || w.catalog[0]?.id || '';
  const currentMapData = mapData.get(calibratorMapId) || null;
  const preference = currentMapData ? w.preferenceForData(calibratorMapId, currentMapData) : null;
  const basemap: Basemap = preference?.basemap === 'tiles' ? 'tiles' : 'svg';
  const activeCalibrationKey = calibrationKey(calibratorMapId, basemap);
  const calibrationData = useSelector(
    (state: RootState) =>
      new Map(
        w.catalog.flatMap((map) => {
          const data = mapData.get(map.id);
          if (!data) return [];
          const basemaps: Basemap[] = [
            ...(data.svgUrl ? ['svg' as const] : []),
            ...(data.tiles.length ? ['tiles' as const] : []),
          ];
          return basemaps.flatMap((mapBasemap) => {
            const value = api.endpoints.getCalibration.select({ id: map.id, basemap: mapBasemap })(
              state,
            ).data?.value;
            return value ? [[calibrationKey(map.id, mapBasemap), value] as const] : [];
          });
        }),
      ),
    (a, b) => a.size === b.size && [...a].every(([key, value]) => b.get(key) === value),
  );
  const editor = useSelector(
    (state: RootState) => state.client.calibrationEditors[activeCalibrationKey],
  );
  const calibrationConflictKey = `calibration:${activeCalibrationKey}`;
  // The conflict banner is window-level; this page supplies the two page-scoped choices.
  useRegisterConflictActions(calibrationConflictKey, {
    loadRemote: () => {
      void store
        .dispatch(
          api.endpoints.getCalibration.initiate(
            { id: calibratorMapId, basemap },
            { forceRefetch: true },
          ),
        )
        .unwrap()
        .then((remote) => {
          const next = normalizeCalibrationDocument(remote.value);
          docRef.current = next;
          confirmedDocRef.current = structuredClone(next);
          store.dispatch(clearCalibrationEditor(activeCalibrationKey));
          store.dispatch(clearConflict(calibrationConflictKey));
        });
    },
    retry: () => {
      void store
        .dispatch(
          api.endpoints.getCalibration.initiate(
            { id: calibratorMapId, basemap },
            { forceRefetch: true },
          ),
        )
        .unwrap()
        .then((remote) => {
          const local = store.getState().client.calibrationEditors[activeCalibrationKey]?.draft;
          if (local) {
            const updated = { ...local, revision: remote.value.revision };
            docRef.current = updated;
            store.dispatch(
              setCalibrationEditorDraft({ key: activeCalibrationKey, draft: updated }),
            );
            saveNow(updated, true);
          }
        });
    },
  });
  const doc = editor?.draft || calibrationData.get(activeCalibrationKey) || null;
  const past = editor?.past || [];
  const future = editor?.future || [];
  const treeSelection = useMemo<TreeSelection>(() => {
    if (calibratorPreference.selection?.type === 'floor' && calibratorPreference.selection.floorId)
      return {
        type: 'floor',
        mapId: calibratorPreference.selection.mapId,
        floorId: calibratorPreference.selection.floorId,
      };
    if (
      calibratorPreference.selection?.type === 'region' &&
      calibratorPreference.selection.floorId &&
      calibratorPreference.selection.regionId
    )
      return {
        type: 'region',
        mapId: calibratorPreference.selection.mapId,
        floorId: calibratorPreference.selection.floorId,
        regionId: calibratorPreference.selection.regionId,
      };
    return {
      type: 'map',
      mapId: calibratorMapId,
    };
  }, [calibratorPreference.selection, calibratorMapId]);
  const expandedMaps = (mapId: string) => !calibratorPreference.collapsedMaps.includes(mapId);
  const expandedFloors = (floorId: string) =>
    !calibratorPreference.collapsedFloors.includes(floorId);
  const floorId = preference?.floorId || currentMapData?.defaultFloor || '';
  const previousContextKey = useRef(activeCalibrationKey);
  useEffect(() => {
    const sync = () => setIsFullscreen(document.fullscreenElement === pageRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  useEffect(() => {
    if (!w.catalog.length) return;
    const forceReload = reloadToken > consumedReloadToken.current;
    consumedReloadToken.current = reloadToken;
    let cancelled = false;
    setMapLoadError(null);
    setCalibrationLoadError(null);
    docRef.current = null;
    confirmedDocRef.current = null;
    const load = async () => {
      let mapEntries: Array<readonly [string, MapData]>;
      try {
        mapEntries = await Promise.all(
          w.catalog.map(async (map) => {
            const data = await store
              .dispatch(
                api.endpoints.getMap.initiate(
                  { id: map.id, locale },
                  { forceRefetch: forceReload },
                ),
              )
              .unwrap();
            if (!isUsableMapData(data))
              throw new DataLoadError('errors.map_data_invalid', 'calibrator');
            return [map.id, data] as const;
          }),
        );
      } catch (error) {
        if (!cancelled) setMapLoadError(errorKeyOf(error, 'errors.request_failed'));
        return;
      }
      if (cancelled) return;
      const loadedMapData = new Map(mapEntries);
      try {
        await Promise.all(
          w.catalog.flatMap((map) => {
            const data = loadedMapData.get(map.id);
            const basemaps: Basemap[] = [
              ...(data?.svgUrl ? (['svg'] as Basemap[]) : []),
              ...(data?.tiles.length ? (['tiles'] as Basemap[]) : []),
            ];
            return basemaps.map(async (basemap) => {
              const result = await store
                .dispatch(
                  api.endpoints.getCalibration.initiate(
                    { id: map.id, basemap },
                    { forceRefetch: forceReload },
                  ),
                )
                .unwrap();
              const calibration = normalizeCalibrationDocument(result.value);
              if (
                calibration.mapId !== map.id ||
                calibration.basemap !== basemap ||
                !Array.isArray(calibration.regions)
              )
                throw new DataLoadError('errors.calibration_invalid', 'calibrator');
              return [calibrationKey(map.id, basemap), calibration] as const;
            });
          }),
        );
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof DataLoadError
              ? error.errorKey
              : error instanceof Error
                ? error.message
                : 'errors.calibration_invalid';
          if (message === 'errors.request_failed') setMapLoadError(message);
          else setCalibrationLoadError(message);
        }
        return;
      }
      if (cancelled) return;
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [w.catalog, t, locale, reloadToken]);
  useEffect(() => {
    const next = calibrationData.get(activeCalibrationKey);
    if (!next) return;
    if (store.getState().client.calibrationEditors[activeCalibrationKey]?.draft) return;
    // calibrationData also contains optimistic local edits. Do not treat a
    // same-map update as a fresh remote load and confirm an unsaved document.
    if (doc && next.mapId === doc.mapId && next.basemap === doc.basemap) return;
    docRef.current = next;
    confirmedDocRef.current = structuredClone(next);
    setSelected(null);
    setDraft(null);
    store.dispatch(clearCalibrationEditor(activeCalibrationKey));
  }, [activeCalibrationKey, calibrationData, calibratorMapId, doc]);
  useEffect(() => {
    if (!mapData.size || mapData.has(calibratorMapId)) return;
    const fallback = mapData.has(w.activeId) ? w.activeId : [...mapData.keys()][0];
    if (fallback) updateTreeSelection({ type: 'map', mapId: fallback });
  }, [calibratorMapId, mapData, w.activeId]);
  const activeDoc = doc?.mapId === calibratorMapId && doc.basemap === basemap ? doc : null;
  const contextReady = activeDoc !== null;
  const rememberTreeScroll = () => {
    if (treeContentRef.current) treeScrollTopRef.current = treeContentRef.current.scrollTop;
  };
  useLayoutEffect(() => {
    if (contextReady) treeContentRef.current?.scrollTo({ top: treeScrollTopRef.current });
  }, [activeCalibrationKey, contextReady]);
  const regions = useMemo(
    () => activeDoc?.regions.filter((r) => r.floorId === floorId) || [],
    [activeDoc, floorId],
  );
  const conflictsByCalibration = useMemo(() => {
    const calibration = calibrationData.get(activeCalibrationKey);
    if (!calibration) return new Map<string, Set<string>>();
    return new Map([
      [activeCalibrationKey, findConflicts(doc ? doc.regions : calibration.regions)],
    ]);
  }, [activeCalibrationKey, calibrationData, doc]);
  const conflictIds = conflictsByCalibration.get(activeCalibrationKey);
  const updateTreeSelection = (selection: TreeSelection) => {
    workspace.updateCalibratorPreference({ selection });
  };
  const selectRegion = (region: CalibrationRegion) => {
    setSelected(region.id);
    setDraft(structuredClone(region));
    updateTreeSelection({
      type: 'region',
      mapId: calibratorMapId,
      floorId: region.floorId,
      regionId: region.id,
    });
  };
  const rollbackDraft = () => {
    if (!draft) return;
    const region = docRef.current?.regions.find((item) => item.id === draft.id);
    if (region) setDraft(structuredClone(region));
    else setDraft(null);
  };
  const replaceCalibration = (value: CalibrationDocument) => {
    const next = normalizeCalibrationDocument(value);
    docRef.current = next;
    confirmedDocRef.current = structuredClone(next);
    store.dispatch(clearCalibrationEditor(calibrationKey(next.mapId, next.basemap as Basemap)));
    const restored = next.regions.find((region) => region.id === selected);
    setSelected(restored ? restored.id : null);
    setDraft(restored ? structuredClone(restored) : null);
  };
  const saveNow = (value: CalibrationDocument, allowConflict = false) => {
    if (!value.regions.every((region) => isValidRegion(region))) return;
    const key = calibrationKey(value.mapId, value.basemap as Basemap);
    if (
      !allowConflict &&
      store.getState().client.conflicts.some((item) => item.key === `calibration:${key}`)
    )
      return;
    store.dispatch(setCalibrationEditorSaveState({ key, changes: { saving: true } }));
    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        const payload =
          docRef.current &&
          calibrationKey(docRef.current.mapId, docRef.current.basemap as Basemap) ===
            calibrationKey(value.mapId, value.basemap as Basemap)
            ? docRef.current
            : value;
        if (!payload.regions.every((region) => isValidRegion(region))) return;
        if (sameCalibration(confirmedDocRef.current || undefined, payload)) return;
        const key = calibrationKey(payload.mapId, payload.basemap as Basemap);
        if (
          !allowConflict &&
          store.getState().client.conflicts.some((item) => item.key === `calibration:${key}`)
        )
          return;
        const current = api.endpoints.getCalibration.select({
          id: payload.mapId,
          basemap: payload.basemap,
        })(store.getState()).data;
        const saved = await store
          .dispatch(
            api.endpoints.updateCalibration.initiate({
              value: payload,
              revision: current?.revision || '',
              etag: current?.etag || '',
            }),
          )
          .unwrap();
        const next = saved.value;
        const latest = docRef.current;
        const synchronized =
          latest &&
          calibrationKey(latest.mapId, latest.basemap as Basemap) ===
            calibrationKey(next.mapId, next.basemap as Basemap)
            ? { ...latest, revision: next.revision }
            : next;
        docRef.current = synchronized;
        confirmedDocRef.current = structuredClone(next);
        store.dispatch(
          api.util.updateQueryData(
            'getCalibration',
            { id: next.mapId, basemap: next.basemap },
            () => saved,
          ),
        );
        if (
          JSON.stringify(store.getState().client.calibrationEditors[key]?.draft) ===
          JSON.stringify(payload)
        )
          // Keep past/future: wiping the whole editor here emptied the undo stack before the user
          // could ever touch it, since this runs on every debounced save.
          store.dispatch(clearCalibrationEditorDraft(key));
        else
          store.dispatch(
            setCalibrationEditorSaveState({
              key,
              changes: {
                savedRevision: store.getState().client.calibrationEditors[key]?.editRevision || 0,
              },
            }),
          );
        store.dispatch(clearConflict(`calibration:${key}`));
      })
      .catch(async (error: unknown) => {
        const message = errorKeyOf(error, 'errors.calibration_save_failed');
        if (isRevisionConflict(error)) {
          try {
            const latestResult = await store
              .dispatch(
                api.endpoints.getCalibration.initiate(
                  { id: value.mapId, basemap: value.basemap },
                  { forceRefetch: true },
                ),
              )
              .unwrap();
            const latest = normalizeCalibrationDocument(latestResult.value);
            if (latest.mapId !== value.mapId || latest.basemap !== value.basemap)
              throw new Error('errors.calibration_invalid');
            store.dispatch(
              setConflict({
                key: `calibration:${calibrationKey(value.mapId, value.basemap as Basemap)}`,
                resource: 'calibration',
                entityId: calibrationKey(value.mapId, value.basemap as Basemap),
              }),
            );
            notices.push(t('errors.revision_conflict'));
          } catch (refreshError: unknown) {
            notices.push(t(errorKeyOf(refreshError, 'errors.request_failed') as LocaleKey));
          }
          return;
        }
        if (message === 'errors.calibration_invalid') {
          const confirmed = confirmedDocRef.current;
          if (
            confirmed &&
            calibrationKey(confirmed.mapId, confirmed.basemap as Basemap) ===
              calibrationKey(value.mapId, value.basemap as Basemap)
          ) {
            replaceCalibration(confirmed);
          }
        }
        notices.push(t(message as LocaleKey));
      })
      .finally(() =>
        store.dispatch(setCalibrationEditorSaveState({ key, changes: { saving: false } })),
      );
  };
  const scheduleSave = (value: CalibrationDocument, immediate = false) => {
    if (
      store
        .getState()
        .client.conflicts.some(
          (item) =>
            item.key === `calibration:${calibrationKey(value.mapId, value.basemap as Basemap)}`,
        )
    )
      return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (immediate) {
      saveNow(value);
      return;
    }
    saveTimer.current = setTimeout(() => saveNow(value), 600);
  };
  const flushSave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (docRef.current) saveNow(docRef.current);
  };
  const applyDocument = (
    next: CalibrationDocument,
    persistence: 'debounce' | 'immediate' | 'none',
    record = true,
  ) => {
    const key = calibrationKey(next.mapId, next.basemap as Basemap);
    store.dispatch(
      setCalibrationEditorDraft({ key, draft: next, record, base: docRef.current || undefined }),
    );
    docRef.current = next;
    if (persistence === 'immediate') saveNow(next);
    if (persistence === 'debounce') scheduleSave(next);
  };
  const create = (rectangle = emptyRect) => {
    if (!doc || !floorId) return false;
    const n = doc.nextRegionNumber;
    const region: CalibrationRegion = {
      id: crypto.randomUUID(),
      floorId,
      name: `Region ${n}`,
      rectangle,
      yRange: { min: 0, max: 10 },
      priority: 1,
      coversEntireMap: false,
    };
    const next = { ...doc, nextRegionNumber: n + 1, regions: [...doc.regions, region] };
    applyDocument(next, 'immediate');
    selectRegion(region);
    return true;
  };
  const update = (patch: Partial<CalibrationRegion>, persist = true, record = persist) => {
    if (!draft || !doc) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    if (!isValidRegion(next)) return;
    const nextDoc = { ...doc, regions: doc.regions.map((r) => (r.id === next.id ? next : r)) };
    applyDocument(nextDoc, persist ? 'debounce' : 'none', record);
  };
  // One undo step per typing burst, not per character: the first change after a second of idle
  // pushes the pre-edit document, and everything typed within the window joins that step.
  const lastNameRecordAt = useRef(0);
  const recordNameStep = () => {
    const now = Date.now();
    if (now - lastNameRecordAt.current <= 1000) return false;
    lastNameRecordAt.current = now;
    return true;
  };
  // The region name saves through the 600ms debounce. While the IME is composing, the text stays
  // in the input and the local draft only: dispatching the document on every keystroke makes React
  // rewrite the input's value mid-composition, and a real IME (verified with Sogou/TSF) cancels its
  // composition when the focused field is written to — pinyin never reaches the screen. The finished
  // text arrives with compositionend and is dispatched and persisted once.
  const { composing: composingName, composerProps: nameComposerProps } = useImeComposition(
    (value) => {
      // Nothing was dispatched while composing, so only the confirmed document tells us whether
      // this commit still has something to persist.
      const saved = confirmedDocRef.current?.regions.find(
        (region) => region.id === draft?.id,
      )?.name;
      if (saved !== value) update({ name: value });
    },
  );
  const updateRectangleField = (axis: 'x' | 'z', edge: 'min' | 'max', value: number) => {
    if (!draft) return;
    const rectangle = { ...draft.rectangle };
    if (axis === 'x') {
      if (edge === 'min') rectangle.minX = Math.min(value, rectangle.maxX - MIN_REGION_SIZE);
      else rectangle.maxX = Math.max(value, rectangle.minX + MIN_REGION_SIZE);
    } else if (edge === 'min') {
      rectangle.minZ = Math.min(value, rectangle.maxZ - MIN_REGION_SIZE);
    } else rectangle.maxZ = Math.max(value, rectangle.minZ + MIN_REGION_SIZE);
    update({ rectangle });
  };
  const toggleFullCover = (checked: boolean) => {
    if (!draft) return;
    const alreadyUsed = regions.some((region) => region.id !== draft.id && region.coversEntireMap);
    if (checked && alreadyUsed) return;
    update({
      coversEntireMap: checked,
      rectangle: checked && currentMapData ? placeholderRectangle(currentMapData) : draft.rectangle,
    });
  };
  const updateRectangle = (id: string, rectangle: WorldRectXZ) => {
    const currentDoc = docRef.current;
    const region = currentDoc?.regions.find((item) => item.id === id);
    if (!currentDoc || !region) return;
    const nextRegion = { ...region, rectangle };
    if (!isValidRegion(nextRegion)) return;
    const nextDoc = {
      ...currentDoc,
      regions: currentDoc.regions.map((item) => (item.id === id ? nextRegion : item)),
    };
    applyDocument(nextDoc, 'none', false);
    if (draft?.id === id) setDraft(nextRegion);
  };
  const closeDetails = () => {
    setDraft(null);
    setSelected(null);
    if (floorId) updateTreeSelection({ type: 'floor', mapId: calibratorMapId, floorId });
    else updateTreeSelection({ type: 'map', mapId: calibratorMapId });
  };
  const remove = () => {
    const currentDoc = docRef.current;
    if (!currentDoc || !draft) return;
    const floorId = draft.floorId;
    const next = {
      ...currentDoc,
      regions: currentDoc.regions.filter((region) => region.id !== draft.id),
    };
    applyDocument(next, 'immediate');
    setDraft(null);
    setSelected(null);
    setConfirmDelete(false);
    updateTreeSelection({ type: 'floor', mapId: calibratorMapId, floorId });
    requestAnimationFrame(() =>
      floorButtonRefs.current.get(`${calibratorMapId}:${floorId}`)?.focus(),
    );
  };
  const selectMap = (mapId: string) => {
    rememberTreeScroll();
    if (mapId !== calibratorMapId) flushSave();
    updateTreeSelection({ type: 'map', mapId });
    setSelected(null);
    setDraft(null);
  };
  const selectFloor = (mapId: string, nextFloorId: string) => {
    const data = mapData.get(mapId);
    if (!data) return;
    if (mapId === calibratorMapId) flushSave();
    setSelected(null);
    setDraft(null);
    workspace.updatePreferenceForData(mapId, data, { floorId: nextFloorId });
    updateTreeSelection({ type: 'floor', mapId, floorId: nextFloorId });
  };
  const selectTreeRegion = (mapId: string, region: CalibrationRegion) => {
    const data = mapData.get(mapId);
    if (!data) return;
    if (mapId === calibratorMapId) flushSave();
    workspace.updatePreferenceForData(mapId, data, { floorId: region.floorId });
    if (mapId === calibratorMapId) selectRegion(region);
    else
      updateTreeSelection({
        type: 'region',
        mapId,
        floorId: region.floorId,
        regionId: region.id,
      });
  };
  const toggleMap = (mapId: string) => {
    const next = calibratorPreference.collapsedMaps.includes(mapId)
      ? calibratorPreference.collapsedMaps.filter((id) => id !== mapId)
      : [...calibratorPreference.collapsedMaps, mapId];
    workspace.updateCalibratorPreference({ collapsedMaps: next });
  };
  const toggleFloor = (id: string) => {
    const next = calibratorPreference.collapsedFloors.includes(id)
      ? calibratorPreference.collapsedFloors.filter((value) => value !== id)
      : [...calibratorPreference.collapsedFloors, id];
    workspace.updateCalibratorPreference({ collapsedFloors: next });
  };
  const undo = () => {
    const current = docRef.current;
    const previous = past[past.length - 1];
    if (!current || !previous) return;
    store.dispatch(
      setCalibrationEditorHistory({
        key: activeCalibrationKey,
        past: past.slice(0, -1),
        future: [current, ...future],
      }),
    );
    applyDocument({ ...previous, revision: current.revision }, 'immediate', false);
    const region = previous.regions.find((item) => item.id === selected);
    if (region) setDraft(structuredClone(region));
  };
  const redo = () => {
    const current = docRef.current;
    const next = future[0];
    if (!current || !next) return;
    store.dispatch(
      setCalibrationEditorHistory({
        key: activeCalibrationKey,
        past: [...past, current].slice(-50),
        future: future.slice(1),
      }),
    );
    applyDocument({ ...next, revision: current.revision }, 'immediate', false);
    const region = next.regions.find((item) => item.id === selected);
    if (region) setDraft(structuredClone(region));
  };
  // Page-scoped undo shortcuts: a browser page only sees keys while its window is focused, so these
  // can never swallow system input the way the overlay's registered hotkeys do. Inside text fields
  // the browser's own undo stays in charge. The ref keeps the handler reading the current history
  // without re-registering on every render.
  const undoRedoRef = useRef({ undo, redo });
  undoRedoRef.current = { undo, redo };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isImeComposing(event) || event.altKey) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('input,textarea,select,[contenteditable="true"]')
      )
        return;
      event.preventDefault();
      if (key === 'y' || event.shiftKey) undoRedoRef.current.redo();
      else undoRedoRef.current.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const draftErrors = useMemo(() => {
    if (!draft) return {} as Record<string, string>;
    const errors: Record<string, string> = {};
    if (!draft.name.trim()) errors.name = t('errors.calibration_name_required');
    if (draft.name.length > 64) errors.name = t('errors.calibration_name_too_long');
    if (!draft.coversEntireMap && draft.rectangle.maxX - draft.rectangle.minX < MIN_REGION_SIZE)
      errors.x = t('errors.calibration_rectangle_too_small');
    if (!draft.coversEntireMap && draft.rectangle.maxZ - draft.rectangle.minZ < MIN_REGION_SIZE)
      errors.z = t('errors.calibration_rectangle_too_small');
    if (!(draft.yRange.min < draft.yRange.max)) errors.y = t('errors.calibration_y_range_invalid');
    if (!Number.isInteger(draft.priority) || draft.priority < 0 || draft.priority > 9999)
      errors.priority = t('errors.calibration_priority_invalid');
    return errors;
  }, [draft, t]);
  const hasBasemapToggle = !!currentMapData?.svgUrl && currentMapData.tiles.length > 0;
  const toggleBasemapForMap = async (mapId: string) => {
    const data = mapData.get(mapId);
    if (!data?.svgUrl || !data.tiles.length) return;
    rememberTreeScroll();
    selectMap(mapId);
    const current = workspace.preferenceForData(mapId, data);
    workspace.updatePreferenceForData(mapId, data, {
      basemap: current.basemap === 'svg' ? 'tiles' : 'svg',
    });
  };
  const toggleBasemap = () => {
    if (!preference || !hasBasemapToggle) return;
    flushSave();
    // The sidebar stays where it is: the tree selection outlives the switch, and when the other
    // basemap's document arrives the selection effect re-selects the region — or falls back to the
    // floor, since regions belong to one basemap's document.
    void toggleBasemapForMap(calibratorMapId);
  };
  useEffect(() => {
    if (previousContextKey.current === activeCalibrationKey) return;
    previousContextKey.current = activeCalibrationKey;
    flushSave();
    docRef.current = null;
    confirmedDocRef.current = null;
    setSelected(null);
    setDraft(null);
    // Keep past/future so the undo history survives switching maps or basemaps and back.
    store.dispatch(clearCalibrationEditorDraft(activeCalibrationKey));
    setConfirmDelete(false);
    rectangleHistory.current = false;
    if (treeSelection.mapId !== calibratorMapId)
      updateTreeSelection({ type: 'map', mapId: calibratorMapId });
    else if (treeSelection.type !== 'region' && floorId)
      updateTreeSelection({ type: 'floor', mapId: calibratorMapId, floorId });
  }, [activeCalibrationKey, treeSelection.mapId, calibratorMapId]); // eslint-disable-line react-hooks/exhaustive-deps
  const handledCalibrationEpoch = useRef(overlay.calibrationEpoch);
  useEffect(() => {
    if (overlay.calibrationEpoch <= handledCalibrationEpoch.current || !overlay.calibrationMapId)
      return;
    handledCalibrationEpoch.current = overlay.calibrationEpoch;
    const mapId = overlay.calibrationMapId;
    const map = mapData.get(mapId);
    const changedBasemap: Basemap =
      overlay.view?.connected && overlay.view.mapId === mapId
        ? overlay.view.basemap
        : map
          ? (workspace.preferenceForData(mapId, map).basemap as Basemap)
          : 'svg';
    let cancelled = false;
    void store
      .dispatch(
        api.endpoints.getCalibration.initiate(
          { id: mapId, basemap: changedBasemap },
          { forceRefetch: true },
        ),
      )
      .unwrap()
      .then((result) => {
        const value = result.value;
        const next = normalizeCalibrationDocument(value);
        if (next.mapId !== mapId || next.basemap !== changedBasemap)
          throw new Error('errors.calibration_invalid');
        if (cancelled) return;
        if (mapId === calibratorMapId && changedBasemap === basemap && !draft) {
          docRef.current = next;
          confirmedDocRef.current = structuredClone(next);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          notices.push(t(errorKeyOf(error, 'errors.calibration_invalid') as LocaleKey));
      });
    return () => {
      cancelled = true;
    };
  }, [
    overlay.calibrationEpoch,
    overlay.calibrationMapId,
    overlay.view,
    calibratorMapId,
    basemap,
    draft,
    mapData,
    t,
  ]);
  useEffect(() => {
    // While the user edits a field in this panel, the draft may legitimately diverge from the
    // document: an invalid intermediate value (an emptied name, crossed y-range) never dispatches.
    // Re-applying the selection here would roll the field back under the caret — and with an IME
    // open, the composing name lives in the draft alone as well.
    if (detailRef.current?.contains(document.activeElement)) return;
    if (composingName.current) return;
    if (treeSelection.mapId !== calibratorMapId || !activeDoc || !preference || !currentMapData)
      return;
    const selection = calibratorPreference.selection;
    if (!selection) return;
    const availableFloor = (id: string) =>
      calibrationFloors(currentMapData, basemap).some((floor) => floor.id === id);
    const selectedFloorId = selection.type === 'map' ? undefined : selection.floorId;
    if (selection.type !== 'map' && (!selectedFloorId || !availableFloor(selectedFloorId))) {
      setSelected(null);
      setDraft(null);
      updateTreeSelection({ type: 'map', mapId: calibratorMapId });
      return;
    }
    if (
      selection.type === 'region' &&
      (!selection.regionId ||
        !activeDoc.regions.some(
          (item) => item.id === selection.regionId && item.floorId === selection.floorId,
        ))
    ) {
      setSelected(null);
      setDraft(null);
      updateTreeSelection({ type: 'floor', mapId: calibratorMapId, floorId: selectedFloorId! });
      return;
    }
    if (selectedFloorId && preference.floorId !== selectedFloorId) {
      workspace.updatePreferenceForData(calibratorMapId, currentMapData, {
        floorId: selectedFloorId,
      });
      return;
    }
    if (selection.type !== 'region' || !selection.regionId) return;
    const region = activeDoc.regions.find((item) => item.id === selection.regionId);
    if (!region) return;
    setSelected(region.id);
    setDraft(structuredClone(region));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- composingName is a ref read for the guards above
  }, [
    calibratorPreference.selection,
    calibratorMapId,
    currentMapData,
    activeDoc,
    basemap,
    floorId,
    preference,
    treeSelection.mapId,
  ]);
  useEffect(() => () => flushSave(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const retryMapLoad = () => {
    setMapLoadError(null);
    setCalibrationLoadError(null);
    setReloadToken((value) => value + 1);
    if (w.error) void w.initialize();
  };
  const resetCalibration = () => {
    setConfirmReset(false);
    void store
      .dispatch(api.endpoints.resetData.initiate('calibration'))
      .unwrap()
      .then(() => window.location.reload())
      .catch((error: unknown) =>
        notices.push(t(errorKeyOf(error, 'errors.data_reset_failed') as LocaleKey)),
      );
  };
  const openDataDirectory = () => {
    void store
      .dispatch(api.endpoints.openDataDirectory.initiate('data'))
      .unwrap()
      .catch(() => notices.push(t('errors.data_directory_open_failed')));
  };
  const calibrationDataError =
    calibrationLoadError || (w.error === 'errors.calibration_preferences_invalid' ? w.error : null);
  if ((w.error || mapLoadError) && !calibrationDataError)
    return (
      <section className="calibrator-page">
        <MapUnavailableState
          errorKey={w.error || mapLoadError || 'errors.request_failed'}
          onRetry={retryMapLoad}
        />
      </section>
    );
  if (calibrationDataError)
    return (
      <>
        <ErrorState
          icon={FileWarning}
          tone="data"
          title={t('calibrator.dataErrorTitle')}
          description={t('calibrator.dataErrorDescription')}
          actions={[
            { label: t('calibrator.openDataDirectory'), onClick: openDataDirectory },
            {
              label: t('calibrator.resetData'),
              onClick: () => setConfirmReset(true),
              danger: true,
            },
          ]}
        />
        <ConfirmDialog
          open={confirmReset}
          title={t('calibrator.resetDataTitle')}
          message={t('calibrator.resetDataConfirm')}
          confirmLabel={t('calibrator.resetDataConfirmButton')}
          danger
          onConfirm={resetCalibration}
          onCancel={() => setConfirmReset(false)}
        />
      </>
    );
  if (!currentMapData || !activeDoc || !preference)
    return (
      <section className="placeholder">
        <p>{t('calibrator.loading')}</p>
      </section>
    );
  return (
    <section ref={pageRef} className={`calibrator-page ${collapsed ? 'tree-collapsed' : ''}`}>
      <aside id="calibrator-tree" className={`calibrator-tree ${collapsed ? 'collapsed' : ''}`}>
        {!collapsed && (
          <div ref={treeContentRef} className="tree-content" onScroll={rememberTreeScroll}>
            {w.catalog.map((map) => {
              const data = mapData.get(map.id);
              const mapBasemap: Basemap = data
                ? (w.preferenceForData(map.id, data).basemap as Basemap)
                : 'tiles';
              const calibration = calibrationData.get(calibrationKey(map.id, mapBasemap)) ?? null;
              return (
                <div
                  key={map.id}
                  className={`tree-map-node ${
                    treeSelection.type === 'map' && treeSelection.mapId === map.id ? 'active' : ''
                  }`}
                >
                  <div className="tree-map-row">
                    <button
                      className="tree-expand-toggle"
                      type="button"
                      aria-expanded={expandedMaps(map.id)}
                      aria-label={
                        expandedMaps(map.id) ? t('calibrator.collapse') : t('calibrator.expand')
                      }
                      title={
                        expandedMaps(map.id) ? t('calibrator.collapse') : t('calibrator.expand')
                      }
                      onClick={() => toggleMap(map.id)}
                    >
                      <ChevronRight className="group-chevron" size={16} aria-hidden="true" />
                    </button>
                    <button
                      className="tree-map-trigger"
                      title={map.name}
                      onClick={() => selectMap(map.id)}
                    >
                      <span className="tree-label">
                        {map.iconUrl && (
                          <span
                            className="map-tree-icon"
                            aria-hidden="true"
                            style={{ maskImage: `url("${map.iconUrl}")` }}
                          />
                        )}
                        <span>{map.name}</span>
                      </span>
                    </button>
                  </div>
                  <button
                    className="tree-basemap-toggle"
                    type="button"
                    aria-label={t('calibrator.toggleBasemap')}
                    title={
                      data?.svgUrl && data.tiles.length
                        ? t('calibrator.toggleBasemap')
                        : t('calibrator.singleBasemap')
                    }
                    disabled={!data?.svgUrl || !data.tiles.length}
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggleBasemapForMap(map.id);
                    }}
                  >
                    {mapBasemap === 'tiles' ? (
                      <Satellite size={16} aria-hidden="true" />
                    ) : (
                      <Shapes size={16} aria-hidden="true" />
                    )}
                  </button>
                  {expandedMaps(map.id) && data && (
                    <div className="tree-map-children">
                      {calibrationFloors(data, mapBasemap).map((floor) => {
                        const floorRegions =
                          calibration?.regions.filter((r) => r.floorId === floor.id) ?? [];
                        return (
                          <div
                            key={floor.id}
                            className={`tree-floor ${
                              treeSelection.type === 'floor' &&
                              treeSelection.mapId === map.id &&
                              treeSelection.floorId === floor.id
                                ? 'active'
                                : ''
                            }`}
                          >
                            <div className="tree-floor-row">
                              <button
                                className="tree-expand-toggle"
                                type="button"
                                aria-expanded={expandedFloors(`${map.id}:${floor.id}`)}
                                aria-label={
                                  expandedFloors(`${map.id}:${floor.id}`)
                                    ? t('calibrator.collapse')
                                    : t('calibrator.expand')
                                }
                                title={
                                  expandedFloors(`${map.id}:${floor.id}`)
                                    ? t('calibrator.collapse')
                                    : t('calibrator.expand')
                                }
                                onClick={() => toggleFloor(`${map.id}:${floor.id}`)}
                              >
                                <ChevronRight
                                  className="group-chevron"
                                  size={16}
                                  aria-hidden="true"
                                />
                              </button>
                              <button
                                ref={(element) => {
                                  const key = `${map.id}:${floor.id}`;
                                  if (element) floorButtonRefs.current.set(key, element);
                                  else floorButtonRefs.current.delete(key);
                                }}
                                className={`tree-floor-trigger ${
                                  treeSelection.type === 'floor' &&
                                  treeSelection.mapId === map.id &&
                                  treeSelection.floorId === floor.id
                                    ? 'active'
                                    : ''
                                }`}
                                onClick={() => selectFloor(map.id, floor.id)}
                              >
                                <span className="tree-label">
                                  <span>{floor.name}</span>
                                </span>
                                <span className="count">{floorRegions.length}</span>
                              </button>
                            </div>
                            {expandedFloors(`${map.id}:${floor.id}`) &&
                              floorRegions.map((region) => (
                                <button
                                  key={region.id}
                                  className={`tree-region ${
                                    treeSelection.type === 'region' &&
                                    treeSelection.mapId === map.id &&
                                    treeSelection.floorId === floor.id &&
                                    treeSelection.regionId === region.id
                                      ? 'active'
                                      : ''
                                  }`}
                                  title={region.name}
                                  onClick={() => selectTreeRegion(map.id, region)}
                                >
                                  <span className="tree-region-name">
                                    {region.coversEntireMap && (
                                      <span
                                        className="tree-full-cover-star"
                                        title={t('calibrator.coversEntireMap')}
                                        aria-label={t('calibrator.coversEntireMap')}
                                      >
                                        <Star size={13} fill="currentColor" aria-hidden="true" />
                                      </span>
                                    )}
                                    <span>{region.name}</span>
                                  </span>
                                  {conflictsByCalibration
                                    .get(calibrationKey(map.id, mapBasemap))
                                    ?.has(region.id) && (
                                    <span
                                      className="tree-warning"
                                      title={t('calibrator.conflictWarning')}
                                    >
                                      <TriangleAlert
                                        size={14}
                                        aria-label={t('calibrator.conflictWarning')}
                                      />
                                    </span>
                                  )}
                                </button>
                              ))}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </aside>
      <div
        className={`calibrator-map ${regions.some((region) => region.coversEntireMap) ? 'full-cover-active' : ''}`}
      >
        {regions.some((region) => region.coversEntireMap) && (
          <>
            <div
              className={`full-cover-edge ${tool === 'edit' || tool === 'resize' ? 'disabled-tool' : ''}`}
              aria-hidden="true"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            />
            <button
              type="button"
              className="full-cover-capsule"
              onClick={() => {
                const region = regions.find((item) => item.coversEntireMap);
                if (region) selectRegion(region);
              }}
            >
              {t('calibrator.fullCoverActive')}
            </button>
          </>
        )}
        <CalibrationViewport
          key={reloadToken}
          data={currentMapData}
          preference={preference}
          regions={regions}
          selectedId={selected}
          tool={tool}
          onCreate={(rectangle) => {
            if (create(rectangle)) setTool('resize');
          }}
          onSelect={(id) => {
            const region = regions.find((item) => item.id === id);
            if (region) selectRegion(region);
            else {
              setSelected(null);
              setDraft(null);
              updateTreeSelection({ type: 'map', mapId: calibratorMapId });
            }
          }}
          onChangeRectangle={(id, rectangle) => {
            if (!rectangleHistory.current && docRef.current) {
              store.dispatch(
                setCalibrationEditorHistory({
                  key: activeCalibrationKey,
                  past: [...past, docRef.current].slice(-50),
                  future: [],
                }),
              );
            }
            rectangleHistory.current = true;
            updateRectangle(id, rectangle);
          }}
          onCommitRectangle={() => {
            rectangleHistory.current = false;
            if (docRef.current) scheduleSave(docRef.current, true);
          }}
          onTool={setTool}
          onCursor={setCursor}
          onMapError={setMapLoadError}
          onReady={(map) => {
            mapRef.current = map;
            const syncZoom = () => {
              if (!mapRef.current) return;
              setZoom({ zoom: map.getZoom(), min: map.getMinZoom(), max: map.getMaxZoom() });
            };
            map.on('zoomend', syncZoom);
            syncZoom();
          }}
        />
        <div className="calibrator-view-controls view-controls">
          <button
            ref={sidebarToggleRef}
            type="button"
            aria-label={collapsed ? t('calibrator.expand') : t('calibrator.collapse')}
            aria-expanded={!collapsed}
            aria-controls="calibrator-tree"
            title={collapsed ? t('calibrator.expand') : t('calibrator.collapse')}
            onClick={() => {
              rememberTreeScroll();
              const next = !collapsed;
              workspace.updateCalibratorPreference({ sidebarCollapsed: next });
              if (next) requestAnimationFrame(() => sidebarToggleRef.current?.focus());
            }}
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
          <div className="zoom-buttons">
            <button
              aria-label={t('map.view.zoomInAria')}
              title={t('map.view.zoomIn')}
              disabled={!!zoom && zoom.zoom >= zoom.max - ZOOM_BOUND_EPSILON}
              onClick={() => mapRef.current?.zoomIn()}
            >
              <Plus size={17} />
            </button>
            <button
              aria-label={t('map.view.zoomOutAria')}
              title={t('map.view.zoomOut')}
              disabled={!!zoom && zoom.zoom <= zoom.min + ZOOM_BOUND_EPSILON}
              onClick={() => mapRef.current?.zoomOut()}
            >
              <Minus size={17} />
            </button>
          </div>
          <button
            className="calibrator-basemap"
            aria-label={t('map.view.layers')}
            title={hasBasemapToggle ? t('calibrator.toggleBasemap') : t('calibrator.singleBasemap')}
            disabled={!hasBasemapToggle}
            onClick={toggleBasemap}
          >
            {basemap === 'tiles' ? (
              <Satellite size={20} aria-hidden="true" />
            ) : (
              <Shapes size={20} aria-hidden="true" />
            )}
          </button>
          <button
            aria-label={isFullscreen ? t('map.view.exitFullscreen') : t('map.view.fullscreen')}
            title={isFullscreen ? t('map.view.exitFullscreen') : t('map.view.fullscreen')}
            onClick={() =>
              void (document.fullscreenElement
                ? document.exitFullscreen()
                : pageRef.current?.requestFullscreen())
            }
          >
            {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
          <button
            aria-label={t('map.view.fit')}
            title={t('map.view.fit')}
            onClick={() => {
              const [x, y, width, height] = currentMapData.projection.viewBox;
              mapRef.current?.fitBounds(
                [
                  [-y - height, x],
                  [-y, x + width],
                ],
                { padding: [48, 48] },
              );
            }}
          >
            <RotateCcw size={16} />
          </button>
        </div>
        <ToolToolbar
          className="calibrator-toolbar"
          ariaLabel={t('calibrator.toolsAria')}
          tools={[
            { id: 'select', icon: MousePointer2, label: t('calibrator.select') },
            { id: 'edit', icon: Hand, label: t('calibrator.edit') },
            { id: 'rect', icon: RectangleHorizontal, label: t('calibrator.rect') },
            {
              id: 'resize',
              icon: Scaling,
              label: t('calibrator.resize'),
            },
          ].map((item) => ({
            ...item,
            active: tool === item.id,
            pressed: tool === item.id,
            onClick: () => setTool(item.id as Tool),
          }))}
          undo={{
            label: t('map.tools.undo'),
            title: t('map.tools.undoTitle'),
            disabled: !past.length,
            onClick: undo,
          }}
          redo={{
            label: t('map.tools.redo'),
            title: t('map.tools.redoTitle'),
            disabled: !future.length,
            onClick: redo,
          }}
        />
        {cursor && (
          <div className={`coordinates ${draft ? 'calibrator-coordinates-with-detail' : ''}`}>
            {`x: ${cursor.x.toFixed(2)} z: ${cursor.z.toFixed(2)}`}
          </div>
        )}
      </div>
      {draft && (
        <aside className="calibrator-detail">
          <div className="panel-title detail-head">
            <strong>{t('calibrator.regionDetails')}</strong>
            <button
              className="icon-button"
              onClick={closeDetails}
              aria-label={t('calibrator.closeDetails')}
            >
              <X size={16} />
            </button>
          </div>
          <div className="detail-content" ref={detailRef}>
            <label className="calibrator-field">
              <span>id</span>
              <span className="readonly-value">{draft.id}</span>
            </label>
            <label className="calibrator-field">
              <span>{t('calibrator.name')}</span>
              <input
                maxLength={64}
                value={draft.name}
                aria-invalid={draftErrors.name ? 'true' : undefined}
                {...nameComposerProps}
                onChange={(e) => {
                  const name = e.target.value;
                  if (composingName.current) {
                    // Keep the DOM value in sync locally so React never writes it back while the
                    // IME holds the composition.
                    setDraft((current) => (current ? { ...current, name } : current));
                  } else {
                    update({ name }, true, recordNameStep());
                  }
                }}
                onBlur={() => {
                  if (!composingName.current) rollbackDraft();
                }}
              />
              <div className="field-meta">
                {draftErrors.name ? (
                  <small className="field-error" role="alert">
                    {draftErrors.name}
                  </small>
                ) : (
                  <span aria-hidden="true" />
                )}
                <small className="field-count">{draft.name.length}/64</small>
              </div>
            </label>
            <fieldset>
              <legend>{t('calibrator.position')}</legend>
              <div className="calibrator-field-row">
                <NumericField
                  label="X"
                  value={draft.rectangle.minX}
                  disabled={draft.coversEntireMap}
                  onChange={(value) => updateRectangleField('x', 'min', value)}
                  onBlur={rollbackDraft}
                />
                <NumericField
                  label="Z"
                  value={draft.rectangle.minZ}
                  disabled={draft.coversEntireMap}
                  onChange={(value) => updateRectangleField('z', 'min', value)}
                  onBlur={rollbackDraft}
                />
                {draftErrors.x || draftErrors.z ? (
                  <small className="field-error row-error" role="alert">
                    {draftErrors.x || draftErrors.z}
                  </small>
                ) : null}
              </div>
              <div className="calibrator-field-row">
                <NumericField
                  label="X"
                  value={draft.rectangle.maxX}
                  disabled={draft.coversEntireMap}
                  onChange={(value) => updateRectangleField('x', 'max', value)}
                  onBlur={rollbackDraft}
                />
                <NumericField
                  label="Z"
                  value={draft.rectangle.maxZ}
                  disabled={draft.coversEntireMap}
                  onChange={(value) => updateRectangleField('z', 'max', value)}
                  onBlur={rollbackDraft}
                />
              </div>
            </fieldset>
            <div className="full-cover-tooltip">
              <label
                className={`check-row full-cover-toggle${
                  !draft.coversEntireMap &&
                  regions.some((region) => region.id !== draft.id && region.coversEntireMap)
                    ? ' is-disabled'
                    : ''
                }`}
                aria-disabled={
                  !draft.coversEntireMap &&
                  regions.some((region) => region.id !== draft.id && region.coversEntireMap)
                }
              >
                <input
                  type="checkbox"
                  checked={draft.coversEntireMap}
                  disabled={
                    !draft.coversEntireMap &&
                    regions.some((region) => region.id !== draft.id && region.coversEntireMap)
                  }
                  onChange={(event) => toggleFullCover(event.currentTarget.checked)}
                />
                <span>{t('calibrator.coversEntireMap')}</span>
              </label>
              <HintTooltip
                boundaryRef={detailRef}
                content={
                  !draft.coversEntireMap &&
                  regions.some((region) => region.id !== draft.id && region.coversEntireMap)
                    ? t('calibrator.fullCoverExists')
                    : t('calibrator.coversEntireMapHint')
                }
              />
            </div>
            <fieldset>
              <legend>{t('calibrator.height')}</legend>
              <div className="calibrator-field-row">
                <NumericField
                  label={t('calibrator.minimum')}
                  value={draft.yRange.min}
                  onChange={(value) => update({ yRange: { ...draft.yRange, min: value } })}
                  onBlur={rollbackDraft}
                />
                <NumericField
                  label={t('calibrator.maximum')}
                  value={draft.yRange.max}
                  onChange={(value) => update({ yRange: { ...draft.yRange, max: value } })}
                  onBlur={rollbackDraft}
                />
                {draftErrors.y ? (
                  <small className="field-error row-error" role="alert">
                    {draftErrors.y}
                  </small>
                ) : null}
              </div>
            </fieldset>
            <div className="priority-field">
              <div className="priority-head">
                <span>{t('calibrator.priority')}</span>
                <HintTooltip boundaryRef={detailRef} content={t('calibrator.priorityHelp')} />
              </div>
              <NumberStepper
                label={t('calibrator.priority')}
                value={draft.priority}
                limit={CalibrationRegionLimits.priority}
                deferInput
                onChange={(value) => update({ priority: value })}
                onBlur={rollbackDraft}
              />
              {draftErrors.priority ? (
                <small className="field-error priority-error" role="alert">
                  {draftErrors.priority}
                </small>
              ) : null}
            </div>
            {draft && conflictIds?.has(draft.id) && (
              <p className="conflict-warning">
                <TriangleAlert size={14} />
                {t('calibrator.conflictWarning')}
              </p>
            )}
            <div className="detail-actions">
              <button className="danger-button" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={15} />
                {t('calibrator.delete')}
              </button>
            </div>
          </div>
        </aside>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title={t('calibrator.deleteTitle')}
        message={t('calibrator.deleteConfirm', { name: draft?.name || '' })}
        danger
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}
