import { useEffect, useState } from 'react';
import type { MapData, MapSummary } from '../../../../contracts/ts/ipc.gen';
import { useOverlay } from '../../stores/overlayStore';
import { useGameMonitor } from '../../stores/gameMonitorStore';
import { notices } from '../../stores/noticeStore';
import {
  isUsableMapCatalog,
  isUsableMapData,
  request,
  resetUserSettings,
} from '../../stores/workspaceStore';
import { useLocale, type LocaleKey } from '../../hooks/useLocale';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorState } from '../../components/ErrorState';
import { FileWarning } from 'lucide-react';
import '../../styles/settings.css';
import { DataLoadError } from '../../lib/errors';
import { RecognitionSettingsTab } from './tabs/RecognitionSettingsTab';
import { HotkeysSettingsTab } from './tabs/HotkeysSettingsTab';
import { MapSettingsTab } from './tabs/MapSettingsTab';
import { SystemSettingsTab } from './tabs/SystemSettingsTab';
import { settingsTabs, type SettingsTab } from './types';

export function SettingsPage({ initialTab }: { initialTab?: SettingsTab }) {
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
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? settingsTabs[0]);
  // The recognition page jumps straight to its own tab.
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
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
      notices.push(t(monitor.error as LocaleKey));
  }, [monitor.error, t]);
  useEffect(() => {
    if (view?.error) notices.push(t('settings.nativeError', { error: t(view.error as LocaleKey) }));
  }, [view?.error, t]);
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
          t(
            error instanceof Error
              ? (error.message as LocaleKey)
              : 'errors.data_directory_open_failed',
          ),
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
            (message === 'errors.user_settings_reset_failed'
              ? 'settingsError.resetFailed'
              : message || 'settingsError.resetFailed') as LocaleKey,
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
            {tab === 'recognition' ? (
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
