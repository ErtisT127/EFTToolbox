import { useSelector } from 'react-redux';
import type {
  Annotation,
  CalibratorPreferences,
  MapData,
  MapPreference,
  MapSummary,
  Preferences,
  Sticker,
  UserSettings,
} from '../../../contracts/ts/ipc.gen';
import { ContractSchemaVersion } from '../../../contracts/ts/ipc.gen.ts';
import {
  calibratorPreferences as defaultCalibratorPreferencesValue,
  defaultGroups,
} from '../defaults.gen.ts';
import { api, isRevisionConflict } from './api.ts';
import { errorKeyOf } from '../lib/errors.ts';
import { selectableFloors } from '../pages/map/lib/floors.ts';
import { store, type RootState, waitForAnnotationSaves } from './store.ts';
import {
  clearAnnotationDraft,
  clearAnnotationSessions,
  commitAnnotations,
  ensureAnnotationSession,
  redoAnnotations,
  resetAnnotationSession,
  setAnnotationSaveState,
  setCalibrationPreferencesDraft,
  submitMapPreferences,
  submitCalibrationPreferences,
  setMapPreferencesDraft,
  setWorkspaceState,
  undoAnnotations,
  submitAnnotations,
  clearConflict,
} from './clientState.ts';
class DataLoadError extends Error {
  readonly errorKey: string;
  readonly module = 'map' as const;

  constructor(errorKey: string, _module?: 'map') {
    super(errorKey);
    this.name = 'DataLoadError';
    this.errorKey = errorKey;
  }
}

export { selectableFloors } from '../pages/map/lib/floors.ts';

// The UI language, applied at boot from user settings; map data requests follow it so map and
// marker names render in the same language as the interface.
let locale = 'zh-CN';

export function setLocale(next: string) {
  locale = next;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'number');
const isRecordArray = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.every(isRecord);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const hasStrings = (value: Record<string, unknown>, ...keys: string[]) =>
  keys.every((key) => typeof value[key] === 'string');

export function isUsableMapCatalog(value: unknown): value is MapSummary[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) && hasStrings(item, 'id', 'name', 'subtitle', 'defaultFloor', 'iconUrl'),
    )
  );
}

export function isUsableMapData(value: unknown): value is MapData {
  if (!isRecord(value) || value.schemaVersion !== ContractSchemaVersion) return false;
  if (!isRecord(value.projection) || !isRecord(value.clock)) return false;
  if (
    !isRecordArray(value.floors) ||
    !isRecordArray(value.categories) ||
    !isRecordArray(value.markers) ||
    !isRecordArray(value.tasks) ||
    !isStringArray(value.warnings) ||
    !isRecordArray(value.tiles) ||
    !isRecordArray(value.projection.bounds) ||
    !isNumberArray(value.projection.viewBox) ||
    !isRecordArray(value.clock.phases) ||
    !isNumberArray(value.clock.offsets) ||
    !isStringArray(value.clock.fixed)
  )
    return false;
  if (
    typeof value.defaultFloor !== 'string' ||
    typeof value.baseFloor !== 'string' ||
    value.projection.bounds.length !== 2 ||
    value.projection.viewBox.length !== 4 ||
    !value.projection.bounds.every((point) => isFiniteNumber(point.x) && isFiniteNumber(point.z)) ||
    !value.projection.viewBox.every(isFiniteNumber) ||
    !value.floors.some((floor) => floor.id === value.defaultFloor) ||
    !value.floors.some((floor) => floor.id === value.baseFloor)
  )
    return false;
  if (typeof value.svgUrl !== 'string' || (!value.svgUrl && value.tiles.length === 0)) return false;
  if (
    !value.floors.every(
      (floor) => hasStrings(floor, 'id', 'name') && isStringArray(floor.svgGroups),
    ) ||
    !value.categories.every((category) =>
      hasStrings(category, 'id', 'name', 'groupId', 'symbol', 'iconUrl'),
    ) ||
    !value.tasks.every((task) => hasStrings(task, 'id', 'name'))
  )
    return false;
  const categoryIds = new Set(value.categories.map((category) => category.id));
  if (
    !value.markers.every(
      (marker) =>
        hasStrings(marker, 'id', 'name', 'categoryId', 'iconUrl') &&
        categoryIds.has(marker.categoryId) &&
        isStringArray(marker.categoryIds) &&
        isStringArray(marker.floorIds) &&
        isRecordArray(marker.outline),
    )
  )
    return false;
  return value.tiles.every((tile) => isNumberArray(tile.transform) && isRecordArray(tile.bounds));
}

