import { Check } from 'lucide-react';
import { useLocale } from '../hooks/useLocale';

const palette = ['#5FD3C4', '#E0B84C', '#7FB2E5', '#D98CCB', '#D4D8D5', '#C4554B'];

type Props = {
  color: string;
  onChange: (color: string) => void;
};

export function ColorPicker({ color, onChange }: Props) {
  const { t } = useLocale();
  return (
    <div className="color-picker">
      <div className="swatches">
        {palette.map((swatch) => (
          <button
            key={swatch}
            title={swatch}
            aria-label={t('map.toolSettings.swatch', { color: swatch })}
            aria-pressed={color === swatch}
            style={{ background: swatch }}
            onClick={() => onChange(swatch)}
          >
            {color === swatch && <Check size={12} />}
          </button>
        ))}
      </div>
      <label className="custom-color">
        {t('map.toolSettings.custom')}
        <input
          aria-label={t('map.toolSettings.customColor')}
          type="color"
          value={color}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    </div>
  );
}
