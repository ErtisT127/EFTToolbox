import { Check, Plus } from 'lucide-react';
import { useRef } from 'react';
import { useLocale } from '../hooks/useLocale';

const palette = ['#FF6B35', '#00B4D8', '#FF4D6D', '#8AC926', '#9B5DE5', '#FFD166', '#F8F9FA'];

type Props = {
  color: string;
  onChange: (color: string) => void;
};

export function ColorPicker({ color, onChange }: Props) {
  const { t } = useLocale();
  const normalized = color.toUpperCase();
  const customActive = !palette.includes(normalized);
  const picker = useRef<HTMLInputElement>(null);
  return (
    <div className="color-picker">
      <div className="swatches">
        {palette.map((swatch) => (
          <button
            key={swatch}
            type="button"
            title={swatch}
            aria-label={t('map.toolSettings.swatch', { color: swatch })}
            aria-pressed={normalized === swatch}
            style={{ backgroundColor: swatch }}
            onClick={() => onChange(swatch)}
          >
            {normalized === swatch && <Check size={12} />}
          </button>
        ))}
        <button
          type="button"
          className={`custom-color ${customActive ? 'selected' : ''}`}
          aria-label={t('map.toolSettings.customColor')}
          title={t('map.toolSettings.customColor')}
          style={customActive ? { backgroundColor: color } : undefined}
          onClick={() => {
            const input = picker.current;
            if (!input) return;
            if (typeof input.showPicker === 'function') input.showPicker();
            else input.click();
          }}
        >
          {customActive ? <Check size={12} /> : <Plus size={12} />}
        </button>
      </div>
      <input
        ref={picker}
        className="color-input"
        aria-label={t('map.toolSettings.customColor')}
        type="color"
        value={normalized}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
