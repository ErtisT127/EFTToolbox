import { useSyncExternalStore } from 'react';
import i18n from '../i18n';
import type {
  MarkerPreferences,
  MultiplayerHostRequest,
  MultiplayerKickRequest,
  MultiplayerJoinRequest,
  MultiplayerSettings,
  MultiplayerStatus,
} from '../../../contracts/ts/ipc.gen';
import { reportClientLog } from './workspaceStore';
import { notices } from './noticeStore';

// Carries the backend's error code plus its optional detail token (e.g. the occupied port) so the
// panel can render the concrete failure reason the backend chose.
export class MultiplayerError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail = '') {
    super(code);
    this.name = 'MultiplayerError';
    this.code = code;
    this.detail = detail;
  }
}

async function mpFetch<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    reportClientLog('http_request_failed', `request failed: ${url}`, String(error));
    throw new MultiplayerError('request_failed');
  }
  if (!response.ok) {
    let failure = new MultiplayerError('request_failed');
    try {
      const body = (await response.json()) as { code?: string; detail?: string };
      if (body.code) failure = new MultiplayerError(body.code, body.detail || '');
    } catch {
      // Not a JSON error body; keep the generic failure.
    }
    reportClientLog('http_request_failed', `${response.status} ${url}`, failure.code);
    throw failure;
  }
  return response.json() as Promise<T>;
}

const put = (data: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

const post = (data?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: data === undefined ? undefined : JSON.stringify(data),
});

class MultiplayerStore {
  status: MultiplayerStatus = { enabled: false };
  settings?: MultiplayerSettings;
  showMembersPanel = true;
  markerPreferences: MarkerPreferences = { schemaVersion: 1, hiddenOwners: [], shownOwners: [] };
  private initialized = false;
  private markerWrite = Promise.resolve();
  private version = 0;
  private listeners = new Set<() => void>();
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

