import { useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { NumericLimit } from '../../../contracts/ts/ipc.gen';

export function NumberStepper({
  label,
  value,
  limit,
  unit,
  deferInput = false,
  onChange,
  onBlur,
}: {
  label: string;
  value: number;
  limit: NumericLimit;
  unit?: string;
  deferInput?: boolean;
  onChange: (value: number) => void;
  onBlur?: () => void;
}) {
  // The field holds free text while it has focus and applies every value the contract allows, so
  // it behaves like the rest of the dashboard: change it and it takes effect. Text outside the
  // bounds is left alone until blur — clamping per keystroke would snap a typed "1" to the
  // minimum, and committing half-typed numbers would resize the overlay mid-edit.
  const [draft, setDraft] = useState<string | null>(null);
  // Escape blurs the field, and the DOM still holds the discarded text at that moment.
  const reverting = useRef(false);
  // What the value was when the field was entered, so Escape can put it back.
  const entry = useRef(value);
  // Bounds, step and displayed digits all come from the contract limits, so every stepper clamps
  // and rounds the same way the server and the overlay do.
  const round = (n: number) =>
    Number(Math.min(limit.max, Math.max(limit.min, n)).toFixed(limit.precision));
  const shown = draft ?? String(Number(value.toFixed(limit.precision)));
  const commit = (raw: string) => {
    setDraft(null);
    const next = raw.trim() === '' ? NaN : Number(raw);
    if (Number.isFinite(next)) onChange(round(next));
  };
  const step = (direction: number) => {
    const typed = draft === null || draft.trim() === '' ? NaN : Number(draft);
    setDraft(null);
    onChange(round((Number.isFinite(typed) ? typed : value) + direction * limit.step));
  };
  return (
    <div className="number-stepper">
      <span className="number-stepper-label">{label}</span>
      <div className="number-stepper-control">
        <button
          type="button"
          aria-label={`${label} -`}
          title={`${label} -`}
          disabled={value <= limit.min}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => step(-1)}
        >
          <Minus size={14} />
        </button>
        <input
          aria-label={label}
          type="number"
          inputMode="decimal"
          value={shown}
          min={limit.min}
          max={limit.max}
          step={limit.step}
          onFocus={(e) => {
            entry.current = value;
            setDraft(String(Number(value.toFixed(limit.precision))));
            e.currentTarget.select();
          }}
          onChange={(e) => {
            const raw = e.currentTarget.value;
            setDraft(raw);
            const next = raw.trim() === '' ? NaN : Number(raw);
            if (!deferInput && Number.isFinite(next) && next >= limit.min && next <= limit.max)
              onChange(round(next));
          }}
          onBlur={(e) => {
            if (reverting.current) {
              reverting.current = false;
              setDraft(null);
              onBlur?.();
              return;
            }
            commit(e.currentTarget.value);
            onBlur?.();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit(e.currentTarget.value);
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              // Values applied while typing have to be undone, not just the uncommitted text.
              if (value !== entry.current) onChange(entry.current);
              reverting.current = true;
              e.currentTarget.blur();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              step(e.key === 'ArrowUp' ? 1 : -1);
            }
          }}
        />
        {unit && <span className="number-unit">{unit}</span>}
        <button
          type="button"
          aria-label={`${label} +`}
          title={`${label} +`}
          disabled={value >= limit.max}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => step(1)}
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}
