import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { useOverlay } from '../../stores/overlayStore';
import { useGameMonitor } from '../../stores/gameMonitorStore';
import { notices } from '../../stores/noticeStore';
import {
  isUsableMapCatalog,
  isUsableMapData,
  resetUserSettings,
} from '../../stores/workspaceStore';
import { api, useGetMapCatalogQuery, useGetMapQuery } from '../../stores/api';
import { store as reduxStore } from '../../stores/store';
import {
  clearConflict,
  pauseConflict,
  setCalibrationPreferencesDraft,
  setMapPreferencesDraft,
  submitCalibrationPreferences,
  submitMapPreferences,
} from '../../stores/clientState';
import type { RootState } from '../../stores/store';
import { useLocale, type LocaleKey } from '../../hooks/useLocale';
import { errorKeyOf } from '../../lib/errors';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorState } from '../../components/ErrorState';
import { FileWarning } from 'lucide-react';
import '../../styles/settings.css';
import { RecognitionSettingsTab } from './tabs/RecognitionSettingsTab';
import { HotkeysSettingsTab } from './tabs/HotkeysSettingsTab';
import { MapSettingsTab } from './tabs/MapSettingsTab';
import { SystemSettingsTab } from './tabs/SystemSettingsTab';
import { DataManagementTab } from './tabs/DataManagementTab';
import { settingsTabs, type SettingsTab } from './types';