function defaultCalibratorPreferences(mapId = ''): CalibratorPreferences {
  return {
    ...defaultCalibratorPreferencesValue,
    collapsedMaps: [...defaultCalibratorPreferencesValue.collapsedMaps],
    collapsedFloors: [...defaultCalibratorPreferencesValue.collapsedFloors],
    ...(mapId ? { selection: { type: 'map', mapId } } : {}),
  };
}

function defaultPreferences(): Preferences {
  return { schemaVersion: ContractSchemaVersion, selectedMap: '', maps: [], stickerUsage: [] };
}

export function reportClientLog(event: string, message: string, error = '') {
  void fetch('/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      level: 'error',
      component: 'dashboard',
      event,
      message,
      error,
    }),
  }).catch(() => {});
}

// Polling and hint-list requests fail silently on purpose, but a first failure is still worth one
// record. Repeats of the same failure stay silent until it changes or the cooldown elapses, so a
// broken endpoint cannot flood the log.
const reportedFailures = new Map<string, { key: string; at: number }>();

export function reportThrottledFailure(event: string, detail: string, cooldownMs = 5 * 60_000) {
  const now = Date.now();
  const previous = reportedFailures.get(event) ?? null;
  // Same rule the notice host uses: a new failure reports at once, a repeat waits for the cooldown.
  // Kept local so this module stays loadable by the Node-based map tests.
  if (previous && previous.key === detail && now - previous.at < cooldownMs) return;
  reportedFailures.set(event, { key: detail, at: now });
  reportClientLog('http_request_failed', event, detail);
}

export function loadUserSettings() {
  return store
    .dispatch(api.endpoints.getUserSettings.initiate(undefined, { forceRefetch: true }))
    .unwrap()
    .then(({ value }) => value);
}

export function updateUserSettings(update: (value: UserSettings) => UserSettings) {
  return loadUserSettings().then(async (current) => {
    const cached = api.endpoints.getUserSettings.select()(store.getState()).data;
    if (!cached) throw new Error('errors.request_failed');
    try {
      const result = await store
        .dispatch(
          api.endpoints.updateUserSettings.initiate({
            value: update(current),
            revision: cached.revision,
            etag: cached.etag,
          }),
        )
        .unwrap();
      store.dispatch(api.util.updateQueryData('getUserSettings', undefined, () => result));
      return result.value;
    } catch (error) {
      if (isRevisionConflict(error)) throw new Error('errors.revision_conflict', { cause: error });
      throw error;
    }
  });
}

export async function resetUserSettings() {
  const { value } = await store.dispatch(api.endpoints.resetUserSettings.initiate()).unwrap();
  return value;
}

export type Session = {
  data: MapData;
  items: Annotation[];
  draft?: Annotation[];
  past: Annotation[][];
  future: Annotation[][];
  revision: number;
  savedRevision: number;
  saving: boolean;
  error: string;
  /** A remote markers update landed while this session had unsaved edits; refetch once clean. */
  pendingSync: boolean;
  conflict: boolean;
};

