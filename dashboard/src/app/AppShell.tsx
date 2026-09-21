import { useEffect, useRef, useState } from 'react';
import { MapPage } from '../pages/map/MapPage';
import { SettingsPage } from '../pages/settings/SettingsPage';
import { AppHeader } from '../components/AppHeader';
import { NoticeHost } from '../components/Notice';
import { useOverlay } from '../stores/overlayStore';
import { notices } from '../stores/noticeStore';
import { workspace, useWorkspace } from '../stores/workspaceStore';
import { useLocale } from '../hooks/useLocale';
import { Check, Radio } from 'lucide-react';
import { gameMonitor, useGameMonitor } from '../stores/gameMonitorStore';

// Only failures that a second attempt can actually fix offer a retry: a rejected payload or an
// unreadable file comes back the same every time.
const retryable = new Set(['errors.request_failed', 'errors.overlay_unavailable']);

export function AppShell() {
  const [page, setPage] = useState<'map' | 'items' | 'tools' | 'settings'>('map');
  const { t } = useLocale();
  const w = useWorkspace(workspace);
  const monitor = useGameMonitor();
  const overlay = useOverlay();
  const session = w.sessions.get(w.activeId);
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
      // Pending preferences use the existing whole-document save contract.
      if (document.visibilityState === 'hidden') void workspace.savePreferences();
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
  // Saving is spread across three owners; the footer reports the state, the notice carries the
  // message and whatever recovery is actually available.
  const failed = overlay.error || w.error || session?.error || w.preferenceError;
  const saving = overlay.saving || session?.saving || w.savingPreferences;
  const recover = () => {
    if (overlay.error) void overlay.retry();
    if (w.error) void workspace.initialize();
    if (session?.error) void workspace.save(w.activeId);
    if (w.preferenceError) void workspace.savePreferences();
  };
  useEffect(() => {
    if (failed) notices.push(t(failed), retryable.has(failed) ? recover : undefined);
  }, [failed]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <main className="app-shell">
      <NoticeHost />
      <AppHeader
        active={page}
        onNavigate={setPage}
        mode={monitor.settings?.mode || monitor.status?.mode || 'pvp'}
        onModeChange={(mode) => void monitor.update({ mode })}
      />
      {page === 'map' ? (
        <MapPage onOpenSettings={() => setPage('settings')} />
      ) : page === 'settings' ? (
        <SettingsPage />
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
    </main>
  );
}
