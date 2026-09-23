import { useEffect, useState } from 'react';
import type { MapData, MapSummary, OverlaySettings } from '../../../../contracts/ts/ipc.gen';
import { OverlaySettingsLimits, OverlayViewLimits } from '../../../../contracts/ts/ipc.gen';
import { useOverlay } from '../../stores/overlayStore';
import { useGameMonitor } from '../../stores/gameMonitorStore';
import { notices } from '../../stores/noticeStore';
import {
  isUsableMapCatalog,
  isUsableMapData,
  request,
  resetUserSettings,
} from '../../stores/workspaceStore';
import { useLocale } from '../../hooks/useLocale';
import { NumberStepper } from '../../components/NumberStepper';
import { HotkeyRecorder } from '../../components/HotkeyRecorder';
import { AppTooltip, HintTooltip } from '../../components/HintTooltip';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorState } from '../../components/ErrorState';
import { formatCoordinate, resizeOverlay } from '../../lib/overlayScale';
import { Check, FileWarning, Link2, Unlink2 } from 'lucide-react';
import '../../styles/settings.css';
import { DataLoadError } from '../../lib/errors';

// Declaration order matches the contract: the overlay reports a refused shortcut by the field name
// and the backend validates duplicates across the whole set.
const hotkeyKeys = [
  'toggleEdit',
  'toggleVisible',
  'zoomIn',
  'zoomOut',
  'floorUp',
  'floorDown',
  'toggleBasemap',
  'panUp',
  'panDown',
  'panLeft',
  'panRight',
] as const;
type HotkeyKey = (typeof hotkeyKeys)[number];