export class Workspace {
  get sessions() {
    const state = store.getState();
    const clientSessions = state.client.annotations.sessions;
    const sessions = new Map<string, Session>();
    for (const id of Object.keys(clientSessions)) {
      const data = api.endpoints.getMap.select({ id, locale })(state)?.data;
      const annotations = api.endpoints.getAnnotations.select(id)(state).data?.value;
      if (!data || !annotations) continue;
      const local = clientSessions[id];
      const draft = local.draft;
      sessions.set(id, {
        data,
        items: draft || annotations.items,
        draft,
        past: local.past,
        future: local.future,
        revision: local.editRevision,
        savedRevision: local.savedRevision,
        saving: local.saving,
        error: local.error,
        pendingSync: local.pendingSync,
        conflict: local.conflict,
      });
    }
    return sessions;
  }
  get catalog(): MapSummary[] {
    return api.endpoints.getMapCatalog.select(locale)(store.getState()).data || [];
  }
  get stickers(): Sticker[] {
    return api.endpoints.getStickers.select()(store.getState()).data || [];
  }
  get preferences(): Preferences {
    const state = store.getState();
    return (
      state.client.mapPreferencesDraft ||
      api.endpoints.getMapPreferences.select()(state).data?.value ||
      defaultPreferences()
    );
  }
  get calibratorPreferences(): CalibratorPreferences {
    const state = store.getState();
    return (
      state.client.calibrationPreferencesDraft ||
      api.endpoints.getCalibrationPreferences.select()(state).data?.value ||
      defaultCalibratorPreferences()
    );
  }
  get activeId() {
    return store.getState().client.annotations.activeId;
  }
  get loading() {
    return store.getState().client.annotations.loading;
  }
  get error() {
    return store.getState().client.annotations.error;
  }
  get preferenceError() {
    return store.getState().client.annotations.preferenceError;
  }
  get calibratorPreferenceError() {
    return store.getState().client.annotations.calibratorPreferenceError;
  }
  get savingPreferences() {
    return store.getState().client.annotations.savingPreferences;
  }
  get savingCalibratorPreferences() {
    return store.getState().client.annotations.savingCalibratorPreferences;
  }
  private sequence = 0;
  private pendingSelection = '';

  async initialize() {
    const sequence = ++this.sequence;
    store.dispatch(setWorkspaceState({ loading: true, error: '' }));
    try {
      const [catalog, preferenceResult, stickers, calibratorResult] = await Promise.all([
        store
          .dispatch(api.endpoints.getMapCatalog.initiate(locale, { forceRefetch: true }))
          .unwrap(),
        store
          .dispatch(api.endpoints.getMapPreferences.initiate(undefined, { forceRefetch: true }))
          .unwrap(),
        store
          .dispatch(api.endpoints.getStickers.initiate(undefined, { forceRefetch: true }))
          .unwrap(),
        store
          .dispatch(
            api.endpoints.getCalibrationPreferences.initiate(undefined, { forceRefetch: true }),
          )
          .unwrap(),
      ]);
      const preferences = preferenceResult.value;
      const calibratorPreferences = calibratorResult.value;
      if (sequence !== this.sequence) return;
      if (
        !isUsableMapCatalog(catalog) ||
        !Array.isArray(stickers) ||
        preferences.schemaVersion !== ContractSchemaVersion ||
        !Array.isArray(preferences.maps) ||
        calibratorPreferences.schemaVersion !== ContractSchemaVersion
      )
        throw new DataLoadError('errors.data_version', 'map');
      // A manual tab click can be ahead of the debounced preference PUT. Keep that local intent
      // ahead of the last persisted selection when a reload overlaps the click.
      const draftSelectedMap = store.getState().client.mapPreferencesDraft?.selectedMap;
      const preferredMapId = [
        this.pendingSelection,
        draftSelectedMap,
        preferences.selectedMap,
      ].find((value) => value && catalog.some((map) => map.id === value));
      const id = preferredMapId || catalog[0]?.id;
      const normalizedCalibratorPreferences = this.normalizeCalibratorPreferences(id || '');
      if (normalizedCalibratorPreferences !== calibratorPreferences)
        this.setCalibratorPreferencesDraft(normalizedCalibratorPreferences);
      if (id) await this.select(id, true);
      else {
        store.dispatch(setWorkspaceState({ loading: false }));
      }
    } catch (error) {
      if (sequence === this.sequence) {
        store.dispatch(
          setWorkspaceState({ error: errorKeyOf(error, 'errors.request_failed'), loading: false }),
        );
      }
    }
  }

