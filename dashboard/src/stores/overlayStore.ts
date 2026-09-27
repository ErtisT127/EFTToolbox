import { useSyncExternalStore } from 'react';
import type {
  OverlaySettings,
  OverlayView,
  OverlayCommand,
  PlayerState,
  ServerEvent,
} from '../../../contracts/ts/ipc.gen';
import {
  loadUserSettings,
  patchUserSettingsCache,
  request,
  reportClientLog,
  updateUserSettings,
  workspace,
} from './workspaceStore';
import { gameMonitor } from './gameMonitorStore';
import { multiplayer } from './multiplayerStore';
import { resources } from './resourceStore';

class OverlayStore {
  settings?: OverlaySettings;
  view?: OverlayView;
  players = new Map<string, PlayerState>();
  connected = false;
  error = '';
  loading = false;
  calibrationEpoch = 0;
  calibrationMapId = '';
  saving = false;
  private version = 0;
  private revision = 0;
  private saved = 0;
  private soonTimer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();
  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  };
  snapshot = () => this.version;
  changed() {
    this.version++;
    this.listeners.forEach((f) => f());
  }
  async load() {
    this.loading = true;
    this.changed();
    try {
      this.settings = (await loadUserSettings()).overlay;
      this.error = '';
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'errors.request_failed';
    } finally {
      this.loading = false;
      this.changed();
    }
  }
  /** Visibility belongs to the overlay, not to this copy: writing a stored `visible` back would
   *  hide a panel the user turned on with the shortcut. */
  private merged(changes: Partial<OverlaySettings>) {
    if (!this.settings) return undefined;
    const visible = this.view?.connected ? { visible: this.view.visible } : {};
    return { ...this.settings, ...visible, ...changes };
  }
  update(changes: Partial<OverlaySettings>) {
    const next = this.merged(changes);
    if (!next) return;
    clearTimeout(this.soonTimer);
    this.settings = next;
    this.revision++;
    this.changed();
    void this.save();
  }
  /** For a control that reports continuously, like a dragged slider: the value lands at once and
   *  the write follows the last movement rather than every pixel of it. */
  updateSoon(changes: Partial<OverlaySettings>) {
    const next = this.merged(changes);
    if (!next) return;
    this.settings = next;
    this.revision++;
    this.changed();
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => void this.save(), 350);
  }
  async save() {
    if (this.saving || !this.settings) return;
    this.saving = true;
    this.changed();
    try {
      while (this.saved < this.revision) {
        const revision = this.revision;
        const aggregate = await updateUserSettings((current) => ({
          ...current,
          overlay: this.settings!,
        }));
        this.saved = revision;
        if (revision === this.revision) this.settings = aggregate.overlay;
      }
      // Nothing pending means nothing was sent: clearing the error here would make a retry look
      // like it recovered when it never asked the server anything.
      if (this.saved >= this.revision && this.saved > 0) this.error = '';
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'errors.request_failed';
    } finally {
      this.saving = false;
      this.changed();
    }
  }
  /** Replays whatever failed: a pending save when there is one, otherwise a fresh read. */
  async retry() {
    if (this.saved < this.revision) return this.save();
    return this.load();
  }
  async command(command: OverlayCommand) {
    try {
      await request('/api/overlay/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      });
      this.error = '';
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'errors.request_failed';
    }
    this.changed();
  }
  connect() {
    let stopped = false;
    let socket: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let stale: ReturnType<typeof setTimeout>;
    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
      );
      const current = socket;
      const reconnect = () => {
        current.onclose = null;
        current.onerror = null;
        current.onmessage = null;
        current.close();
        clearTimeout(stale);
        this.connected = false;
        this.changed();
        if (!stopped) retry = setTimeout(connect, 1000);
      };
      stale = setTimeout(reconnect, 7000);
      current.onmessage = (event) => {
        try {
          const e = JSON.parse(String(event.data)) as ServerEvent & Record<string, unknown>;
          const protocolVersion = String(e.status?.protocolVersion || '');
          if (protocolVersion !== '1') throw new Error('Unsupported protocol');
          gameMonitor.handleEvent(e);
          resources.handleEvent(e);
          if (e.multiplayerStatus) multiplayer.handleStatus(e.multiplayerStatus);
          this.connected = true;
          clearTimeout(stale);
          stale = setTimeout(reconnect, 7000);
          if (e.type === 'snapshot')
            this.players = new Map((e.players || []).map((p) => [p.playerId, p]));
          if (e.type === 'calibration_changed' && e.mapId) {
            this.calibrationMapId = e.mapId;
            this.calibrationEpoch++;
          }
          // Teammates' marker updates land in the shared annotations file; the dashboard picks
          // them up here (cast refetches the same way).
          if (e.type === 'annotations_changed' && e.mapId) {
            void workspace.refetchAnnotations(e.mapId);
          }
          if (e.player) this.players = new Map(this.players).set(e.player.playerId, e.player);
          if (e.type === 'player_remove' && e.playerId) {
            this.players = new Map(this.players);
            this.players.delete(e.playerId);
          }
          if (e.overlaySettings && !this.saving && this.saved === this.revision) {
            this.settings = e.overlaySettings;
            patchUserSettingsCache((current) => ({ ...current, overlay: e.overlaySettings! }));
          }
          if (e.overlayView) this.view = e.overlayView;
          this.changed();
        } catch (e) {
          reportClientLog('websocket_invalid', 'Overlay state failed', String(e));
          reconnect();
        }
      };
      current.onclose = reconnect;
      current.onerror = reconnect;
    };
    connect();
    void this.load();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(stale);
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    };
  }
}
export const overlay = new OverlayStore();
export function useOverlay() {
  useSyncExternalStore(overlay.subscribe, overlay.snapshot);
  return overlay;
}