export function SettingsPage({ initialTab }: { initialTab?: SettingsTab }) {
  const { t, locale } = useLocale();
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
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? settingsTabs[0]);
  // The recognition page jumps straight to its own tab.
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  const catalogQuery = useGetMapCatalogQuery(locale);
  const catalog = isUsableMapCatalog(catalogQuery.data) ? catalogQuery.data : [];
  const mapQuery = useGetMapQuery({ id: view?.mapId || '', locale }, { skip: !view?.mapId });
  const map = isUsableMapData(mapQuery.data) ? mapQuery.data : undefined;
  const mapPreferencesConflict = useSelector((state: RootState) =>
    state.client.conflicts.find((item) => item.key === 'map-preferences'),
  );
  const calibrationPreferencesConflict = useSelector((state: RootState) =>
    state.client.conflicts.find((item) => item.key === 'calibration-preferences'),
  );
  const gameMonitorConflict = useSelector((state: RootState) =>
    state.client.conflicts.find((item) => item.key === 'game-monitor-settings'),
  );
  const [mapId, setMapId] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  useEffect(() => {
    if (monitor.error && monitor.error !== 'errors.user_settings_invalid')
      notices.push(t(monitor.error as LocaleKey));
  }, [monitor.error, t]);
  useEffect(() => {
    if (view?.error) notices.push(t('minimap.nativeError', { error: t(view.error as LocaleKey) }));
  }, [view?.error, t]);
  const retrySettingsLoad = () => {
    void store.load();
    void monitor.initialize();
  };
  const retrySettingsPage = () => {
    void catalogQuery.refetch();
    if (view?.mapId) void mapQuery.refetch();
    retrySettingsLoad();
  };
  const openUserSettingsDirectory = () => {
    void reduxStore
      .dispatch(api.endpoints.openDataDirectory.initiate('user-settings'))
      .unwrap()
      .catch(() => notices.push(t('errors.data_directory_open_failed')));
  };
  const resetSettings = () => {
    setConfirmReset(false);
    setResetting(true);
    void resetUserSettings()
      .then(() => Promise.all([store.load(true), monitor.initialize()]))
      .catch((error: unknown) => {
        const message = errorKeyOf(error, '');
        notices.push(
          t(
            (message === 'errors.user_settings_reset_failed'
              ? 'settings.pageError.resetFailed'
              : message || 'settings.pageError.resetFailed') as LocaleKey,
          ),
        );
      })
      .finally(() => setResetting(false));
  };
  const settingsErrorActions =
    settingsLoadError === 'errors.user_settings_invalid'
      ? [
          { label: t('common.retry'), onClick: retrySettingsPage },
          { label: t('settings.pageError.openDirectory'), onClick: openUserSettingsDirectory },
          {
            label: resetting ? t('settings.pageError.resetting') : t('settings.pageError.reset'),
            onClick: () => setConfirmReset(true),
            danger: true,
          },
        ]
      : [{ label: t('common.retry'), onClick: retrySettingsPage }];
  const mapLoadError =
    !catalogQuery.isLoading && catalogQuery.isError
      ? 'errors.request_failed'
      : catalogQuery.data && !isUsableMapCatalog(catalogQuery.data)
        ? 'errors.data_version'
        : mapQuery.isError
          ? 'errors.request_failed'
          : mapQuery.data && !isUsableMapData(mapQuery.data)
            ? 'errors.map_data_invalid'
            : '';
  const pageError = settingsLoadError || mapLoadError;
  const isUserSettingsInvalid = settingsLoadError === 'errors.user_settings_invalid';
  const pageErrorState = pageError ? (
    <ErrorState
      icon={FileWarning}
      tone={isUserSettingsInvalid ? 'data' : 'network'}
      title={
        isUserSettingsInvalid ? t('settings.pageError.title') : t('settings.pageError.pageTitle')
      }
      description={
        isUserSettingsInvalid
          ? t('settings.pageError.description')
          : t('settings.pageError.pageDescription')
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
            {settingsTabs.map((key) => (
              <button
                key={key}
                id={`settings-tab-${key}`}
                role="tab"
                aria-selected={tab === key}
                aria-controls="settings-panel"
                className={tab === key ? 'active' : ''}
                onClick={() => setTab(key)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : settingsTabs.length - 1;
                  const next =
                    settingsTabs[(settingsTabs.indexOf(key) + step) % settingsTabs.length];
                  setTab(next);
                  document.getElementById(`settings-tab-${next}`)?.focus();
                }}
              >
                {t(`settings.tabs.${key}`)}
              </button>
            ))}
            <div className="settings-tab-actions">
              <button disabled={resetting} onClick={() => setConfirmReset(true)}>
                {resetting ? t('settings.pageError.resetting') : t('settings.pageError.reset')}
              </button>
            </div>
          </aside>
          <div
            className="settings-content"
            id="settings-panel"
            role="tabpanel"
            aria-labelledby={`settings-tab-${tab}`}
          >
            {mapPreferencesConflict && (
              <div className="settings-conflict" role="alert">
                <span>{t('errors.revision_conflict')}</span>
                <button
                  type="button"
                  onClick={() => reduxStore.dispatch(pauseConflict('map-preferences'))}
                >
                  {t('errors.conflict_keep_local')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void reduxStore
                      .dispatch(
                        api.endpoints.getMapPreferences.initiate(undefined, { forceRefetch: true }),
                      )
                      .unwrap()
                      .then(() => {
                        reduxStore.dispatch(setMapPreferencesDraft(undefined));
                        reduxStore.dispatch(clearConflict('map-preferences'));
                      })
                  }
                >
                  {t('errors.conflict_load_remote')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void reduxStore
                      .dispatch(
                        api.endpoints.getMapPreferences.initiate(undefined, { forceRefetch: true }),
                      )
                      .unwrap()
                      .then(() => reduxStore.dispatch(submitMapPreferences()))
                  }
                >
                  {t('errors.conflict_retry')}
                </button>
              </div>
            )}
            {calibrationPreferencesConflict && (
              <div className="settings-conflict" role="alert">
                <span>{t('errors.revision_conflict')}</span>
                <button
                  type="button"
                  onClick={() => reduxStore.dispatch(pauseConflict('calibration-preferences'))}
                >
                  {t('errors.conflict_keep_local')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void reduxStore
                      .dispatch(
                        api.endpoints.getCalibrationPreferences.initiate(undefined, {
                          forceRefetch: true,
                        }),
                      )
                      .unwrap()
                      .then(() => {
                        reduxStore.dispatch(setCalibrationPreferencesDraft(undefined));
                        reduxStore.dispatch(clearConflict('calibration-preferences'));
                      })
                  }
                >
                  {t('errors.conflict_load_remote')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void reduxStore
                      .dispatch(
                        api.endpoints.getCalibrationPreferences.initiate(undefined, {
                          forceRefetch: true,
                        }),
                      )
                      .unwrap()
                      .then(() => reduxStore.dispatch(submitCalibrationPreferences()))
                  }
                >
                  {t('errors.conflict_retry')}
                </button>
              </div>
            )}
            {gameMonitorConflict && (
              <div className="settings-conflict" role="alert">
                <span>{t('errors.revision_conflict')}</span>
                <button
                  type="button"
                  onClick={() => reduxStore.dispatch(pauseConflict('game-monitor-settings'))}
                >
                  {t('errors.conflict_keep_local')}
                </button>
                <button type="button" onClick={() => monitor.discardConflict()}>
                  {t('errors.conflict_load_remote')}
                </button>
                <button type="button" onClick={() => void monitor.retry()}>
                  {t('errors.conflict_retry')}
                </button>
              </div>
            )}
            <h1>{t(`settings.tabs.${tab}`)}</h1>
            {tab === 'data' ? (
              <DataManagementTab />
            ) : tab === 'recognition' ? (
              <RecognitionSettingsTab />
            ) : !value ? (
              <p>{t('common.loading')}</p>
            ) : tab === 'hotkeys' ? (
              <HotkeysSettingsTab
                value={value}
                view={view}
                onUpdate={(changes) => store.update(changes)}
                onRecording={(recording) => {
                  if (view?.connected) void store.command({ kind: 'hotkeys', enabled: !recording });
                }}
              />
            ) : tab === 'system' ? (
              <SystemSettingsTab />
            ) : (
              <MapSettingsTab
                value={value}
                view={view}
                monitorSettings={monitor.settings}
                monitorStatus={monitor.status}
                catalog={catalog}
                map={map}
                mapId={mapId}
                onMapIdChange={setMapId}
                onUpdate={(changes) => store.update(changes)}
                onUpdateSoon={(changes) => store.updateSoon(changes)}
                onCommand={(command) => void store.command(command)}
                onMonitorUpdate={(changes) => void monitor.update(changes)}
              />
            )}
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirmReset}
        title={t('settings.pageError.resetTitle')}
        message={t('settings.pageError.resetConfirm')}
        confirmLabel={t('settings.pageError.resetConfirmButton')}
        danger
        onConfirm={resetSettings}
        onCancel={() => setConfirmReset(false)}
      />
    </section>
  );
}