  get calibratorPreference(): CalibratorPreferences {
    return this.normalizeCalibratorPreferences(this.calibratorPreferences.selection?.mapId || '');
  }

  private normalizeCalibratorPreferences(mapId: string) {
    const source = this.calibratorPreferences;
    const needsDraft =
      source.schemaVersion !== ContractSchemaVersion ||
      !Array.isArray(source.collapsedMaps) ||
      !Array.isArray(source.collapsedFloors) ||
      (!source.selection && !!mapId);
    const normalized = needsDraft
      ? source.schemaVersion !== ContractSchemaVersion
        ? defaultCalibratorPreferences(mapId)
        : structuredClone(source)
      : source;
    if (!Array.isArray(normalized.collapsedMaps)) normalized.collapsedMaps = [];
    if (!Array.isArray(normalized.collapsedFloors)) normalized.collapsedFloors = [];
    if (!normalized.selection && mapId) normalized.selection = { type: 'map', mapId };
    return normalized;
  }

  private setPreferencesDraft(value: Preferences | undefined) {
    store.dispatch(setMapPreferencesDraft(value));
  }

  private setCalibratorPreferencesDraft(value: CalibratorPreferences | undefined) {
    store.dispatch(setCalibrationPreferencesDraft(value));
  }

  async reloadForResources() {
    // The active backend data root may have changed with the game mode. Re-fetch the selected map
    // while retaining its annotation history and unsaved edits in the existing session object.
    await this.initialize();
  }

  async waitForSaves() {
    await waitForAnnotationSaves();
  }

  async reloadAfterAnnotationReset() {
    store.dispatch(clearAnnotationSessions());
    await this.initialize();
  }

  async select(id: string, reload = false) {
    const sequence = ++this.sequence;
    this.pendingSelection = id;
    store.dispatch(setWorkspaceState({ error: '', loading: true }));
    try {
      if (reload) {
        const catalog = await store
          .dispatch(api.endpoints.getMapCatalog.initiate(locale, { forceRefetch: true }))
          .unwrap();
        if (sequence !== this.sequence) return;
        if (!isUsableMapCatalog(catalog)) throw new DataLoadError('errors.data_version', 'map');
      }
      if (!this.sessions.has(id) || reload) {
        const [data, annotationsResult] = await Promise.all([
          store
            .dispatch(api.endpoints.getMap.initiate({ id, locale }, { forceRefetch: reload }))
            .unwrap(),
          store
            .dispatch(api.endpoints.getAnnotations.initiate(id, { forceRefetch: reload }))
            .unwrap(),
        ]);
        const annotations = annotationsResult.value;
        if (sequence !== this.sequence) return;
        const mapDataValid = isUsableMapData(data);
        if (
          !mapDataValid ||
          annotations.schemaVersion !== ContractSchemaVersion ||
          !Array.isArray(annotations.items)
        )
          throw new DataLoadError(
            mapDataValid ? 'errors.annotations_invalid' : 'errors.map_data_invalid',
            'map',
          );
        store.dispatch(ensureAnnotationSession(id));
      }
      if (sequence !== this.sequence) return;
      const preferences = structuredClone(this.preferences);
      preferences.selectedMap = id;
      this.normalizePreference(preferences, id, this.sessions.get(id)!.data);
      this.setPreferencesDraft(preferences);
      store.dispatch(setWorkspaceState({ activeId: id }));
      if (this.pendingSelection === id) this.pendingSelection = '';
    } catch (error) {
      if (sequence === this.sequence) {
        if (this.pendingSelection === id) this.pendingSelection = '';
        store.dispatch(setWorkspaceState({ error: errorKeyOf(error, 'errors.request_failed') }));
      }
    } finally {
      if (sequence === this.sequence) {
        store.dispatch(setWorkspaceState({ loading: false }));
      }
    }
  }

  preferenceFor(id: string): MapPreference {
    return this.preferenceForData(id, this.sessions.get(id)!.data);
  }

  preferenceForData(id: string, data: MapData): MapPreference {
    return this.normalizePreference(structuredClone(this.preferences), id, data);
  }

