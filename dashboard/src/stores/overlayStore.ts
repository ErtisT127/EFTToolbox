import { useSyncExternalStore } from 'react';
import { useSelector } from 'react-redux';
import i18n from '../i18n';
import type { LocaleKey } from '../hooks/useLocale';
import {
  ContractProtocolVersion,
  type OverlaySettings,
  type OverlayView,
  type OverlayCommand,
  type PlayerState,
  type ServerEvent,
  type RecognitionResult,
  type RecognitionSettings,
} from '../../../contracts/ts/ipc.gen';
import { reportClientLog, workspace } from './workspaceStore';
import { gameMonitor } from './gameMonitorStore';
import { multiplayer } from './multiplayerStore';
import { notices } from './noticeStore';
import { api, isRevisionConflict } from './api';
import { errorKeyOf } from '../lib/errors';
import { store, type RootState } from './store';
import { setOverlayState } from './clientState';

class OverlayStore {
  get settingsDraft() {
    return store.getState().client.overlay.settingsDraft;
  }
  set settingsDraft(value: OverlaySettings | undefined) {
    store.dispatch(setOverlayState({ settingsDraft: value }));
  }
  get recognitionSettingsDraft() {
    return store.getState().client.overlay.recognitionSettingsDraft;
  }
  set recognitionSettingsDraft(value: RecognitionSettings | undefined) {
    store.dispatch(setOverlayState({ recognitionSettingsDraft: value }));
  }
  get settings() {
    return (
      this.settingsDraft || api.endpoints.getOverlaySettings.select()(store.getState()).data?.value
    );
  }
  get recognitionSettings() {
    return (
      this.recognitionSettingsDraft ||
      api.endpoints.getRecognitionSettings.select()(store.getState()).data?.value
    );
  }
  get recognitionResult() {
    return store.getState().client.overlay.recognitionResult;
  }
  set recognitionResult(value: RecognitionResult | undefined) {
    store.dispatch(setOverlayState({ recognitionResult: value }));
  }
  /** The run the backend says is in flight; both displays show their loading state from it. */
  get recognitionPending() {
    return store.getState().client.overlay.recognitionPending;
  }
  set recognitionPending(value: boolean) {
    store.dispatch(setOverlayState({ recognitionPending: value }));
  }
  private activeRecognitionId = '';
  private recognitionRevision = 0;
  private recognitionSaved = 0;
  private recognitionSaving = false;
  /** The import the items page is waiting for; empty when nothing is pending. */
  get recognitionRequestId() {
    return store.getState().client.overlay.recognitionRequestId;
  }
  set recognitionRequestId(value: string) {
    store.dispatch(setOverlayState({ recognitionRequestId: value }));
  }
  get view() {
    return store.getState().client.overlay.view;
  }
  set view(value: OverlayView | undefined) {
    store.dispatch(setOverlayState({ view: value }));
  }
  players = new Map<string, PlayerState>();
  private connectedOnce = false;
  get connected() {
    return store.getState().client.overlay.connected;
  }
  get hasConnected() {
    return this.connectedOnce;
  }
  set connected(value: boolean) {
    if (this.connected !== value) store.dispatch(setOverlayState({ connected: value }));
  }
  get error() {
    return store.getState().client.overlay.error;
  }
  set error(value: string) {
    store.dispatch(setOverlayState({ error: value }));
  }
  get loading() {
    return store.getState().client.overlay.loading;
  }
  set loading(value: boolean) {
    store.dispatch(setOverlayState({ loading: value }));
  }
  get calibrationEpoch() {
    return store.getState().client.overlay.calibrationEpoch;
  }
  set calibrationEpoch(value: number) {
    store.dispatch(setOverlayState({ calibrationEpoch: value }));
  }
  get calibrationMapId() {
    return store.getState().client.overlay.calibrationMapId;
  }
  set calibrationMapId(value: string) {
    store.dispatch(setOverlayState({ calibrationMapId: value }));
  }
  get saving() {
    return store.getState().client.overlay.saving;
  }
  set saving(value: boolean) {
    store.dispatch(setOverlayState({ saving: value }));
  }
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
  /** The items page starts an import; its id also tells this page's own result from a capture's. */
  requestRecognition(requestId: string) {
    this.recognitionRequestId = requestId;
    this.changed();
  }
  /** Clearing is shared: the backend drops the result and the overlay closes its panel too. */
  clearRecognition(requestId?: string) {
    const expected = requestId || this.recognitionRequestId || this.activeRecognitionId;
    if (!requestId || requestId === this.recognitionRequestId) this.recognitionRequestId = '';
    this.changed();
    void store
      .dispatch(api.endpoints.clearRecognitionResult.initiate(expected || undefined))
      .unwrap()
      .catch((reason: unknown) =>
        reportClientLog(
          'recognition_clear_failed',
          'Recognition result could not be cleared',
          String(reason),
        ),
      );
  }
  /**
   * The recognition rail and the settings tab write the same object; the optimistic update is
   * rolled back when the backend refuses it, so neither surface can show a value that was rejected.
   */
  saveRecognitionSettings(changes: Partial<RecognitionSettings>) {
    if (!this.recognitionSettings) return;
    this.recognitionSettingsDraft = { ...this.recognitionSettings, ...changes };
    this.recognitionRevision++;
    this.changed();
    void this.flushRecognitionSettings();
  }
  private async flushRecognitionSettings() {
    if (this.recognitionSaving) return;
    this.recognitionSaving = true;
    try {
      while (this.recognitionSaved < this.recognitionRevision) {
        const revision = this.recognitionRevision;
        try {
          const cached =
            api.endpoints.getRecognitionSettings.select()(store.getState()).data ||
            (await store
              .dispatch(api.endpoints.getRecognitionSettings.initiate(undefined))
              .unwrap());
          const result = await store
            .dispatch(
              api.endpoints.updateRecognitionSettings.initiate({
                value: this.recognitionSettingsDraft!,
                revision: cached.revision,
                etag: cached.etag,
              }),
            )
            .unwrap();
          store.dispatch(
            api.util.updateQueryData('getRecognitionSettings', undefined, () => result),
          );
          this.recognitionSaved = revision;
          if (revision === this.recognitionRevision) this.recognitionSettingsDraft = undefined;
        } catch (reason: unknown) {
          if (revision !== this.recognitionRevision) continue;
          this.recognitionSaved = revision;
          if (isRevisionConflict(reason)) store.dispatch(api.util.invalidateTags(['Settings']));
          else this.recognitionSettingsDraft = undefined;
          const key = isRevisionConflict(reason)
            ? 'errors.revision_conflict'
            : (errorKeyOf(reason, 'errors.request_failed') as LocaleKey);
          const message = i18n.t(key);
          notices.push(
            message,
            isRevisionConflict(reason)
              ? () => {
                  this.recognitionRevision++;
                  void store
                    .dispatch(
                      api.endpoints.getRecognitionSettings.initiate(undefined, {
                        forceRefetch: true,
                      }),
                    )
                    .unwrap()
                    .then(() => this.flushRecognitionSettings())
                    .catch((error: unknown) =>
                      reportClientLog(
                        'recognition_settings_load_failed',
                        'Recognition settings could not be read',
                        String(error),
                      ),
                    );
                }
              : undefined,
          );
          reportClientLog('recognition_settings_save_failed', message, String(reason));
        }
      }
    } finally {
      this.recognitionSaving = false;
      this.changed();
    }
  }
  /**
   * Announce a result where it arrives: the reader is often not on the recognition page, and an
   * announcement made from a page would repeat every time that page is remounted. Every finished
   * recognition says so — an import, a hotkey capture and a failure alike — while the log keeps the
   * failure record. The overlay reports stable short codes; anything else it sends is a raw
   * exception message, which stays out of the notice and only goes to the log.
   */
  private announceRecognition(result: RecognitionResult) {
    if (result.error === 'cancelled') return;
    if (result.error) {
      const key = `errors.recognition_${result.error}`;
      const message = i18n.exists(key)
        ? i18n.t(key as LocaleKey)
        : i18n.t('errors.recognition_failed');
      notices.push(message);
      reportClientLog('recognition_failed', message, result.error);
      return;
    }
    notices.push(
      i18n.t('recognition.completeNotice', { total: result.rows.length }),
      undefined,
      'success',
    );
  }
  async load(force = false) {
    this.loading = true;
    this.changed();
    try {
      await store
        .dispatch(api.endpoints.getOverlaySettings.initiate(undefined, { forceRefetch: force }))
        .unwrap();
      this.error = '';
    } catch (e) {
      this.error = errorKeyOf(e, 'errors.request_failed');
    } finally {
      this.loading = false;
      this.changed();
    }
    // The recognition rail is not fatal to the rest of the app, so it loads on its own and reports
    // through the log rather than the page-level error state.
    if (force || !this.recognitionSettings) {
      try {
        await store
          .dispatch(
            api.endpoints.getRecognitionSettings.initiate(undefined, { forceRefetch: force }),
          )
          .unwrap();
        this.changed();
      } catch (e) {
        reportClientLog(
          'recognition_settings_load_failed',
          'Recognition settings could not be read',
          String(e),
        );
      }
    }
  }
  /** Visibility belongs to the overlay, not to this copy: writing a stored `visible` back would
   *  hide a panel the user turned on with the shortcut. */
  private merged(changes: Partial<OverlaySettings>) {
    const settings = this.settings;
    if (!settings) return undefined;
    const visible = this.view?.connected ? { visible: this.view.visible } : {};
    return { ...settings, ...visible, ...changes };
  }
  update(changes: Partial<OverlaySettings>) {
    const next = this.merged(changes);
    if (!next) return;
    clearTimeout(this.soonTimer);
    this.settingsDraft = next;
    this.revision++;
    this.changed();
    void this.save();
  }
  /** For a control that reports continuously, like a dragged slider: the value lands at once and
   *  the write follows the last movement rather than every pixel of it. */
  updateSoon(changes: Partial<OverlaySettings>) {
    const next = this.merged(changes);
    if (!next) return;
    this.settingsDraft = next;
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
        const cached =
          api.endpoints.getOverlaySettings.select()(store.getState()).data ||
          (await store.dispatch(api.endpoints.getOverlaySettings.initiate(undefined)).unwrap());
        const saved = await store
          .dispatch(
            api.endpoints.updateOverlaySettings.initiate({
              value: this.settingsDraft!,
              revision: cached.revision,
              etag: cached.etag,
            }),
          )
          .unwrap();
        store.dispatch(api.util.updateQueryData('getOverlaySettings', undefined, () => saved));
        this.saved = revision;
        if (revision === this.revision) this.settingsDraft = undefined;
      }
      // Nothing pending means nothing was sent: clearing the error here would make a retry look
      // like it recovered when it never asked the server anything.
      if (this.saved >= this.revision && this.saved > 0) this.error = '';
    } catch (e) {
      if (isRevisionConflict(e)) store.dispatch(api.util.invalidateTags(['Settings']));
      this.error = isRevisionConflict(e)
        ? 'errors.revision_conflict'
        : errorKeyOf(e, 'errors.request_failed');
    } finally {
      this.saving = false;
      this.changed();
    }
  }
  /** Replays whatever failed: a pending save when there is one, otherwise a fresh read. */
  async retry() {
    if (this.error === 'errors.revision_conflict') {
      await store
        .dispatch(api.endpoints.getOverlaySettings.initiate(undefined, { forceRefetch: true }))
        .unwrap();
    }
    if (this.saved < this.revision) return this.save();
    return this.load();
  }
  async command(command: OverlayCommand) {
    try {
      await store.dispatch(api.endpoints.sendOverlayCommand.initiate(command)).unwrap();
      this.error = '';
    } catch (e) {
      this.error = errorKeyOf(e, 'errors.request_failed');
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
          const protocolVersion = String(e.status?.protocolVersion || '');
          if (protocolVersion !== ContractProtocolVersion) throw new Error('Unsupported protocol');
          if (e.type === 'resources_changed') {
            store.dispatch(api.util.invalidateTags(['Maps', 'Items', 'Preferences']));
          }
          if (e.type === 'items_changed') store.dispatch(api.util.invalidateTags(['Items']));
          if (e.type === 'annotations_changed' && e.mapId)
            store.dispatch(api.util.invalidateTags([{ type: 'Annotations', id: e.mapId }]));
          if (e.type === 'calibration_changed' && e.mapId)
            store.dispatch(
              api.util.invalidateTags([
                { type: 'Calibration', id: `${e.mapId}:svg` },
                { type: 'Calibration', id: `${e.mapId}:tiles` },
              ]),
            );
          if (e.overlaySettings || e.recognitionSettings || e.gameMonitorSettings)
            store.dispatch(api.util.invalidateTags(['Settings']));
          if (e.multiplayerStatus) store.dispatch(api.util.invalidateTags(['Multiplayer']));
          gameMonitor.handleEvent(e);
          if (e.multiplayerStatus) multiplayer.handleStatus(e.multiplayerStatus);
          this.connectedOnce = true;
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
          if (e.recognitionStart) {
            this.activeRecognitionId = e.recognitionStart.requestId;
            this.recognitionPending = true;
            this.recognitionResult = undefined;
          }
          if (e.type === 'recognition_cleared') {
            this.activeRecognitionId = '';
            this.recognitionPending = false;
            this.recognitionResult = undefined;
          }
          if (
            e.recognitionResult &&
            (e.type === 'snapshot' || e.recognitionResult.requestId === this.activeRecognitionId)
          ) {
            this.activeRecognitionId = '';
            this.recognitionPending = false;
            this.recognitionResult = e.recognitionResult;
            // A snapshot is what a reload sees: restoring the last result must not announce it again.
            if (e.type !== 'snapshot') this.announceRecognition(e.recognitionResult);
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
  useSelector(api.endpoints.getOverlaySettings.select());
  useSelector(api.endpoints.getRecognitionSettings.select());
  useSelector((state: RootState) => state.client.overlay);
  useSyncExternalStore(overlay.subscribe, overlay.snapshot);
  return overlay;
}
