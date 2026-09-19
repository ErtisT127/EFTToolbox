import { useSyncExternalStore } from 'react';
import type {
  OverlaySettings,
  OverlayView,
  OverlayCommand,
  PlayerState,
  ServerEvent,
} from '../../../contracts/ts/ipc.gen';
import { request, reportClientLog } from './workspaceStore';

class OverlayStore {
  settings?: OverlaySettings;
  view?: OverlayView;
  players = new Map<string, PlayerState>();
  connected = false;
  error = '';
  saving = false;
  private version = 0;
  private revision = 0;
  private saved = 0;
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
    try {
      this.settings = await request<OverlaySettings>('/api/overlay-settings');
      this.error = '';
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'errors.request_failed';
    }
    this.changed();
  }
  update(changes: Partial<OverlaySettings>) {
    if (!this.settings) return;
    this.settings = { ...this.settings, ...changes };
    this.revision++;
    this.changed();
    void this.save();
  }
  async save() {
    if (this.saving || !this.settings) return;
    this.saving = true;
    this.changed();
    try {
      while (this.saved < this.revision) {
        const revision = this.revision;
        const value: OverlaySettings = await request<OverlaySettings>('/api/overlay-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.settings),
        });
        this.saved = revision;
        if (revision === this.revision) this.settings = value;
      }
      this.error = '';
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'errors.request_failed';
    } finally {
      this.saving = false;
      this.changed();
    }
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
          const e = JSON.parse(String(event.data)) as ServerEvent;
          if (e.status.protocolVersion !== '1') throw new Error('Unsupported protocol');
          this.connected = true;
          clearTimeout(stale);
          stale = setTimeout(reconnect, 7000);
          if (e.type === 'snapshot')
            this.players = new Map((e.players || []).map((p) => [p.playerId, p]));
          if (e.player) this.players = new Map(this.players).set(e.player.playerId, e.player);
          if (e.type === 'player_remove' && e.playerId) {
            this.players = new Map(this.players);
            this.players.delete(e.playerId);
          }
          if (e.overlaySettings && !this.saving && this.saved === this.revision)
            this.settings = e.overlaySettings;
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
