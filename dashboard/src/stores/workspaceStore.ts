import { useSyncExternalStore } from 'react';
import type {
  Annotation,
  Annotations,
  CalibratorPreferences,
  MapData,
  MapPreference,
  MapSummary,
  Preferences,
  Sticker,
  UserSettings,
} from '../../../contracts/ts/ipc.gen';
class DataLoadError extends Error {
  readonly errorKey: string;
  readonly module = 'map' as const;

  constructor(errorKey: string, _module?: 'map') {
    super(errorKey);
    this.name = 'DataLoadError';
    this.errorKey = errorKey;
  }
}

export function selectableFloors(data: MapData, basemap: string) {
  return data.floors.filter(
    (floor) =>
      floor.id !== data.baseFloor &&
      (basemap === 'tiles'
        ? data.tiles.some((tile) => tile.floorId === floor.id) || floor.svgGroups.length > 0
        : floor.svgGroups.length > 0),
  );
}

// The UI language, applied at boot from user settings; map data requests follow it so map and
// marker names render in the same language as the interface.
let locale = 'zh-CN';

export function setLocale(next: string) {
  locale = next;
}

const defaultGroups = ['extracts', 'landmarks'];

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
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
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
    schemaVersion: 1,
    sidebarCollapsed: false,
    collapsedMaps: [],
    collapsedFloors: [],
    ...(mapId ? { selection: { type: 'map', mapId } } : {}),
  };
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

