import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import appIcon from '../assets/app-icon.png';
import { useLocale } from '../hooks/useLocale';
import type { GameMode } from '../stores/gameMonitorStore';
import { isHosted, postHostMessage, requestClose, subscribeHostEvents } from '../lib/hostWindow';
import { useUpdate } from '../stores/updateStore';

// Top-level pages, in the order they appear in the header. The tab set and the page union are the
// same list, so the shell cannot render a tab it has no page for.
export const appPages = ['map', 'items', 'calibrator', 'settings'] as const;

export type AppPage = (typeof appPages)[number];

export function AppHeader({
  active,
  onNavigate,
  onOpenAbout,
  mode,
  onModeChange,
}: {
  active: AppPage;
  onNavigate: (page: AppPage) => void;
  onOpenAbout: () => void;
  mode: GameMode;
  onModeChange: (mode: GameMode) => void;
}) {
  const { t } = useLocale();
  const updates = useUpdate();
  // Only the desktop host has a title bar to draw: in a browser the window is the browser's job.
  const hosted = isHosted();
  const [maximized, setMaximized] = useState(false);
  useEffect(
    () => subscribeHostEvents('window-state', (event) => setMaximized(Boolean(event.maximized))),
    [],
  );
  const modeMeta = (
    {
      pvp: { label: 'pvp' },
      pve: { label: 'pve' },
      'pvp-season': { label: 'pvpSeason' },
    } as const
  )[mode];
  return (
    <header className="topbar">
      {/* The brand and the free space next to the tabs are the window's drag handle. */}
      <div className="brand" data-non-client-region="caption">
        {/* The application icon, at the size the icon font would have taken. It is decorative: the
            wordmark next to it names the app. */}
        <img src={appIcon} alt="" width={21} height={21} draggable={false} />
        <span>
          EFT<span className="brand-secondary"> TOOLBOX</span>
        </span>
      </div>
      <nav aria-label={t('nav.aria')}>
        {appPages.map((key) => (
          <button
            key={key}
            className={active === key ? 'active' : ''}
            aria-current={active === key ? 'page' : undefined}
            onClick={(event) => {
              // The badge is its own target: it lands on the About tab instead of the page's last tab.
              if ((event.target as HTMLElement).closest('[data-update-badge]')) {
                onOpenAbout();
                return;
              }
              onNavigate(key);
            }}
          >
            {t(`nav.${key}`)}
            {key === 'settings' && updates.hasUpdate && (
              <span className="update-badge" data-update-badge>
                {t('settings.about.newBadge')}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="topbar-drag" data-non-client-region="caption" />
      <button
        className={`game-mode-toggle ${mode === 'pvp' ? 'regular' : mode}`}
        aria-label={t('mode.select')}
        onClick={() =>
          onModeChange(({ pvp: 'pve', pve: 'pvp-season', 'pvp-season': 'pvp' } as const)[mode])
        }
      >
        <span key={mode} className="mode-label">
          {t(`mode.${modeMeta.label}`)}
        </span>
        <span className="mode-tip" role="tooltip">
          {t('mode.select')}
        </span>
      </button>
      {hosted && (
        <div className="window-controls">
          <button
            type="button"
            data-non-client-region="minimize"
            aria-label={t('titleBar.minimize')}
            onClick={() => postHostMessage('efttoolbox:window:minimize')}
          >
            <Minus size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t(maximized ? 'titleBar.restore' : 'titleBar.maximize')}
            data-non-client-region="maximize"
            onClick={() => postHostMessage('efttoolbox:window:toggle-maximize')}
          >
            {maximized ? (
              <Copy size={14} aria-hidden="true" />
            ) : (
              <Square size={13} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="window-close"
            data-non-client-region="close"
            aria-label={t('titleBar.close')}
            onClick={() => void requestClose()}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </header>
  );
}
