import { useEffect, useRef, useState } from 'react';
import { isImeComposing } from '../lib/ime';

export function NumericField({
  label,
  value,
  precision = 2,
  min = -Infinity,
  max = Infinity,
  onChange,
  onBlur,
  disabled = false,
  error,
}: {
  label: string;
  value: number;
  precision?: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  onBlur?: () => void;
  disabled?: boolean;
  error?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const entry = useRef(value);
  useEffect(() => {
    if (draft === null) entry.current = value;
  }, [value, draft]);
  const display = draft ?? value.toFixed(precision);
  const commit = (raw: string) => {
    const next = Number(raw);
    if (!Number.isFinite(next) || next < min || next > max) {
      setDraft(null);
      return;
    }
    onChange(Number(next.toFixed(precision)));
    setDraft(null);
  };
  return (
    <label className={`calibrator-field numeric-field ${disabled ? 'disabled' : ''}`}>
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={display}
        min={Number.isFinite(min) ? min : undefined}
        max={Number.isFinite(max) ? max : undefined}
        step={10 ** -precision}
        aria-label={label}
        disabled={disabled}
        aria-invalid={error ? 'true' : undefined}
        onFocus={(event) => {
          entry.current = value;
          setDraft(value.toFixed(precision));
          event.currentTarget.select();
        }}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          setDraft(raw);
        }}
        onBlur={(event) => {
          commit(event.currentTarget.value);
          onBlur?.();
        }}
        onKeyDown={(event) => {
          if (isImeComposing(event)) return;
          if (event.key === 'Enter') {
            commit(event.currentTarget.value);
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            onChange(entry.current);
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
      {error && (
        <small className="field-error" role="alert">
          {error}
        </small>
      )}
    </label>
  );
}
