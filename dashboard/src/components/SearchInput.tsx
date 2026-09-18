// Chromium and Safari draw a clear button inside a `type="search"` field; Firefox draws none at
// all. Where it is missing we render the same one ourselves — from the same mask the native button
// is styled with — so the control never simply disappears for a browser.
const hasNativeClear =
  typeof CSS !== 'undefined' && CSS.supports('selector(::-webkit-search-cancel-button)');

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  clearLabel: string;
  autoFocus?: boolean;
};

export function SearchInput({ value, onChange, placeholder, label, clearLabel, autoFocus }: Props) {
  return (
    <div className="search-field">
      <input
        type="search"
        className="search-input"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
      {!hasNativeClear && value && (
        <button
          type="button"
          className="search-clear"
          aria-label={clearLabel}
          onClick={() => onChange('')}
        />
      )}
    </div>
  );
}
