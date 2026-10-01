import { useSyncExternalStore } from 'react';
import { useSelector } from 'react-redux';
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
import { markerPreferences as defaultMarkerPreferences } from '../defaults.gen';
import { api, isRevisionConflict } from './api';
import { store, type RootState } from './store';
import { clearConflict, setConflict, setMultiplayerState } from './clientState';
import { nextMarkerPreferences } from '../pages/map/lib/visibility';
import { errorDetailOf } from '../lib/errors';

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

function multiplayerError(reason: unknown) {
  const data = reason && typeof reason === 'object' && 'data' in reason ? reason.data : undefined;
  const body = data && typeof data === 'object' ? (data as { code?: string; detail?: string }) : {};
  return new MultiplayerError(body.code || 'request_failed', body.detail || '');
}

class MultiplayerStore {
  get settingsDraft() {
    return store.getState().client.multiplayer.settingsDraft;
  }
  set settingsDraft(value: MultiplayerSettings | undefined) {
    store.dispatch(setMultiplayerState({ settingsDraft: value }));
  }
  get markerDraft() {
    return store.getState().client.multiplayer.markerDraft;
  }
  set markerDraft(value: MarkerPreferences | undefined) {
    store.dispatch(setMultiplayerState({ markerDraft: value }));
  }
  private settingsSaveQueue = Promise.resolve();
  private settingsSync: Promise<unknown> = Promise.resolve();
  private settingsEditRevision = 0;
  get status() {
    return api.endpoints.getMultiplayerStatus.select()(store.getState()).data || { enabled: false };
  }
  get settings() {
    return (
      this.settingsDraft ||
      api.endpoints.getMultiplayerSettings.select()(store.getState()).data?.value
    );
  }
  get markerPreferences() {
    return (
      this.markerDraft ||
      api.endpoints.getMarkerPreferences.select()(store.getState()).data?.value || {
        ...defaultMarkerPreferences,
        hiddenOwners: [...defaultMarkerPreferences.hiddenOwners],
        shownOwners: [...defaultMarkerPreferences.shownOwners],
      }
    );
  }
  get showMembersPanel() {
    return this.settings?.showMembersPanel ?? true;
  }
  get showPlayerNames() {
    return this.settings?.showPlayerNames ?? false;
  }

  get stunListSource(): 'host' | 'ip' {
    return this.settings?.stunListSource ?? 'host';
  }
  get initialized() {
    return store.getState().client.multiplayer.initialized;
  }
  set initialized(value: boolean) {
    store.dispatch(setMultiplayerState({ initialized: value }));
  }
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

  private refreshSettings() {
    this.settingsSync = this.settingsSync
      .catch(() => undefined)
      .then(() =>
        store
          .dispatch(
            api.endpoints.getMultiplayerSettings.initiate(undefined, { forceRefetch: true }),
          )
          .unwrap(),
      )
      .catch(() => undefined);
    return this.settingsSync;
  }