export function SettingsPage() {
  const { t } = useLocale();
  const store = useOverlay();
  const monitor = useGameMonitor();
  const value = store.settings;
  const view = store.view;
  const settingsLoadError =
    !value && !store.loading
      ? store.error
      : !monitor.settings && !monitor.loading
        ? monitor.error
        : '';
  const [tab, setTab] = useState<'map' | 'hotkeys' | 'gameMonitor'>('map');
  const [catalog, setCatalog] = useState<MapSummary[]>([]);
  const [map, setMap] = useState<MapData>();
  const [mapId, setMapId] = useState('');
  const [loadError, setLoadError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  useEffect(() => {
    let active = true;
    void request<unknown>('/api/maps')
      .then((next) => {
        if (!isUsableMapCatalog(next)) throw new DataLoadError('errors.data_version', 'settings');
        if (active) setCatalog(next);
      })
      .catch((error: unknown) => {
        if (active)
          setLoadError(error instanceof DataLoadError ? error.errorKey : 'errors.request_failed');
      });
    return () => {
      active = false;
    };
  }, [reloadToken]);
  useEffect(() => {
    if (!view?.mapId) return;
    const controller = new AbortController();
    void request<unknown>(`/api/maps/${view.mapId}`, { signal: controller.signal })
      .then((value) => {
        if (!isUsableMapData(value)) throw new DataLoadError('errors.map_data_invalid', 'settings');
        setLoadError('');
        setMap(value);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(error instanceof DataLoadError ? error.errorKey : 'errors.request_failed');
      });
    return () => controller.abort();
  }, [reloadToken, view?.mapId]);
  useEffect(() => {
    if (monitor.error && monitor.error !== 'errors.user_settings_invalid')
      notices.push(t(monitor.error));
  }, [monitor.error, t]);
  useEffect(() => {
    if (view?.error) notices.push(t('settings.nativeError', { error: t(view.error) }));
  }, [view?.error, t]);
  const update = (v: Partial<OverlaySettings>) => store.update(v);
  // A dragged slider reports on every pixel; the write follows the last of them.
  const updateSoon = (v: Partial<OverlaySettings>) => store.updateSoon(v);
  // Window visibility and edit mode belong to the overlay: ask it, and let its report update the UI.
  const setVisible = (visible: boolean) => {
    if (view?.connected) void store.command({ kind: 'visible', enabled: visible });
    else update({ visible });
  };
  const check = (key: 'followCenter' | 'followFloor' | 'followZoom' | 'devPlayerEnabled') => (
    <label className="settings-check">
      <input
        type="checkbox"
        checked={!!value?.[key]}
        onChange={(e) => update({ [key]: e.target.checked })}
      />
      {t(`settings.${key}`)}
    </label>
  );
  const selectedMap = mapId || view?.mapId || catalog[0]?.id || '';
  const override = value?.mapZooms.find((z) => z.mapId === selectedMap);
  const viewZoomMin = map?.tiles.length ? Math.min(...map.tiles.map((tile) => tile.minZoom)) : -10;
  const viewZoomMax = map?.tiles.length
    ? Math.min(12, Math.max(...map.tiles.map((tile) => tile.maxZoom)) + 1)
    : 4;
  // The current view reports the map's own bounds, not the settings' -10..12.
  const viewZoomLimit = { ...OverlayViewLimits.zoom, min: viewZoomMin, max: viewZoomMax };
  const zoomValue = (zoom: number) =>
    Number(zoom.toFixed(OverlaySettingsLimits.targetZoom.precision));
  // A duplicate is a property of the values, not of the moment it was typed: both fields that hold
  // the same combination are flagged, and either one clearing it clears both.
  const hotkeyConflict = (key: HotkeyKey) => {
    const combo = value?.hotkeys[key];
    return !!combo && hotkeyKeys.some((other) => other !== key && value?.hotkeys[other] === combo);
  };
  // Registration failures come back from the overlay per field; a duplicate never reaches Windows,
  // so its own message would be the misleading "another program holds it".
  const hotkeyError = (key: HotkeyKey) =>
    !hotkeyConflict(key) && (view?.hotkeyFailed ?? []).includes(key)
      ? t('errors.overlay_hotkey_unavailable')
      : undefined;
  // Windows swallows a registered hot key before the browser sees it, so the overlay has to let go
  // of them while a shortcut is being recorded — otherwise its own combinations cannot be typed.
  const recordHotkeys = (recording: boolean) => {
    if (view?.connected) void store.command({ kind: 'hotkeys', enabled: !recording });
  };
  const retrySettingsLoad = () => {
    void store.load();
    void monitor.initialize();
  };
  const retrySettingsPage = () => {
    setLoadError('');
    setReloadToken((value) => value + 1);
    retrySettingsLoad();
  };
  const openUserSettingsDirectory = () => {
    void fetch('/api/data/open-user-settings')
      .then((response) => {
        if (!response.ok) throw new Error('errors.data_directory_open_failed');
      })
      .catch((error: unknown) =>
        notices.push(
          t(error instanceof Error ? error.message : 'errors.data_directory_open_failed'),
        ),
      );
  };
  const resetSettings = () => {
    setConfirmReset(false);
    setResetting(true);
    void resetUserSettings()
      .then(() => Promise.all([store.load(), monitor.initialize()]))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        notices.push(
          t(
            message === 'errors.user_settings_reset_failed'
              ? 'settingsError.resetFailed'
              : message || 'settingsError.resetFailed',
          ),
        );
      })
      .finally(() => setResetting(false));
  };
  const settingsErrorActions =
    settingsLoadError === 'errors.user_settings_invalid'
      ? [
          { label: t('common.retry'), onClick: retrySettingsPage },
          { label: t('settingsError.openDirectory'), onClick: openUserSettingsDirectory },
          {
            label: resetting ? t('settingsError.resetting') : t('settingsError.reset'),
            onClick: () => setConfirmReset(true),
            danger: true,
          },
        ]
      : [{ label: t('common.retry'), onClick: retrySettingsPage }];
  const pageError = settingsLoadError || loadError;
  const isUserSettingsInvalid = settingsLoadError === 'errors.user_settings_invalid';
  const pageErrorState = pageError ? (
    <ErrorState
      icon={FileWarning}
      tone={isUserSettingsInvalid ? 'data' : 'network'}
      title={isUserSettingsInvalid ? t('settingsError.title') : t('settingsError.pageTitle')}
      description={
        isUserSettingsInvalid ? t('settingsError.description') : t('settingsError.pageDescription')
      }
      actions={settingsErrorActions}
    />
  ) : null;
  return (
    <section className={`settings-page${pageError ? ' settings-page--blocked' : ''}`}>
      {pageError ? (
        pageErrorState
      ) : (
        <>
          <aside className="settings-tabs" role="tablist" aria-label={t('nav.settings')}>
            {(['map', 'hotkeys', 'gameMonitor'] as const).map((key) => (
              <button
                key={key}
                id={`settings-tab-${key}`}
                role="tab"
                aria-selected={tab === key}
                aria-controls="settings-panel"
                className={tab === key ? 'active' : ''}
                onClick={() => setTab(key)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const next =
                      key === 'map' ? 'hotkeys' : key === 'hotkeys' ? 'gameMonitor' : 'map';
                    setTab(next);
                    document.getElementById(`settings-tab-${next}`)?.focus();
                  }
                }}
              >
                {t(`settings.${key}`)}
              </button>
            ))}
          </aside>
          <div
            className="settings-content"
            id="settings-panel"
            role="tabpanel"
            aria-labelledby={`settings-tab-${tab}`}
          >
            <h1>{t(`settings.${tab}`)}</h1>
            {pageError ? (
              <ErrorState
                icon={FileWarning}
                tone={isUserSettingsInvalid ? 'data' : 'network'}
                title={
                  isUserSettingsInvalid ? t('settingsError.title') : t('settingsError.pageTitle')
                }
                description={
                  isUserSettingsInvalid
                    ? t('settingsError.description')
                    : t('settingsError.pageDescription')
                }
                actions={settingsErrorActions}
              />
            ) : tab === 'gameMonitor' ? (
              <>
                <fieldset>
                  <legend>{t('settings.gameMonitor')}</legend>
                  <div className="settings-field settings-path-field">
                    <label htmlFor="monitor-screenshot-directory">
                      {t('settings.screenshotDirectory')}
                    </label>
                    <input
                      id="monitor-screenshot-directory"
                      value={monitor.settings?.screenshotDirectory || ''}
                      readOnly
                      placeholder={t('settings.monitorUnavailable')}
                    />
                    <button
                      type="button"
                      disabled={monitor.browsing.screenshots}
                      onClick={() => void monitor.browse('screenshots')}
                    >
                      {t('settings.browse')}
                    </button>
                    <Check
                      className={`monitor-ready${monitor.status?.screenshotWatching ? ' is-active' : ''}`}
                      size={16}
                      aria-label={t('settings.monitorReady')}
                      aria-hidden={!monitor.status?.screenshotWatching}
                    />
                  </div>
                  <div className="settings-field settings-path-field">
                    <label htmlFor="monitor-log-directory">{t('settings.logDirectory')}</label>
                    <input
                      id="monitor-log-directory"
                      value={monitor.settings?.logDirectory || ''}
                      readOnly
                      placeholder={t('settings.monitorUnavailable')}
                    />
                    <button
                      type="button"
                      disabled={monitor.browsing.logs}
                      onClick={() => void monitor.browse('logs')}
                    >
                      {t('settings.browse')}
                    </button>
                    <Check
                      className={`monitor-ready${monitor.status?.logWatching ? ' is-active' : ''}`}
                      size={16}
                      aria-label={t('settings.monitorReady')}
                      aria-hidden={!monitor.status?.logWatching}
                    />
                  </div>
                </fieldset>
              </>
            ) : !value ? (
              <p>{t('common.loading')}</p>
            ) : tab === 'hotkeys' ? (
              <fieldset>
                <legend>{t('settings.hotkeyGroup')}</legend>
                {hotkeyKeys.map((key) => (
                  <HotkeyRecorder
                    key={key}
                    label={t(`settings.hotkeyAction.${key}`)}
                    value={value.hotkeys[key]}
                    error={hotkeyError(key)}
                    conflict={hotkeyConflict(key)}
                    onRecording={recordHotkeys}
                    onChange={(hotkey) => update({ hotkeys: { ...value.hotkeys, [key]: hotkey } })}
                  />
                ))}
                {!view?.connected && <p>{t('settings.unavailable')}</p>}
              </fieldset>
            ) : (
              <>
                <fieldset>
                  <legend>{t('settings.appearance')}</legend>
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={view?.connected ? view.visible : value.visible}
                      onChange={(e) => setVisible(e.target.checked)}
                    />
                    {t('settings.visible')}
                  </label>
                  <div className="settings-field">
                    <label htmlFor="settings-opacity">{t('settings.opacity')}</label>
                    <span className="settings-slider">
                      <input
                        id="settings-opacity"
                        type="range"
                        min={OverlaySettingsLimits.opacity.min}
                        max={OverlaySettingsLimits.opacity.max}
                        step={OverlaySettingsLimits.opacity.step}
                        value={value.opacity ?? OverlaySettingsLimits.opacity.max}
                        onChange={(e) => updateSoon({ opacity: Number(e.target.value) })}
                      />
                      <output htmlFor="settings-opacity">
                        {value.opacity ?? OverlaySettingsLimits.opacity.max}%
                      </output>
                    </span>
                  </div>
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={value.backdrop}
                      onChange={(e) => update({ backdrop: e.target.checked })}
                    />
                    {t('settings.backdrop')}
                  </label>
                  <div className="settings-field">
                    <label htmlFor="settings-shape">{t('settings.shape')}</label>
                    <select
                      id="settings-shape"
                      value={value.shape}
                      onChange={(e) =>
                        update({ shape: e.target.value as OverlaySettings['shape'] })
                      }
                    >
                      <option value="square">{t('settings.square')}</option>
                      <option value="circle">{t('settings.circle')}</option>
                    </select>
                  </div>
                  <div className="size-fields">
                    <NumberStepper
                      label={t('settings.width')}
                      value={value.width}
                      limit={OverlaySettingsLimits.width}
                      onChange={(width) => update(resizeOverlay(value, 'width', width))}
                    />
                    {value.shape === 'square' && (
                      <div className="aspect-row">
                        <span className="aspect-spacer" aria-hidden="true">
                          {t('settings.width')}
                        </span>
                        <span className="aspect-track">
                          <button
                            className={`aspect-link ${value.lockAspect ? 'active' : ''}`}
                            aria-label={t('settings.lockAspect')}
                            title={t('settings.lockAspect')}
                            aria-pressed={value.lockAspect}
                            onClick={() => update({ lockAspect: !value.lockAspect })}
                          >
                            {value.lockAspect ? <Link2 size={14} /> : <Unlink2 size={14} />}
                          </button>
                        </span>
                      </div>
                    )}
                    <NumberStepper
                      label={t('settings.height')}
                      value={value.height}
                      limit={OverlaySettingsLimits.height}
                      onChange={(height) => update(resizeOverlay(value, 'height', height))}
                    />
                  </div>
                  <div className="settings-field">
                    <label htmlFor="settings-resolution">
                      <HintTooltip content={t('settings.svgResolutionHint')}>
                        {t('settings.svgQualityMode')}
                      </HintTooltip>
                    </label>
                    <select
                      id="settings-resolution"
                      value={value.svgQualityMode === 'auto' ? 'auto' : String(value.svgResolution)}
                      onChange={(e) =>
                        update(
                          e.target.value === 'auto'
                            ? { svgQualityMode: 'auto' }
                            : { svgQualityMode: 'fixed', svgResolution: Number(e.target.value) },
                        )
                      }
                    >
                      <option value="auto">{t('settings.svgQualityAuto')}</option>
                      {[1024, 2048, 4096, 8192].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                </fieldset>
                <fieldset>
                  <legend>{t('settings.follow')}</legend>
                  <span
                    className={`settings-check-wrap${monitor.status?.logWatching ? '' : ' is-disabled'}`}
                  >
                    {monitor.status?.logWatching ? (
                      <label className="settings-check">
                        <input
                          type="checkbox"
                          checked={!!monitor.settings?.autoMapSwitch}
                          onChange={(e) => void monitor.update({ autoMapSwitch: e.target.checked })}
                        />
                        {t('settings.autoMapSwitch')}
                      </label>
                    ) : (
                      <AppTooltip content={t('settings.noMonitorDirectory')}>
                        <label className="settings-check" aria-disabled="true">
                          <input
                            type="checkbox"
                            disabled
                            checked={!!monitor.settings?.autoMapSwitch}
                          />
                          {t('settings.autoMapSwitch')}
                        </label>
                      </AppTooltip>
                    )}
                  </span>
                  <span
                    className={`settings-check-wrap${monitor.status?.screenshotWatching ? '' : ' is-disabled'}`}
                  >
                    {monitor.status?.screenshotWatching ? (
                      <label className="settings-check">
                        <input
                          type="checkbox"
                          checked={!!monitor.settings?.deleteScreenshots}
                          onChange={(e) =>
                            void monitor.update({ deleteScreenshots: e.target.checked })
                          }
                        />
                        {t('settings.deleteScreenshots')}
                      </label>
                    ) : (
                      <AppTooltip content={t('settings.noMonitorDirectory')}>
                        <label className="settings-check" aria-disabled="true">
                          <input
                            type="checkbox"
                            disabled
                            checked={!!monitor.settings?.deleteScreenshots}
                          />
                          {t('settings.deleteScreenshots')}
                        </label>
                      </AppTooltip>
                    )}
                  </span>
                  {check('followCenter')}
                  {check('followFloor')}
                  {check('followZoom')}
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={!value.perMapZoom}
                      onChange={(e) => update({ perMapZoom: !e.target.checked })}
                    />
                    {t('settings.perMapZoom')}
                  </label>
                  {value.perMapZoom && (
                    <div className="settings-field">
                      <label htmlFor="settings-map">{t('settings.map')}</label>
                      <select
                        id="settings-map"
                        value={selectedMap}
                        onChange={(e) => setMapId(e.target.value)}
                      >
                        {catalog.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {/* One control, two bindings: unified writes the global target zoom, per-map writes
                  the entry for the map picked above. */}
                  <NumberStepper
                    label={t('settings.targetZoom')}
                    value={
                      value.perMapZoom ? (override?.zoom ?? value.targetZoom) : value.targetZoom
                    }
                    limit={OverlaySettingsLimits.targetZoom}
                    onChange={(zoom) =>
                      update(
                        value.perMapZoom
                          ? {
                              mapZooms: [
                                ...value.mapZooms.filter((z) => z.mapId !== selectedMap),
                                { mapId: selectedMap, zoom },
                              ],
                            }
                          : { targetZoom: zoom },
                      )
                    }
                  />
                  {/* Copies the overlay's live zoom into whatever the stepper above is bound to, so the
                  per-map case lands on the map picked in the selector rather than on whichever map
                  the overlay happens to be showing. */}
                  <button
                    disabled={!view?.connected}
                    onClick={() => {
                      if (!view) return;
                      if (value.perMapZoom)
                        update({
                          mapZooms: [
                            ...value.mapZooms.filter((z) => z.mapId !== selectedMap),
                            { mapId: selectedMap, zoom: zoomValue(view.zoom) },
                          ],
                        });
                      else update({ targetZoom: zoomValue(view.zoom) });
                    }}
                  >
                    {t('settings.useCurrent')}
                  </button>
                </fieldset>
                <fieldset>
                  <legend>{t('settings.window')}</legend>
                  <div className="readonly-values">
                    <span>
                      {t('settings.left')} <b>{value.left}</b>
                    </span>
                    <span>
                      {t('settings.top')} <b>{value.top}</b>
                    </span>
                  </div>
                  <button
                    disabled={!view?.connected}
                    aria-pressed={!!view?.editing}
                    onClick={() => void store.command({ kind: 'edit', enabled: !view?.editing })}
                  >
                    {t(view?.editing ? 'settings.exitEdit' : 'settings.enterEdit')}
                  </button>
                </fieldset>
                <fieldset disabled={!view?.connected}>
                  <legend>{t('settings.viewport')}</legend>
                  <div className="readonly-values">
                    <span>
                      {t('settings.centerX')} <b>{formatCoordinate(view?.center.x || 0)}</b>
                    </span>
                    <span>
                      {t('settings.centerY')} <b>{formatCoordinate(view?.center.y || 0)}</b>
                    </span>
                  </div>
                  <NumberStepper
                    label={t('settings.zoom')}
                    value={view?.zoom || 0}
                    limit={viewZoomLimit}
                    onChange={(zoom) => void store.command({ kind: 'view', zoom })}
                  />
                  <div className="settings-field">
                    <label htmlFor="settings-floor">{t('settings.floor')}</label>
                    <select
                      id="settings-floor"
                      value={view?.floorId || ''}
                      onChange={(e) =>
                        void store.command({ kind: 'view', floorId: e.target.value })
                      }
                    >
                      {map?.floors.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </fieldset>
                <fieldset>
                  <legend>{t('settings.development')}</legend>
                  {check('devPlayerEnabled')}
                </fieldset>
              </>
            )}
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirmReset}
        title={t('settingsError.resetTitle')}
        message={t('settingsError.resetConfirm')}
        confirmLabel={t('settingsError.resetConfirmButton')}
        danger
        onConfirm={resetSettings}
        onCancel={() => setConfirmReset(false)}
      />
    </section>
  );
}
