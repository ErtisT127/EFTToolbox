import { useSyncExternalStore } from 'react';
import type {
  Annotation,
  Annotations,
  MapData,
  MapPreference,
  MapSummary,
  Preferences,
  Sticker,
} from '../../../contracts/ts/ipc.gen';

export function selectableFloors(data: MapData, basemap: string) {
  return data.floors.filter(
    (floor) =>
      floor.id !== data.baseFloor &&
      (basemap === 'tiles'
        ? data.tiles.some((tile) => tile.floorId === floor.id) || floor.svgGroups.length > 0
        : floor.svgGroups.length > 0),
  );
}

const locale = 'zh-CN';

const defaultGroups = ['extracts', 'landmarks'];

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

async function failure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: string };
    if (body.code) return `errors.${body.code}`;
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
};

export class Workspace {
  catalog: MapSummary[] = [];
  stickers: Sticker[] = [];
  sessions = new Map<string, Session>();
  preferences: Preferences = { schemaVersion: 1, selectedMap: '', maps: [], stickerUsage: [] };
  activeId = '';
  loading = true;
  error = '';
  preferenceError = '';
  savingPreferences = false;
  private version = 0;
  private listeners = new Set<() => void>();
  private sequence = 0;
  private controller?: AbortController;
  private preferenceTimer?: ReturnType<typeof setTimeout>;
  private preferenceRevision = 0;
  private preferenceSaved = 0;
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
    this.loading = true;
    this.error = '';
    this.changed();
    try {
      const [catalog, preferences, stickers] = await Promise.all([
        request<MapSummary[]>(`/api/maps?locale=${locale}`),
        request<Preferences>('/api/map-preferences'),
        request<Sticker[]>('/api/stickers'),
      ]);
      if (
        !Array.isArray(catalog) ||
        !Array.isArray(stickers) ||
        preferences.schemaVersion !== 1 ||
        !Array.isArray(preferences.maps)
      )
        throw new Error('errors.data_version');
      this.catalog = catalog;
      this.stickers = stickers;
      // A preferences file written before stickers existed has no usage list, and Go marshals the
      // absent slice back as null rather than an empty array.
      if (!Array.isArray(preferences.stickerUsage)) preferences.stickerUsage = [];
      this.preferences = preferences;
      const id = catalog.find((m) => m.id === preferences.selectedMap)?.id || catalog[0]?.id;
      if (id) await this.select(id, true);
      else {
        this.loading = false;
        this.changed();
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'errors.request_failed';
      this.loading = false;
      this.changed();
    }
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
        this.catalog = catalog;
      }
      if (!this.sessions.has(id) || reload) {
        const [data, annotations] = await Promise.all([
          request<MapData>(`/api/maps/${id}?locale=${locale}`, { signal: this.controller.signal }),
          request<Annotations>(`/api/maps/${id}/annotations`, { signal: this.controller.signal }),
        ]);
        if (sequence !== this.sequence) return;
        if (
          data.schemaVersion !== 1 ||
          !data.floors.some((f) => f.id === data.defaultFloor) ||
          annotations.schemaVersion !== 1
        )
          throw new Error('errors.map_data_invalid');
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
    const data = this.sessions.get(id)!.data;
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
    if (!preference.collapsedGroups) preference.collapsedGroups = [];
    if (!preference.basemap) {
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
  }
  get unsaved() {
    return (
      [...this.sessions.values()].some((s) => s.revision !== s.savedRevision) ||
      this.preferenceSaved < this.preferenceRevision
    );
  }
}

export const workspace = new Workspace();

export function useWorkspace(workspace: Workspace) {
  useSyncExternalStore(workspace.subscribe, workspace.snapshot);
  return workspace;
}
