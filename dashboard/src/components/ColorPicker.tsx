import { Check } from 'lucide-react';
import { useLocale } from '../hooks/useLocale';

const palette = ['#5FD3C4', '#E0B84C', '#7FB2E5', '#D98CCB', '#D4D8D5', '#C4554B'];

type Props = {
  color: string;
  onChange: (color: string) => void;
};

export function ColorPicker({ color, onChange }: Props) {
  const { t } = useLocale();
  const normalized = color.toUpperCase();
  return (
    <div className="color-picker">
      <div className="swatches">
        {palette.map((swatch) => (
          <button
            key={swatch}
            title={swatch}
            aria-label={t('map.toolSettings.swatch', { color: swatch })}
            aria-pressed={normalized === swatch}
            style={{ backgroundColor: swatch }}
            onClick={() => onChange(swatch)}
          >
            {normalized === swatch && <Check size={12} />}
          </button>
        ))}
      </div>
      <label className={`custom-color ${palette.includes(normalized) ? '' : 'selected'}`}>
        {t('map.toolSettings.custom')}
        <input
          aria-label={t('map.toolSettings.customColor')}
          type="color"
          value={normalized}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    </div>
  );
}