async function failure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: string };
    if (body.code) return body.code.startsWith('errors.') ? body.code : `errors.${body.code}`;
  } catch {
    // Not a JSON error body; fall through to the generic key.
  }
  return 'errors.request_failed';
}

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      reportClientLog(
        'http_request_failed',
        `request failed: ${url}`,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw new Error('errors.request_failed', { cause: error });
  }
  if (!response.ok) {
    const message = await failure(response);
    reportClientLog('http_request_failed', `${response.status} ${url}`, message);
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

let userSettingsCache: UserSettings | undefined;
let userSettingsLoad: Promise<UserSettings> | undefined;
let userSettingsWrite = Promise.resolve();

export function loadUserSettings() {
  if (userSettingsCache) return Promise.resolve(userSettingsCache);
  userSettingsLoad ??= request<UserSettings>('/api/user-settings')
    .then((value) => {
      userSettingsCache = value;
      return value;
    })
    .finally(() => {
      userSettingsLoad = undefined;
    });
  return userSettingsLoad;
}

export function updateUserSettings(update: (value: UserSettings) => UserSettings) {
  const next = userSettingsWrite.then(async () => {
    const current = await loadUserSettings();
    const saved = await request<UserSettings>('/api/user-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update(current)),
    });
    userSettingsCache = saved;
    return saved;
  });
  userSettingsWrite = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function patchUserSettingsCache(update: (value: UserSettings) => UserSettings) {
  if (userSettingsCache) userSettingsCache = update(userSettingsCache);
}

export async function resetUserSettings() {
  const value = await request<UserSettings>('/api/data/reset-user-settings', { method: 'POST' });
  userSettingsCache = value;
  return value;
}

const put = (data: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

export type Session = {
  data: MapData;
  items: Annotation[];
  past: Annotation[][];
  future: Annotation[][];
  revision: number;
  savedRevision: number;
  saving: boolean;
  error: string;
  /** A remote markers update landed while this session had unsaved edits; refetch once clean. */
  pendingSync: boolean;
};

export class Workspace {
  catalog: MapSummary[] = [];
  stickers: Sticker[] = [];
  sessions = new Map<string, Session>();
  preferences: Preferences = { schemaVersion: 1, selectedMap: '', maps: [], stickerUsage: [] };
  calibratorPreferences: CalibratorPreferences = defaultCalibratorPreferences();
  activeId = '';
  loading = true;
  error = '';
  preferenceError = '';
  calibratorPreferenceError = '';
  savingPreferences = false;
  savingCalibratorPreferences = false;
  private version = 0;
  private listeners = new Set<() => void>();
  private sequence = 0;
  private controller?: AbortController;
  private preferenceTimer?: ReturnType<typeof setTimeout>;
  private preferenceRevision = 0;
  private preferenceSaved = 0;
  private calibratorPreferenceTimer?: ReturnType<typeof setTimeout>;
  private calibratorPreferenceRevision = 0;
  private calibratorPreferenceSaved = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  changed() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }

  async initialize() {
    const sequence = ++this.sequence;
    this.controller?.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.loading = true;
    this.error = '';
    this.changed();
    try {
      const [catalog, preferences, stickers, calibratorPreferences] = await Promise.all([
        request<MapSummary[]>(`/api/maps?locale=${locale}`, { signal }),
        request<Preferences>('/api/map-preferences', { signal }),
        request<Sticker[]>('/api/stickers', { signal }),
        request<CalibratorPreferences>('/api/calibration-preferences', { signal }),
      ]);
      if (sequence !== this.sequence) return;
      if (
        !isUsableMapCatalog(catalog) ||
        !Array.isArray(stickers) ||
        preferences.schemaVersion !== 1 ||
        !Array.isArray(preferences.maps) ||
        calibratorPreferences.schemaVersion !== 1
      )
        throw new DataLoadError('errors.data_version', 'map');
      this.catalog = catalog;
      this.stickers = stickers;
      // A preferences file written before stickers existed has no usage list, and Go marshals the
      // absent slice back as null rather than an empty array.
      if (!Array.isArray(preferences.stickerUsage)) preferences.stickerUsage = [];
      for (const preference of preferences.maps) {
        if (!Array.isArray(preference.hiddenCategories)) preference.hiddenCategories = [];
        if (!Array.isArray(preference.collapsedGroups)) preference.collapsedGroups = [];
        if (!Array.isArray(preference.selectedTasks)) preference.selectedTasks = [];
        if (!Array.isArray(preference.center)) preference.center = [];
      }
      this.preferences = preferences;
      this.calibratorPreferences = calibratorPreferences;
      const id = catalog.find((m) => m.id === preferences.selectedMap)?.id || catalog[0]?.id;
      this.normalizeCalibratorPreferences(id || '');
      if (id) await this.select(id, true);
      else {
        this.loading = false;
        this.changed();
      }
    } catch (error) {
      if (sequence === this.sequence) {
        this.error = error instanceof Error ? error.message : 'errors.request_failed';
        this.loading = false;
        this.changed();
      }
    }
  }

  get calibratorPreference(): CalibratorPreferences {
    return this.normalizeCalibratorPreferences(this.calibratorPreferences.selection?.mapId || '');
  }

  private normalizeCalibratorPreferences(mapId: string) {
    const value = this.calibratorPreferences;
    if (value.schemaVersion !== 1) this.calibratorPreferences = defaultCalibratorPreferences(mapId);
    const normalized = this.calibratorPreferences;
    if (!Array.isArray(normalized.collapsedMaps)) normalized.collapsedMaps = [];
    if (!Array.isArray(normalized.collapsedFloors)) normalized.collapsedFloors = [];
    if (!normalized.selection && mapId) normalized.selection = { type: 'map', mapId };
    return normalized;
  }

  async reloadForResources() {
    // The active backend data root may have changed with the game mode. Re-fetch the selected map
    // while retaining its annotation history and unsaved edits in the existing session object.
    await this.initialize();
  }

  async select(id: string, reload = false) {
    const sequence = ++this.sequence;
    this.controller?.abort();
    this.controller = new AbortController();
    this.activeId = id;
    this.error = '';
    this.loading = true;
    this.changed();
    try {
      if (reload) {
        const catalog = await request<MapSummary[]>(`/api/maps?locale=${locale}`, {
          signal: this.controller.signal,
        });
        if (sequence !== this.sequence) return;
        if (!isUsableMapCatalog(catalog)) throw new DataLoadError('errors.data_version', 'map');
        this.catalog = catalog;
      }
      if (!this.sessions.has(id) || reload) {
        const [data, annotations] = await Promise.all([
          request<MapData>(`/api/maps/${id}?locale=${locale}`, { signal: this.controller.signal }),
          request<Annotations>(`/api/maps/${id}/annotations`, { signal: this.controller.signal }),
        ]);
        if (sequence !== this.sequence) return;
        const mapDataValid = isUsableMapData(data);
        if (!mapDataValid || annotations.schemaVersion !== 1 || !Array.isArray(annotations.items))
          throw new DataLoadError(
            mapDataValid ? 'errors.annotations_invalid' : 'errors.map_data_invalid',
            'map',
          );
        const previous = this.sessions.get(id);
        if (previous) previous.data = data;
        else
          this.sessions.set(id, {
            data,
            items: annotations.items,
            past: [],
            future: [],
            revision: 0,
            savedRevision: 0,
            saving: false,
            error: '',
            pendingSync: false,
          });
      }
      if (sequence !== this.sequence) return;
      this.preferences.selectedMap = id;
      this.preferenceFor(id);
      this.savePreferenceSoon();
    } catch (error) {
      if (sequence === this.sequence)
        this.error = error instanceof Error ? error.message : 'errors.request_failed';
    } finally {
      if (sequence === this.sequence) {
        this.loading = false;
        this.changed();
      }
    }
  }

  preferenceFor(id: string): MapPreference {
    return this.preferenceForData(id, this.sessions.get(id)!.data);
  }

  preferenceForData(id: string, data: MapData): MapPreference {
    let preference = this.preferences.maps.find((p) => p.mapId === id);
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
      this.preferences.maps.push(preference);
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
    Object.assign(this.preferenceFor(id), changes);
    this.savePreferenceSoon();
    this.changed();
  }
  updatePreferenceForData(id: string, data: MapData, changes: Partial<MapPreference>) {
    Object.assign(this.preferenceForData(id, data), changes);
    this.savePreferenceSoon();
    this.changed();
  }
  updateCalibratorPreference(changes: Partial<CalibratorPreferences>) {
    Object.assign(this.calibratorPreference, changes);
    this.saveCalibratorPreferenceSoon();
    this.changed();
  }
  // Stickers are map-independent, so usage lives on the global preferences. The picker sorts by
  // count, which is why this is a tally rather than a most-recently-used list.
  recordSticker(stickerId: string) {
    const entry = this.preferences.stickerUsage.find((u) => u.id === stickerId);
    if (entry) entry.count++;
    else this.preferences.stickerUsage.push({ id: stickerId, count: 1 });
    this.savePreferenceSoon();
    this.changed();
  }
  // Every entry the user has used, most-used first. A usage id is either a catalogue sticker or a
  // built-in glyph, and only the picker knows which, so this stays a plain tally and the callers
  // resolve and drop whatever no longer exists.
  recentStickers() {
    return [...this.preferences.stickerUsage]
      .filter((u) => u.count > 0)
      .sort((a, b) => b.count - a.count);
  }
  private savePreferenceSoon() {
    this.preferenceRevision++;
    clearTimeout(this.preferenceTimer);
    this.preferenceTimer = setTimeout(() => {
      void this.savePreferences();
    }, 350);
  }
  private saveCalibratorPreferenceSoon() {
    this.calibratorPreferenceRevision++;
    clearTimeout(this.calibratorPreferenceTimer);
    this.calibratorPreferenceTimer = setTimeout(() => {
      void this.saveCalibratorPreferences();
    }, 350);
  }
  async savePreferences() {
    clearTimeout(this.preferenceTimer);
    if (this.savingPreferences) return;
    this.savingPreferences = true;
    try {
      while (this.preferenceSaved < this.preferenceRevision) {
        const revision = this.preferenceRevision;
        await request('/api/map-preferences', put(this.preferences));
        this.preferenceSaved = revision;
      }
      // Only a send that actually happened may clear the failure (see overlayStore.save).
      if (this.preferenceSaved >= this.preferenceRevision && this.preferenceSaved > 0)
        this.preferenceError = '';
    } catch {
      this.preferenceError = 'errors.preferences_save_failed';
    } finally {
      this.savingPreferences = false;
      this.changed();
    }
  }
  async saveCalibratorPreferences() {
    clearTimeout(this.calibratorPreferenceTimer);
    if (this.savingCalibratorPreferences) return;
    this.savingCalibratorPreferences = true;
    try {
      while (this.calibratorPreferenceSaved < this.calibratorPreferenceRevision) {
        const revision = this.calibratorPreferenceRevision;
        await request('/api/calibration-preferences', put(this.calibratorPreferences));
        this.calibratorPreferenceSaved = revision;
      }
      if (
        this.calibratorPreferenceSaved >= this.calibratorPreferenceRevision &&
        this.calibratorPreferenceSaved > 0
      )
        this.calibratorPreferenceError = '';
    } catch {
      this.calibratorPreferenceError = 'errors.preferences_save_failed';
    } finally {
      this.savingCalibratorPreferences = false;
      this.changed();
    }
  }

  commit(id: string, items: Annotation[]) {
    const s = this.sessions.get(id)!;
    if (JSON.stringify(items) === JSON.stringify(s.items)) return;
    s.past = [...s.past, s.items].slice(-50);
    s.future = [];
    s.items = items;
    s.revision++;
    this.changed();
    void this.save(id);
  }
  undo(id: string) {
    const s = this.sessions.get(id)!;
    if (!s.past.length) return;
    s.future = [s.items, ...s.future];
    s.items = s.past[s.past.length - 1];
    s.past = s.past.slice(0, -1);
    s.revision++;
    this.changed();
    void this.save(id);
  }
  redo(id: string) {
    const s = this.sessions.get(id)!;
    if (!s.future.length) return;
    s.past = [...s.past, s.items].slice(-50);
    s.items = s.future[0];
    s.future = s.future.slice(1);
    s.revision++;
    this.changed();
    void this.save(id);
  }
  async save(id: string) {
    const s = this.sessions.get(id)!;
    if (s.saving) return;
    s.saving = true;
    s.error = '';
    this.changed();
    try {
      while (s.savedRevision < s.revision) {
        const revision = s.revision;
        await request(`/api/maps/${id}/annotations`, put({ schemaVersion: 1, items: s.items }));
        s.savedRevision = revision;
      }
    } catch {
      s.error = 'errors.annotations_save_failed';
    } finally {
      s.saving = false;
      this.changed();
    }
    if (s.savedRevision >= s.revision && s.pendingSync) {
      s.pendingSync = false;
      await this.refetchAnnotations(id);
    }
  }
  /** Teammates' marker updates land in the shared file; pick them up once this session is clean. */
  async refetchAnnotations(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.revision !== s.savedRevision || s.saving) {
      s.pendingSync = true;
      return;
    }
    try {
      const annotations = await request<Annotations>(`/api/maps/${id}/annotations`);
      const current = this.sessions.get(id);
      if (!current) return;
      // A local edit may have raced the fetch; it wins and the refetch is retried after it saves.
      if (current.revision !== current.savedRevision || current.saving) {
        current.pendingSync = true;
        return;
      }
      if (annotations.schemaVersion !== 1 || !Array.isArray(annotations.items)) return;
      current.items = annotations.items;
      this.changed();
    } catch {
      // Keep the local state; the next remote change retries.
    }
  }
  get unsaved() {
    return (
      [...this.sessions.values()].some((s) => s.revision !== s.savedRevision) ||
      this.preferenceSaved < this.preferenceRevision ||
      this.calibratorPreferenceSaved < this.calibratorPreferenceRevision
    );
  }
}

export const workspace = new Workspace();

export function useWorkspace(workspace: Workspace) {
  useSyncExternalStore(workspace.subscribe, workspace.snapshot);
  return workspace;
}
