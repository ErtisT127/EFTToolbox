import type { CSSProperties, ReactNode } from 'react';

/** How much of a slider's track is filled, as the percentage its style needs. */
export function rangeFill(value: number, min: number, max: number) {
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

/**
 * The dashboard's slider, drawn by `input[type='range'].range-slider` in app.css rather than by the
 * platform. The label and its value share the first line so every row of a settings rail keeps the
 * same height whatever unit the value carries.
 */
export function RangeSlider({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
  id,
  ariaLabel,
  disabled,
}: {
  /** A node, so a caller can put a hint mark next to the text. Omit it for a control-only row. */
  label?: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  id?: string;
  /** Only for a control whose visible label is shorter than the action it performs. */
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const shown = format ? format(value) : String(value);
  const input = (
    <input
      id={id}
      aria-label={ariaLabel}
      className="range-slider"
      type="range"
      disabled={disabled}
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ '--fill': `${rangeFill(value, min, max)}%` } as CSSProperties}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
  // A page that keeps its own label row (the settings page) only needs the control half.
  if (label === undefined)
    return (
      <span className="range-slider-control">
        {input}
        <output htmlFor={id}>{shown}</output>
      </span>
    );
  return (
    <label className="range-slider-field">
      <span className="range-slider-label">
        {label}
        <output htmlFor={id}>{shown}</output>
      </span>
      {input}
    </label>
  );
}