  /** The room state itself arrives over /ws; this only seeds identity, status and marker prefs. */
  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    try {
      await Promise.all([
        store
          .dispatch(api.endpoints.getMultiplayerStatus.initiate(undefined, { forceRefetch: true }))
          .unwrap(),
        store
          .dispatch(
            api.endpoints.getMultiplayerSettings.initiate(undefined, { forceRefetch: true }),
          )
          .unwrap(),
        store
          .dispatch(api.endpoints.getMarkerPreferences.initiate(undefined, { forceRefetch: true }))
          .unwrap(),
      ]);
      this.settingsDraft = undefined;
      this.markerDraft = undefined;
    } catch {
      this.initialized = false;
    }
    this.changed();
  }

  async reload() {
    this.initialized = false;
    await this.initialize();
  }

  /** Live status push from the backend's multiplayer_changed event (zero polling). */
  handleStatus(status: MultiplayerStatus) {
    const previous = this.status;
    void store.dispatch(api.util.upsertQueryData('getMultiplayerStatus', undefined, status));
    // Keep the versioned settings snapshot stable while an identity edit is in flight. A status
    // push contains the new self color/name before the PUT response clears the draft; refetching
    // here races the queued save and turns a local edit into a false revision conflict.
    const draft = this.settingsDraft;
    const settings = api.endpoints.getMultiplayerSettings.select()(store.getState()).data?.value;
    const self = status.self;
    if (
      !draft &&
      (!settings ||
        (self && (settings.playerName !== self.name || settings.playerColor !== self.color)))
    )
      void this.refreshSettings();
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
    try {
      const status = await store.dispatch(api.endpoints.hostMultiplayer.initiate(request)).unwrap();
      void store.dispatch(api.util.upsertQueryData('getMultiplayerStatus', undefined, status));
      await this.refreshSettings();
      return status;
    } catch (error) {
      throw multiplayerError(error);
    }
  }

  async join(request: MultiplayerJoinRequest) {
    try {
      const status = await store.dispatch(api.endpoints.joinMultiplayer.initiate(request)).unwrap();
      void store.dispatch(api.util.upsertQueryData('getMultiplayerStatus', undefined, status));
      await this.refreshSettings();
      return status;
    } catch (error) {
      throw multiplayerError(error);
    }
  }

  async leave() {
    try {
      const status = await store.dispatch(api.endpoints.leaveMultiplayer.initiate()).unwrap();
      void store.dispatch(api.util.upsertQueryData('getMultiplayerStatus', undefined, status));
      return status;
    } catch (error) {
      throw multiplayerError(error);
    }
  }

  async kick(peerId: string) {
    try {
      const status = await store
        .dispatch(
          api.endpoints.kickMultiplayerPeer.initiate({ peerId } satisfies MultiplayerKickRequest),
        )
        .unwrap();
      void store.dispatch(api.util.upsertQueryData('getMultiplayerStatus', undefined, status));
      return status;
    } catch (error) {
      throw multiplayerError(error);
    }
  }

  async refreshStatus() {
    return store
      .dispatch(api.endpoints.getMultiplayerStatus.initiate(undefined, { forceRefetch: true }))
      .unwrap();
  }

  async saveIdentity(
    changes: Partial<
      Pick<
        MultiplayerSettings,
        'playerName' | 'playerColor' | 'showMembersPanel' | 'showPlayerNames' | 'stunListSource'
      >
    >,
    explicit = false,
  ) {
    await this.settingsSync;
    if (!this.settings) return;
    this.settingsDraft = { ...this.settings, ...changes };
    if (
      !explicit &&
      store.getState().client.conflicts.some((item) => item.key === 'multiplayer-settings')
    ) {
      this.changed();
      return;
    }
    const editRevision = ++this.settingsEditRevision;
    this.changed();
    this.settingsSaveQueue = this.settingsSaveQueue
      .catch(() => undefined)
      .then(async () => {
        if (
          !explicit &&
          store.getState().client.conflicts.some((item) => item.key === 'multiplayer-settings')
        )
          return;
        const value = this.settingsDraft;
        if (!value) return;
        try {
          const current = api.endpoints.getMultiplayerSettings.select()(store.getState()).data;
          if (!current) throw new MultiplayerError('request_failed');
          const result = await store
            .dispatch(
              api.endpoints.updateMultiplayerSettings.initiate({
                value,
                revision: current.revision,
                etag: current.etag,
              }),
            )
            .unwrap();
          store.dispatch(
            api.util.updateQueryData('getMultiplayerSettings', undefined, () => result),
          );
          if (editRevision === this.settingsEditRevision) {
            this.settingsDraft = undefined;
            store.dispatch(clearConflict('multiplayer-settings'));
          }
        } catch (error) {
          if (isRevisionConflict(error)) {
            store.dispatch(
              setConflict({ key: 'multiplayer-settings', resource: 'multiplayerSettings' }),
            );
            store.dispatch(api.util.invalidateTags(['Multiplayer']));
          }
          throw multiplayerError(error);
        } finally {
          this.changed();
        }
      });
    await this.settingsSaveQueue;
  }

  async retryIdentityConflict() {
    const draft = this.settingsDraft;
    if (!draft) return;
    await store
      .dispatch(api.endpoints.getMultiplayerSettings.initiate(undefined, { forceRefetch: true }))
      .unwrap();
    await this.saveIdentity(
      {
        playerName: draft.playerName,
        playerColor: draft.playerColor,
        showMembersPanel: draft.showMembersPanel,
        showPlayerNames: draft.showPlayerNames,
        stunListSource: draft.stunListSource,
      },
      true,
    );
  }

  discardIdentityConflict() {
    this.settingsDraft = undefined;
    store.dispatch(clearConflict('multiplayer-settings'));
    void store.dispatch(
      api.endpoints.getMultiplayerSettings.initiate(undefined, { forceRefetch: true }),
    );
    this.changed();
  }

  /** Owner visibility is a pure local preference; the backend never writes these arrays. */
  toggleOwner(ownerId: string, visible: boolean) {
    const currentPreferences = this.markerPreferences;
    const next = nextMarkerPreferences(currentPreferences, ownerId, visible, {
      selfId: this.selfId,
      activeOwners: (this.status.members || []).map((member) => member.peerId),
    });
    // The transition returns the same object when the toggle changes nothing, so nothing is written.
    if (next === currentPreferences) return;
    this.markerDraft = next;
    this.changed();
    // Serial writes: the last toggle's snapshot wins, and a failure only logs (the local state
    // already reflects the user's choice; the next toggle rewrites the file).
    void this.saveMarkerPreferences();
  }

  private markerSaving = false;
  private async saveMarkerPreferences(explicit = false) {
    if (this.markerSaving || !this.markerDraft) return;
    if (
      !explicit &&
      store.getState().client.conflicts.some((item) => item.key === 'marker-preferences')
    )
      return;
    this.markerSaving = true;
    try {
      while (this.markerDraft) {
        const value: MarkerPreferences = this.markerDraft!;
        const current = api.endpoints.getMarkerPreferences.select()(store.getState()).data;
        if (!current) return;
        const saved = await store
          .dispatch(
            api.endpoints.updateMarkerPreferences.initiate({
              value,
              revision: current.revision,
              etag: current.etag,
            }),
          )
          .unwrap();
        store.dispatch(api.util.updateQueryData('getMarkerPreferences', undefined, () => saved));
        if (this.markerDraft === value) {
          this.markerDraft = undefined;
          store.dispatch(clearConflict('marker-preferences'));
        }
      }
    } catch (error) {
      if (isRevisionConflict(error)) {
        store.dispatch(setConflict({ key: 'marker-preferences', resource: 'markerPreferences' }));
        store.dispatch(api.util.invalidateTags(['Preferences']));
      } else
        reportClientLog(
          'http_request_failed',
          'marker preferences save failed',
          errorDetailOf(error),
        );
    } finally {
      this.markerSaving = false;
      this.changed();
    }
  }

  async retryMarkerConflict() {
    if (!this.markerDraft) return;
    await store
      .dispatch(api.endpoints.getMarkerPreferences.initiate(undefined, { forceRefetch: true }))
      .unwrap();
    await this.saveMarkerPreferences(true);
  }

  discardMarkerConflict() {
    this.markerDraft = undefined;
    store.dispatch(clearConflict('marker-preferences'));
    void store.dispatch(
      api.endpoints.getMarkerPreferences.initiate(undefined, { forceRefetch: true }),
    );
    this.changed();
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
  useSelector(api.endpoints.getMultiplayerStatus.select());
  useSelector(api.endpoints.getMultiplayerSettings.select());
  useSelector(api.endpoints.getMarkerPreferences.select());
  useSelector((state: RootState) => state.client.multiplayer);
  useSyncExternalStore(multiplayer.subscribe, multiplayer.snapshot);
  return multiplayer;
}
