import { useEffect, useRef, useState } from 'react';
import { MapPage } from '../pages/map/MapPage';
import { CalibratorPage } from '../pages/calibrator/CalibratorPage';
import { SettingsPage } from '../pages/settings/SettingsPage';
import { AppHeader, type AppPage } from '../components/AppHeader';
import { NoticeHost } from '../components/Notice';
import { workspace, loadUserSettings, setLocale } from '../stores/workspaceStore';
import { useLocale, type LocaleKey } from '../hooks/useLocale';
import { Check, Radio } from 'lucide-react';
import i18n from '../i18n';
import { gameMonitor } from '../stores/gameMonitorStore';
import { useGlobalErrorRecovery } from '../hooks/useGlobalErrorRecovery';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DataLoadError } from '../lib/errors';
import { notices } from '../stores/noticeStore';
import { ItemsPage } from '../pages/items/ItemsPage';
import { api } from '../stores/api';
import { store } from '../stores/store';

type SettingsTab = 'system' | 'map' | 'recognition' | 'hotkeys';

export function AppShell() {
  const [page, setPage] = useState<AppPage>('map');
  // Which settings tab a jump lands on: the map opens its own, the items page the recognition tab.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('system');
  // Resetting module data is destructive, so it asks with the app's own dialog instead of the
  // browser's default confirm.
  const [pendingReset, setPendingReset] = useState<'calibrator' | 'settings' | null>(null);
  const { t } = useLocale();
  const recovery = useGlobalErrorRecovery();
  const { overlay, monitor, failed, saving, workspace: w } = recovery;
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      // The interface language lives in user settings: apply it before the workspace loads so the
      // map catalog and map data are fetched in the language the UI renders in.
      void loadUserSettings()
        .then((settings) => {
          void i18n.changeLanguage(settings.language);
          setLocale(settings.language);
        })
        .catch(() => {})
        .finally(() => void workspace.initialize());
      void gameMonitor.initialize();
    }
    const disconnect = overlay.connect();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (workspace.unsaved) event.preventDefault();
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') {
        void workspace.savePreferences();
        void workspace.saveCalibratorPreferences();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      disconnect();
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [overlay]);
  useEffect(() => {
    if (monitor.resourceRevision > 0) void workspace.reloadForResources();
  }, [monitor.resourceRevision]);
  useEffect(() => {
    const id = monitor.status?.mapId;
    if (
      monitor.mapRevision > 0 &&
      id &&
      w.catalog.some((map) => map.id === id) &&
      w.activeId !== id
    )
      void workspace.select(id, true);
  }, [monitor.mapRevision]); // eslint-disable-line react-hooks/exhaustive-deps
  const navigate = (next: typeof page) => {
    setPage(next);
  };
  const openSettings = (tab: SettingsTab) => {
    setSettingsTab(tab);
    setPage('settings');
  };
  const openDataDirectory = () => {
    void store
      .dispatch(api.endpoints.openDataDirectory.initiate('user-settings'))
      .unwrap()
      .catch(() => notices.push(t('errors.data_directory_open_failed')));
  };
  const resetModuleData = (module: 'map' | 'calibrator' | 'settings') => {
    const reset =
      module === 'settings'
        ? store.dispatch(api.endpoints.resetUserSettings.initiate()).unwrap()
        : store
            .dispatch(
              api.endpoints.resetData.initiate(
                module === 'calibrator' ? 'calibration' : 'map-preferences',
              ),
            )
            .unwrap();
    void reset
      .then(() => workspace.initialize())
      .catch(() => notices.push(t('errors.data_reset_failed')));
  };
  const boundaryActions = (module: 'calibrator' | 'settings') => ({
    onOpenDirectory: (_error: DataLoadError) => openDataDirectory(),
    onResetData: (_error: DataLoadError) => setPendingReset(module),
  });
  return (
    <main className="app-shell">
      <NoticeHost />
      <ErrorBoundary module="app" onRetry={() => window.location.reload()}>
        <AppHeader
          active={page}
          onNavigate={navigate}
          mode={monitor.settings?.mode || monitor.status?.mode || 'pvp'}
          onModeChange={(mode) => void monitor.update({ mode })}
        />
        {page === 'map' ? (
          <ErrorBoundary
            module="map"
            resetKeys={[page]}
            onRetry={() => void workspace.initialize()}
          >
            <MapPage onOpenSettings={() => openSettings('map')} />
          </ErrorBoundary>
        ) : page === 'calibrator' ? (
          <ErrorBoundary
            module="calibrator"
            resetKeys={[page]}
            onRetry={() => void workspace.initialize()}
            {...boundaryActions('calibrator')}
          >
            <CalibratorPage />
          </ErrorBoundary>
        ) : page === 'settings' ? (
          <ErrorBoundary
            module="settings"
            resetKeys={[page]}
            onRetry={() => void workspace.initialize()}
            {...boundaryActions('settings')}
          >
            <SettingsPage initialTab={settingsTab} />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary module="items" resetKeys={[page]} onRetry={() => window.location.reload()}>
            <ItemsPage onOpenSettings={() => openSettings('recognition')} />
          </ErrorBoundary>
        )}
        <footer className="statusbar">
          <span className={`connection ${overlay.connected ? 'connected' : ''}`}>
            <Radio size={12} aria-hidden="true" />
            {t(overlay.connected ? 'common.connected' : 'common.reconnecting')}
          </span>
          <div
            className="save-status"
            role={failed ? 'alert' : 'status'}
            aria-live={failed ? 'assertive' : 'polite'}
          >
            {failed ? (
              <span className="danger">{t(failed as LocaleKey)}</span>
            ) : saving ? (
              <>
                <span className="small-spinner" aria-hidden="true" />
                {t('map.status.saving')}
              </>
            ) : (
              <>
                <Check size={12} aria-hidden="true" />
                {t('map.status.saved')}
              </>
            )}
          </div>
        </footer>
      </ErrorBoundary>
      <ConfirmDialog
        open={pendingReset !== null}
        title={t(
          pendingReset === 'calibrator'
            ? 'calibrator.resetDataTitle'
            : 'settings.pageError.resetTitle',
        )}
        message={t(
          pendingReset === 'calibrator'
            ? 'calibrator.resetDataConfirm'
            : 'settings.pageError.resetConfirm',
        )}
        confirmLabel={t(
          pendingReset === 'calibrator'
            ? 'calibrator.resetDataConfirmButton'
            : 'settings.pageError.resetConfirmButton',
        )}
        danger
        onConfirm={() => {
          if (pendingReset) resetModuleData(pendingReset);
          setPendingReset(null);
        }}
        onCancel={() => setPendingReset(null)}
      />
    </main>
  );
}
