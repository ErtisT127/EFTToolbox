import { useSyncExternalStore } from 'react';
import type {
  GameMonitorSettings as ContractMonitorSettings,
  GameMonitorStatus as ContractMonitorStatus,
} from '../../../contracts/ts/ipc.gen';
import {
  loadUserSettings,
  patchUserSettingsCache,
  request,
  updateUserSettings,
} from './workspaceStore';

export type GameMode = 'pvp' | 'pve' | 'pvp-season';

export type GameMonitorSettings = ContractMonitorSettings;
export type GameMonitorStatus = ContractMonitorStatus;

type MonitorEvent = {
  type?: string;
  gameMonitorSettings?: GameMonitorSettings;
  gameMonitorStatus?: GameMonitorStatus;
  monitorSettings?: GameMonitorSettings;
  monitorStatus?: GameMonitorStatus;
  mode?: GameMode;
};

class GameMonitorStore {
  settings?: GameMonitorSettings;
  status?: GameMonitorStatus;
  loading = false;
  error = '';
  resourceRevision = 0;
  mapRevision = 0;
  browsing: Record<'screenshots' | 'logs', boolean> = { screenshots: false, logs: false };
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
      const [userSettings, status] = await Promise.all([
        loadUserSettings(),
        request<GameMonitorStatus>('/api/game-monitor/status'),
      ]);
      this.settings = userSettings.gameMonitor;
      this.status = status;
      this.error = '';
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'errors.request_failed';
    } finally {
      this.loading = false;
      this.changed();
    }
  }

  async update(changes: Partial<GameMonitorSettings>) {
    const previous = this.settings;
    const next = { ...this.settings, ...changes } as GameMonitorSettings;
    this.settings = next;
    this.changed();
    try {
      this.settings = (
        await updateUserSettings((current) => ({
          ...current,
          gameMonitor: next,
        }))
      ).gameMonitor;
      this.error = '';
    } catch (error) {
      if (this.settings === next) this.settings = previous;
      this.error = error instanceof Error ? error.message : 'errors.request_failed';
    }
    this.changed();
  }

  async browse(kind: 'screenshots' | 'logs') {
    if (this.browsing[kind]) return;
    this.browsing = { ...this.browsing, [kind]: true };
    this.changed();
    try {
      const result = await request<{ path?: string } | string>(`/api/game-monitor/browse/${kind}`, {
        method: 'POST',
      });
      const path = typeof result === 'string' ? result : result.path;
      // An empty path intentionally disables this watcher when the dialog is cancelled.
      if (path !== undefined)
        await this.update({
          [kind === 'screenshots' ? 'screenshotDirectory' : 'logDirectory']: path,
        });
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'errors.request_failed';
      this.changed();
    } finally {
      this.browsing = { ...this.browsing, [kind]: false };
      this.changed();
    }
  }

  handleEvent(event: MonitorEvent) {
    if (event.gameMonitorSettings || event.monitorSettings) {
      this.settings = event.gameMonitorSettings || event.monitorSettings;
    }
    const incomingStatus = event.gameMonitorStatus || event.monitorStatus;
    const previousMap = this.status?.mapId;
    if (incomingStatus) this.status = incomingStatus;
    if (
      event.type === 'map_changed' &&
      incomingStatus?.mapId &&
      incomingStatus.mapId !== previousMap
    )
      this.mapRevision++;
    if (incomingStatus && this.settings)
      this.settings = { ...this.settings, mode: incomingStatus.mode };
    if (event.mode && this.settings) this.settings = { ...this.settings, mode: event.mode };
    if (event.type === 'snapshot' && incomingStatus && !this.settings) {
      this.settings = {
        schemaVersion: 1,
        screenshotDirectory: '',
        logDirectory: '',
        deleteScreenshots: false,
        autoMapSwitch: true,
        mode: incomingStatus.mode,
      };
    }
    if (
      this.settings &&
      (event.gameMonitorSettings || event.monitorSettings || incomingStatus || event.mode)
    )
      patchUserSettingsCache((current) => ({ ...current, gameMonitor: this.settings! }));
    if (event.type === 'resources_changed') this.resourceRevision++;
    this.changed();
  }
}

export const gameMonitor = new GameMonitorStore();

export function useGameMonitor() {
  useSyncExternalStore(gameMonitor.subscribe, gameMonitor.snapshot);
  return gameMonitor;
}
