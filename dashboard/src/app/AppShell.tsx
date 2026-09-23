import { useEffect, useRef, useState } from 'react';
import { MapPage } from '../pages/map/MapPage';
import { CalibratorPage } from '../pages/calibrator/CalibratorPage';
import { SettingsPage } from '../pages/settings/SettingsPage';
import { AppHeader } from '../components/AppHeader';
import { NoticeHost } from '../components/Notice';
import { workspace } from '../stores/workspaceStore';
import { useLocale } from '../hooks/useLocale';
import { Check, Radio } from 'lucide-react';
import { gameMonitor } from '../stores/gameMonitorStore';
import { useGlobalErrorRecovery } from '../hooks/useGlobalErrorRecovery';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { DataLoadError } from '../lib/errors';
import { notices } from '../stores/noticeStore';

export function AppShell() {
  const [page, setPage] = useState<'map' | 'calibrator' | 'items' | 'tools' | 'settings'>('map');
  const { t } = useLocale();
  const recovery = useGlobalErrorRecovery();
  const { overlay, monitor, failed, saving, workspace: w } = recovery;
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void workspace.initialize();
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
  const openDataDirectory = () => {
    void fetch('/api/data/open-user-settings')
      .then((response) => {
        if (!response.ok) notices.push(t('errors.data_directory_open_failed'));
      })
      .catch(() => notices.push(t('errors.data_directory_open_failed')));
  };
  const resetModuleData = (module: 'map' | 'calibrator' | 'settings') => {
    const url =
      module === 'settings'
        ? '/api/data/reset-user-settings'
        : module === 'calibrator'
          ? '/api/data/reset-calibration'
          : '/api/data/reset-user-settings';
    void fetch(url, { method: 'POST' })
      .then((response) => {
        if (!response.ok) throw new Error('reset failed');
        return workspace.initialize();
      })
      .catch(() => notices.push(t('errors.data_reset_failed')));
  };
  const boundaryActions = (module: 'calibrator' | 'settings') => ({
    onOpenDirectory: (_error: DataLoadError) => openDataDirectory(),
    onResetData: (_error: DataLoadError) => {
      const confirmed = window.confirm(
        t(module === 'calibrator' ? 'calibrator.resetDataConfirm' : 'settingsError.resetConfirm'),
      );
      if (confirmed) resetModuleData(module);
    },
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
            <MapPage onOpenSettings={() => setPage('settings')} />
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
            <SettingsPage />
          </ErrorBoundary>
        ) : (
          <section className="placeholder">
            <h1>{t(`nav.${page}`)}</h1>
            <p>{t('common.building')}</p>
            <button onClick={() => setPage('map')}>{t('common.backToMap')}</button>
          </section>
        )}
        <footer className="statusbar">
          <span className={`connection ${overlay.connected ? 'connected' : ''}`}>
            <Radio size={12} aria-hidden="true" />
            {t(overlay.connected ? 'status.connected' : 'status.reconnecting')}
          </span>
          <div
            className="save-status"
            role={failed ? 'alert' : 'status'}
            aria-live={failed ? 'assertive' : 'polite'}
          >
            {failed ? (
              <span className="danger">{t(failed)}</span>
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
    </main>
  );
}
