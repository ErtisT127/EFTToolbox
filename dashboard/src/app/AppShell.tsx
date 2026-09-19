import { useEffect, useRef, useState } from 'react';
import { MapPage } from '../pages/map/MapPage';
import { SettingsPage } from '../pages/settings/SettingsPage';
import { AppHeader } from '../components/AppHeader';
import { overlay } from '../stores/overlayStore';
import { workspace } from '../stores/workspaceStore';
import { useLocale } from '../hooks/useLocale';

export function AppShell() {
  const [page, setPage] = useState<'map' | 'items' | 'tools' | 'settings'>('map');
  const { t } = useLocale();
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void workspace.initialize();
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
  }, []);
  return (
    <main className="app-shell">
      <AppHeader active={page} onNavigate={setPage} />
      {page === 'map' ? (
        <MapPage />
      ) : page === 'settings' ? (
        <SettingsPage />
      ) : (
        <section className="placeholder">
          <h1>{t(`nav.${page}`)}</h1>
          <p>{t('common.building')}</p>
          <button onClick={() => setPage('map')}>{t('common.backToMap')}</button>
        </section>
      )}
    </main>
  );
}