  private normalizePreference(preferences: Preferences, id: string, data: MapData): MapPreference {
    let preference = preferences.maps.find((p) => p.mapId === id);
    if (!preference) {
      preference = {
        mapId: id,
        basemap: data.svgUrl ? 'svg' : 'tiles',
        floorId: data.defaultFloor,
        hiddenCategories: data.categories
          .filter((c) => !defaultGroups.includes(c.groupId))
          .map((c) => c.id),
        collapsedGroups: [],
        showAnnotations: true,
        selectedTasks: [],
        taskFilterActive: false,
        center: [],
        zoom: 0,
      };
      preferences.maps.push(preference);
    }
    if (!Array.isArray(preference.hiddenCategories)) preference.hiddenCategories = [];
    if (!Array.isArray(preference.collapsedGroups)) preference.collapsedGroups = [];
    if (!Array.isArray(preference.selectedTasks)) preference.selectedTasks = [];
    if (!Array.isArray(preference.center)) preference.center = [];
    if (preference.basemap !== 'svg' && preference.basemap !== 'tiles') {
      preference.basemap = data.svgUrl ? 'svg' : 'tiles';
      preference.center = [];
    }
    if (!data.svgUrl) preference.basemap = 'tiles';
    if (!data.tiles.length) preference.basemap = 'svg';
    if (!data.floors.some((f) => f.id === preference.floorId))
      preference.floorId = data.defaultFloor;
    if (
      preference.floorId !== data.baseFloor &&
      !selectableFloors(data, preference.basemap).some((f) => f.id === preference.floorId)
    )
      preference.floorId = data.baseFloor;
    if (
      preference.taskFilterActive === undefined ||
      (!preference.taskFilterActive && preference.selectedTasks.length > 0)
    )
      preference.taskFilterActive = preference.selectedTasks.length > 0;
    return preference;
  }

  updatePreference(id: string, changes: Partial<MapPreference>) {
    const data = this.sessions.get(id)!.data;
    const preferences = structuredClone(this.preferences);
    const preference = this.normalizePreference(preferences, id, data);
    Object.assign(preference, changes);
    this.setPreferencesDraft(preferences);
  }
  updatePreferenceForData(id: string, data: MapData, changes: Partial<MapPreference>) {
    const preferences = structuredClone(this.preferences);
    const preference = this.normalizePreference(preferences, id, data);
    Object.assign(preference, changes);
    this.setPreferencesDraft(preferences);
  }
  updateCalibratorPreference(changes: Partial<CalibratorPreferences>) {
    const value = structuredClone(this.calibratorPreference);
    Object.assign(value, changes);
    this.setCalibratorPreferencesDraft(value);
  }
  // Stickers are map-independent, so usage lives on the global preferences. The picker sorts by
  // count, which is why this is a tally rather than a most-recently-used list.
  recordSticker(stickerId: string) {
    const preferences = structuredClone(this.preferences);
    const entry = preferences.stickerUsage.find((u) => u.id === stickerId);
    if (entry) entry.count++;
    else preferences.stickerUsage.push({ id: stickerId, count: 1 });
    this.setPreferencesDraft(preferences);
  }
  // Every entry the user has used, most-used first. A usage id is either a catalogue sticker or a
  // built-in glyph, and only the picker knows which, so this stays a plain tally and the callers
  // resolve and drop whatever no longer exists.
  recentStickers() {
    return [...this.preferences.stickerUsage]
      .filter((u) => u.count > 0)
      .sort((a, b) => b.count - a.count);
  }
  async savePreferences() {
    store.dispatch(submitMapPreferences());
  }
  async saveCalibratorPreferences() {
    store.dispatch(submitCalibrationPreferences());
  }

