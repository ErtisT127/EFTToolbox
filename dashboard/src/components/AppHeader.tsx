import { Crosshair } from 'lucide-react';
import { useLocale } from '../hooks/useLocale';
import type { GameMode } from '../stores/gameMonitorStore';

// Top-level pages, in the order they appear in the header. The tab set and the page union are the
// same list, so the shell cannot render a tab it has no page for.
export const appPages = ['map', 'items', 'calibrator', 'settings'] as const;

export type AppPage = (typeof appPages)[number];

export function AppHeader({
  active,
  onNavigate,
  mode,
  onModeChange,
}: {
  active: AppPage;
  onNavigate: (page: AppPage) => void;
  mode: GameMode;
  onModeChange: (mode: GameMode) => void;
}) {
  const { t } = useLocale();
  const modeMeta = (
    {
      pvp: { label: 'pvp' },
      pve: { label: 'pve' },
      'pvp-season': { label: 'season' },
    } as const
  )[mode];
  return (
    <header className="topbar">
      <div className="brand">
        <Crosshair size={21} strokeWidth={1.5} aria-hidden="true" />
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
            onClick={() => onNavigate(key)}
          >
            {t(`nav.${key}`)}
          </button>
        ))}
      </nav>
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
    </header>
  );
}
