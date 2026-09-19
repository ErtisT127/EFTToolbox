import { Crosshair } from 'lucide-react';
import { useLocale } from '../hooks/useLocale';

export function AppHeader({
  active,
  onNavigate,
}: {
  active: 'map' | 'items' | 'tools' | 'settings';
  onNavigate: (page: 'map' | 'items' | 'tools' | 'settings') => void;
}) {
  const { t } = useLocale();
  return (
    <header className="topbar">
      <div className="brand">
        <Crosshair size={21} strokeWidth={1.5} aria-hidden="true" />
        <span>
          EFT<span className="brand-secondary"> TOOLBOX</span>
        </span>
      </div>
      <nav aria-label={t('nav.aria')}>
        {(['map', 'items', 'tools', 'settings'] as const).map((key) => (
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
      <div className="mode">
        <span className="mode-dot" />
        PVP
      </div>
    </header>
  );
}