  /** The room state itself arrives over /ws; this only seeds identity, status and marker prefs. */
  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const [status, settings, markerPreferences] = await Promise.all([
        mpFetch<MultiplayerStatus>('/api/multiplayer/status'),
        mpFetch<MultiplayerSettings>('/api/multiplayer/settings'),
        mpFetch<MarkerPreferences>('/api/marker-preferences'),
      ]);
      this.status = status;
      this.settings = settings;
      this.showMembersPanel = settings.showMembersPanel ?? true;
      if (!Array.isArray(markerPreferences.hiddenOwners)) markerPreferences.hiddenOwners = [];
      if (!Array.isArray(markerPreferences.shownOwners)) markerPreferences.shownOwners = [];
      this.markerPreferences = markerPreferences;
    } catch {
      this.initialized = false;
    }
    this.changed();
  }

  /** Live status push from the backend's multiplayer_changed event (zero polling). */
  handleStatus(status: MultiplayerStatus) {
    const previous = this.status;
    this.status = status;
    this.notifyRoomEvents(previous, status);
    this.changed();
  }

  // Room events belong to no single control (they arrive while the panel is closed), so they go
  // through the shared notice pipeline. The diff only fires while staying in the room: the very
  // first roster after a join would otherwise announce every existing member as "joined".
  private lastNoticeAt = new Map<string, number>();

  private notifyRoomEvents(previous: MultiplayerStatus, next: MultiplayerStatus) {
    if (previous.enabled && !next.enabled) {
      notices.push(
        previous.role === 'host'
          ? i18n.t('multiplayer.notices.dissolved')
          : i18n.t('multiplayer.notices.hostLost'),
        undefined,
        'warning',
      );
      return;
    }
    if (!previous.enabled || !next.enabled) return;
    const now = Date.now();
    const previousIds = new Set((previous.members || []).map((member) => member.peerId));
    for (const member of next.members || []) {
      if (previousIds.has(member.peerId)) continue;
      if (now - (this.lastNoticeAt.get(`join:${member.peerId}`) || 0) < 5000) continue;
      this.lastNoticeAt.set(`join:${member.peerId}`, now);
      notices.push(
        i18n.t('multiplayer.notices.joined', { name: member.name }),
        undefined,
        'success',
      );
    }
    const nextIds = new Set((next.members || []).map((member) => member.peerId));
    for (const member of previous.members || []) {
      if (nextIds.has(member.peerId)) continue;
      if (now - (this.lastNoticeAt.get(`leave:${member.peerId}`) || 0) < 5000) continue;
      this.lastNoticeAt.set(`leave:${member.peerId}`, now);
      notices.push(i18n.t('multiplayer.notices.left', { name: member.name }));
    }
  }

  get selfId() {
    return this.settings?.playerId || '';
  }
  get selfName() {
    return this.settings?.playerName || '';
  }
  get selfColor() {
    return this.settings?.playerColor || '';
  }

  async host(request: MultiplayerHostRequest) {
    const status = await mpFetch<MultiplayerStatus>('/api/multiplayer/host', post(request));
    this.status = status;
    this.changed();
    return status;
  }

  async join(request: MultiplayerJoinRequest) {
    const status = await mpFetch<MultiplayerStatus>('/api/multiplayer/join', post(request));
    this.status = status;
    this.changed();
    return status;
  }

  async leave() {
    const status = await mpFetch<MultiplayerStatus>('/api/multiplayer/leave', post());
    this.status = status;
    this.changed();
    return status;
  }

  async kick(peerId: string) {
    const status = await mpFetch<MultiplayerStatus>(
      '/api/multiplayer/kick',
      post({ peerId } satisfies MultiplayerKickRequest),
    );
    this.status = status;
    this.changed();
    return status;
  }

  async refreshStatus() {
    this.status = await mpFetch<MultiplayerStatus>('/api/multiplayer/status');
    this.changed();
    return this.status;
  }

  async saveIdentity(
    changes: Partial<Pick<MultiplayerSettings, 'playerName' | 'playerColor' | 'showMembersPanel'>>,
  ) {
    if (!this.settings) return;
    this.settings = { ...this.settings, ...changes };
    this.showMembersPanel = this.settings.showMembersPanel ?? true;
    this.changed();
    this.settings = await mpFetch<MultiplayerSettings>(
      '/api/multiplayer/settings',
      put(this.settings),
    );
    this.showMembersPanel = this.settings.showMembersPanel ?? true;
    this.changed();
  }

  /** Owner visibility is a pure local preference; the backend never writes these arrays. */
  toggleOwner(ownerId: string, visible: boolean) {
    const hidden = this.markerPreferences.hiddenOwners;
    const shown = this.markerPreferences.shownOwners;
    if (visible) {
      if (!hidden.includes(ownerId)) return;
      this.markerPreferences = {
        ...this.markerPreferences,
        hiddenOwners: hidden.filter((id) => id !== ownerId),
      };
    } else if (shown.includes(ownerId)) {
      // A departed owner explicitly shown goes back to hidden-by-default on uncheck.
      this.markerPreferences = {
        ...this.markerPreferences,
        shownOwners: shown.filter((id) => id !== ownerId),
      };
    } else {
      if (hidden.includes(ownerId)) return;
      this.markerPreferences = {
        ...this.markerPreferences,
        hiddenOwners: [...hidden, ownerId],
      };
    }
    this.changed();
    // Serial writes: the last toggle's snapshot wins, and a failure only logs (the local state
    // already reflects the user's choice; the next toggle rewrites the file).
    const next = this.markerPreferences;
    this.markerWrite = this.markerWrite.then(() =>
      mpFetch<MarkerPreferences>('/api/marker-preferences', put(next)).then(
        () => undefined,
        () => {
          reportClientLog('http_request_failed', 'marker preferences save failed');
        },
      ),
    );
  }

  /**
   * Whether another owner's markers render. Active members default visible, departed owners
   * default hidden (unless explicitly shown), and a manual hide always wins.
   */
  ownerVisible(ownerId: string) {
    if (this.markerPreferences.hiddenOwners.includes(ownerId)) return false;
    if (ownerId === this.selfId) return true;
    if (this.markerPreferences.shownOwners.includes(ownerId)) return true;
    return (this.status.members || []).some((member) => member.peerId === ownerId);
  }

  ownerName(ownerId: string) {
    const member = (this.status.members || []).find((m) => m.peerId === ownerId);
    if (member) return member.name;
    const known = (this.status.known || []).find((m) => m.peerId === ownerId);
    return known?.name || '';
  }

  ownerColor(ownerId: string) {
    const member = (this.status.members || []).find((m) => m.peerId === ownerId);
    if (member) return member.color;
    const known = (this.status.known || []).find((m) => m.peerId === ownerId);
    return known?.color || '';
  }
}

export const multiplayer = new MultiplayerStore();

export function useMultiplayer() {
  useSyncExternalStore(multiplayer.subscribe, multiplayer.snapshot);
  return multiplayer;
}
