import { useSyncExternalStore } from 'react';
import { useSelector } from 'react-redux';
import type {
  GameMonitorSettings as ContractMonitorSettings,
  GameMonitorStatus as ContractMonitorStatus,
  ServerEvent,
} from '../../../contracts/ts/ipc.gen';
import { api, isRevisionConflict } from './api';
import { errorKeyOf } from '../lib/errors';
import { store, type RootState } from './store';
import { clearConflict, setConflict, setGameMonitorState } from './clientState';

export type GameMode = 'pvp' | 'pve' | 'pvp-season';

export type GameMonitorSettings = ContractMonitorSettings;
export type GameMonitorStatus = ContractMonitorStatus;

class GameMonitorStore {
  get settingsDraft() {
    return store.getState().client.gameMonitor.settingsDraft;
  }
  set settingsDraft(value: GameMonitorSettings | undefined) {
    store.dispatch(setGameMonitorState({ settingsDraft: value }));
  }
  get settings() {
    return (
      this.settingsDraft ||
      api.endpoints.getGameMonitorSettings.select()(store.getState()).data?.value
    );
  }
  get status() {
    return (
      store.getState().client.gameMonitor.status ||
      api.endpoints.getGameMonitorStatus.select()(store.getState()).data
    );
  }
  get loading() {
    return store.getState().client.gameMonitor.loading;
  }
  set loading(value: boolean) {
    store.dispatch(setGameMonitorState({ loading: value }));
  }
  get error() {
    return store.getState().client.gameMonitor.error;
  }
  set error(value: string) {
    store.dispatch(setGameMonitorState({ error: value }));
  }
  get resourceRevision() {
    return store.getState().client.gameMonitor.resourceRevision;
  }
  set resourceRevision(value: number) {
    store.dispatch(setGameMonitorState({ resourceRevision: value }));
  }
  get mapRevision() {
    return store.getState().client.gameMonitor.mapRevision;
  }
  set mapRevision(value: number) {
    store.dispatch(setGameMonitorState({ mapRevision: value }));
  }
  get browsing() {
    return store.getState().client.gameMonitor.browsing;
  }
  set browsing(value: Record<'screenshots' | 'logs', boolean>) {
    store.dispatch(setGameMonitorState({ browsing: value }));
  }
  private saveQueue = Promise.resolve();
  private settingsSync: Promise<unknown> = Promise.resolve();
  private editRevision = 0;
  private version = 0;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.version;
  private changed() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }

  async initialize() {
    this.loading = true;
    try {
      const [, status] = await Promise.all([
        store
          .dispatch(
            api.endpoints.getGameMonitorSettings.initiate(undefined, { forceRefetch: true }),
          )
          .unwrap(),
        store
          .dispatch(api.endpoints.getGameMonitorStatus.initiate(undefined, { forceRefetch: true }))
          .unwrap(),
      ]);
      store.dispatch(setGameMonitorState({ status }));
      this.settingsDraft = undefined;
      this.error = '';
    } catch (error) {
      this.error = errorKeyOf(error, 'errors.request_failed');
    } finally {
      this.loading = false;
      this.changed();
    }
  }

  async update(changes: Partial<GameMonitorSettings>, explicit = false) {
    // Automatic mode changes are persisted by the backend and invalidate this query. Wait for the
    // authoritative revision before sending a manual edit, otherwise the first click can race the
    // refresh and be rejected as a stale write.
    await this.settingsSync;
    const current = this.settings;
    if (!current) return;
    const next = { ...current, ...changes };
    const revision = ++this.editRevision;
    this.settingsDraft = next;
    this.changed();
    if (
      !explicit &&
      store.getState().client.conflicts.some((item) => item.key === 'game-monitor-settings')
    )
      return;
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        if (
          !explicit &&
          store.getState().client.conflicts.some((item) => item.key === 'game-monitor-settings')
        )
          return;
        const value = this.settingsDraft;
        if (!value) return;
        try {
          const versioned = api.endpoints.getGameMonitorSettings.select()(store.getState()).data;
          if (!versioned) throw new Error('errors.request_failed');
          const saved = await store
            .dispatch(
              api.endpoints.updateGameMonitorSettings.initiate({
                value,
                revision: versioned.revision,
                etag: versioned.etag,
              }),
            )
            .unwrap();
          store.dispatch(
            api.util.updateQueryData('getGameMonitorSettings', undefined, () => saved),
          );
          if (revision === this.editRevision) {
            this.settingsDraft = undefined;
            this.error = '';
            store.dispatch(clearConflict('game-monitor-settings'));
          }
        } catch (error) {
          if (isRevisionConflict(error)) {
            store.dispatch(
              setConflict({ key: 'game-monitor-settings', resource: 'gameMonitorSettings' }),
            );
            store.dispatch(api.util.invalidateTags(['Settings']));
          }
          this.error = isRevisionConflict(error)
            ? 'errors.revision_conflict'
            : errorKeyOf(error, 'errors.request_failed');
        } finally {
          this.changed();
        }
      });
    await this.saveQueue;
  }

  retry() {
    if (this.error === 'errors.revision_conflict')
      return store
        .dispatch(api.endpoints.getGameMonitorSettings.initiate(undefined, { forceRefetch: true }))
        .unwrap()
        .then(() => this.update(this.settingsDraft || this.settings || {}, true));
    return this.settings ? this.update(this.settings) : this.initialize();
  }

  discardConflict() {
    this.settingsDraft = undefined;
    this.error = '';
    store.dispatch(clearConflict('game-monitor-settings'));
    void store.dispatch(
      api.endpoints.getGameMonitorSettings.initiate(undefined, { forceRefetch: true }),
    );
    this.changed();
  }

  async browse(kind: 'screenshots' | 'logs') {
    if (this.browsing[kind]) return;
    this.browsing = { ...this.browsing, [kind]: true };
    this.changed();
    try {
      const result = await store
        .dispatch(api.endpoints.browseGameMonitorDirectory.initiate(kind))
        .unwrap();
      const path = typeof result === 'string' ? result : result.path;
      // An empty path intentionally disables this watcher when the dialog is cancelled.
      if (path !== undefined)
        await this.update({
          [kind === 'screenshots' ? 'screenshotDirectory' : 'logDirectory']: path,
        });
    } catch (error) {
      this.error = errorKeyOf(error, 'errors.request_failed');
      this.changed();
    } finally {
      this.browsing = { ...this.browsing, [kind]: false };
      this.changed();
    }
  }

  handleEvent(event: ServerEvent) {
    if (event.gameMonitorSettings) {
      store.dispatch(api.util.invalidateTags(['Settings']));
      this.settingsSync = this.settingsSync
        .catch(() => undefined)
        .then(() =>
          store
            .dispatch(
              api.endpoints.getGameMonitorSettings.initiate(undefined, { forceRefetch: true }),
            )
            .unwrap(),
        )
        .catch(() => undefined)
        .then(() => this.changed());
    }
    const incomingStatus = event.gameMonitorStatus;
    const previousMap = this.status?.mapId;
    const previousMode = this.status?.mode;
    if (incomingStatus) {
      store.dispatch(setGameMonitorState({ status: incomingStatus }));
      void store.dispatch(
        api.util.upsertQueryData('getGameMonitorStatus', undefined, incomingStatus),
      );
    }
    if (
      incomingStatus?.mapId &&
      (event.type === 'map_changed' ||
        (event.type === 'snapshot' &&
          (incomingStatus.mapId !== previousMap || incomingStatus.mode !== previousMode)))
    )
      this.mapRevision++;
    if (
      event.type === 'resources_changed' ||
      (event.type === 'snapshot' && incomingStatus?.mode && incomingStatus.mode !== previousMode)
    )
      this.resourceRevision++;
    this.changed();
  }
}

export const gameMonitor = new GameMonitorStore();

export function useGameMonitor() {
  useSelector(api.endpoints.getGameMonitorSettings.select());
  useSelector(api.endpoints.getGameMonitorStatus.select());
  useSelector((state: RootState) => state.client.gameMonitor);
  useSyncExternalStore(gameMonitor.subscribe, gameMonitor.snapshot);
  return gameMonitor;
}
