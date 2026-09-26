import { Crosshair } from 'lucide-react';
import { useLocale } from '../hooks/useLocale';
import type { GameMode } from '../stores/gameMonitorStore';

export function AppHeader({
  active,
  onNavigate,
  mode,
  onModeChange,
}: {
  active: 'map' | 'calibrator' | 'items' | 'tools' | 'settings';
  onNavigate: (page: 'map' | 'calibrator' | 'items' | 'tools' | 'settings') => void;
  mode: GameMode;
  onModeChange: (mode: GameMode) => void;
}) {
  const { t } = useLocale();
  const modeMeta = {
    pvp: { label: 'pvp' },
    pve: { label: 'pve' },
    'pvp-season': { label: 'season' },
  }[mode];
  return (
    <header className="topbar">
      <div className="brand">
        <Crosshair size={21} strokeWidth={1.5} aria-hidden="true" />
        <span>
          EFT<span className="brand-secondary"> TOOLBOX</span>
        </span>
      </div>
      <nav aria-label={t('nav.aria')}>
        {(['map', 'calibrator', 'items', 'tools', 'settings'] as const).map((key) => (
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