  commit(id: string, items: Annotation[]) {
    const s = this.sessions.get(id)!;
    if (JSON.stringify(items) === JSON.stringify(s.items)) return;
    store.dispatch(commitAnnotations({ id, base: s.items, items }));
  }
  undo(id: string) {
    const s = this.sessions.get(id)!;
    if (!s.past.length) return;
    store.dispatch(undoAnnotations({ id, current: s.items }));
  }
  redo(id: string) {
    const s = this.sessions.get(id)!;
    if (!s.future.length) return;
    store.dispatch(redoAnnotations({ id, current: s.items }));
  }
  save(id: string) {
    store.dispatch(submitAnnotations({ id }));
    return Promise.resolve();
  }
  async retryAnnotations(id: string) {
    const session = this.sessions.get(id);
    if (!session?.conflict) return this.save(id);
    try {
      await store
        .dispatch(api.endpoints.getAnnotations.initiate(id, { forceRefetch: true }))
        .unwrap();
      store.dispatch(setAnnotationSaveState({ id, changes: { conflict: false, error: '' } }));
      store.dispatch(clearConflict(`annotations:${id}`));
      store.dispatch(submitAnnotations({ id, explicit: true }));
    } catch {
      return;
    }
  }
  /** Teammates' marker updates land in the shared file; pick them up once this session is clean. */
  async refetchAnnotations(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.revision !== s.savedRevision || s.saving) {
      store.dispatch(setAnnotationSaveState({ id, changes: { pendingSync: true } }));
      return;
    }
    const previousItems = s.items;
    try {
      const result = await store
        .dispatch(api.endpoints.getAnnotations.initiate(id, { forceRefetch: true }))
        .unwrap();
      const annotations = result.value;
      const current = this.sessions.get(id);
      if (!current) return;
      // A local edit may have raced the fetch; it wins and the refetch is retried after it saves.
      if (current.revision !== current.savedRevision || current.saving) {
        store.dispatch(setAnnotationSaveState({ id, changes: { pendingSync: true } }));
        return;
      }
      if (annotations.schemaVersion !== ContractSchemaVersion || !Array.isArray(annotations.items))
        return;
      if (JSON.stringify(previousItems) === JSON.stringify(annotations.items))
        store.dispatch(clearAnnotationDraft(id));
      else store.dispatch(resetAnnotationSession(id));
    } catch {
      // Keep the local state; the next remote change retries.
    }
  }
  get unsaved() {
    return (
      [...this.sessions.values()].some((s) => s.revision !== s.savedRevision) ||
      !!store.getState().client.mapPreferencesDraft ||
      !!store.getState().client.calibrationPreferencesDraft
    );
  }
}

export const workspace = new Workspace();

export function useWorkspace(workspace: Workspace) {
  useSelector((state: RootState) => state.client.annotations.activeId);
  useSelector((state: RootState) => state.client.annotations.loading);
  useSelector((state: RootState) => state.client.annotations.error);
  useSelector((state: RootState) => state.client.annotations.preferenceError);
  useSelector((state: RootState) => state.client.annotations.calibratorPreferenceError);
  useSelector((state: RootState) => state.client.annotations.savingPreferences);
  useSelector((state: RootState) => state.client.annotations.savingCalibratorPreferences);
  useSelector(
    (state: RootState) => state.client.annotations.sessions[state.client.annotations.activeId],
  );
  // The drafts are the truth while an edit waits for its debounced save: the preferences the pages
  // read (floors, categories, owner lists) come from the draft, so without subscribing to it the UI
  // keeps the old value until the save round-trips.
  useSelector((state: RootState) => state.client.mapPreferencesDraft);
  useSelector((state: RootState) => state.client.calibrationPreferencesDraft);
  // Every other getter this hook exposes reads a query cache. This store has no change channel of
  // its own, so the caches the pages render from have to be subscribed here or they only appear on
  // a later render.
  useSelector(api.endpoints.getMapCatalog.select(locale));
  useSelector(api.endpoints.getStickers.select());
  useSelector(
    (state: RootState) =>
      api.endpoints.getMap.select({ id: state.client.annotations.activeId, locale })(state).data,
  );
  useSelector(
    (state: RootState) =>
      api.endpoints.getAnnotations.select(state.client.annotations.activeId)(state).data?.value,
  );
  return workspace;
}
