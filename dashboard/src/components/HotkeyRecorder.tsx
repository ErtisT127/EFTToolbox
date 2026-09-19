import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import { useLocale } from '../hooks/useLocale';

// Keys named after the physical position they occupy, never after the character they type: the
// same shortcut has to mean the same key on AZERTY or QWERTZ as it does on QWERTY. Backspace is
// deliberately absent, which leaves it free to mean "clear".
const physical = new Set([
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'Space',
  'Insert',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);
// Named differently on the wire than in the DOM, so the two ends agree on one spelling.
const aliases: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

const isModifier = (code: string) => /^(Control|Shift|Alt|Meta)/.test(code);

function keyName(code: string): string {
  if (aliases[code]) return aliases[code];
  if (physical.has(code)) return code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return '';
}

// Modifier order is fixed by the contract (docs/contracts.md), so a recorded shortcut reads the
// same before and after the save round trip.
function heldModifiers(event: KeyboardEvent<HTMLElement>) {
  return [
    event.ctrlKey && 'Ctrl',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    event.metaKey && 'Win',
  ].filter(Boolean) as string[];
}

export function HotkeyRecorder({
  label,
  value,
  error,
  conflict,
  onChange,
  onRecording,
}: {
  label: string;
  value: string;
  /** Reported by the overlay when another program holds the combination. Shown as the mark's own
   *  accessible name, never as text on the page. */
  error?: string;
  /** Another field holds this same combination. The recorder still binds it — a duplicate is
   *  something to show on both fields, not a reason to refuse the keystroke. */
  conflict?: boolean;
  onChange: (value: string) => void;
  /** Follows the recorder opening and closing, so the caller can stand the overlay's own hot keys
   *  down: a registered hot key is swallowed by Windows before the browser ever sees the stroke. */
  onRecording?: (recording: boolean) => void;
}) {
  const { t } = useLocale();
  const id = useId();
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState('');
  const keys = (recording && preview ? preview : value).split('+').filter(Boolean);
  // Only a click opens the recorder: tying it to focus meant that a field clicked once stayed
  // armed, so the next key pressed went into it whether the user meant that or not.
  const arm = (next: boolean) => {
    setPreview('');
    setRecording(next);
    onRecording?.(next);
  };
  // Leaving the page while armed would otherwise leave the overlay without its hot keys.
  const notify = useRef(onRecording);
  notify.current = onRecording;
  useEffect(() => () => notify.current?.(false), []);
  const record = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    // Tab has to keep moving focus: swallowing it would trap the keyboard here. Leaving the field
    // closes the recorder anyway.
    if (event.code === 'Tab') return;
    event.preventDefault();
    event.stopPropagation();
    // Escape and Enter close the recorder; they cannot be shortcuts themselves.
    if (event.code === 'Escape' || event.code === 'Enter' || event.code === 'NumpadEnter')
      return arm(false);
    // A modifier on its own is the prefix of every shortcut rather than a key of its own, so it
    // reads as a live preview of what is being held instead of an error.
    if (isModifier(event.code)) return setPreview(heldModifiers(event).join('+'));
    const name = keyName(event.code);
    // Anything the contract does not accept simply does not take: the field stays empty and the
    // recorder stays open, which says more than a message would.
    if (!name) return;
    const combo = [...heldModifiers(event), name].join('+');
    onChange(combo);
    arm(false);
  };
  // A field never carries a message of its own: the red mark beside it says a combination was
  // refused, and its accessible name says which kind of refusal it was.
  const refused = conflict || !!error;
  return (
    <div className="hotkey-row">
      <span className="hotkey-label" id={`${id}-label`}>
        {label}
      </span>
      <div className="hotkey-control">
        {refused && (
          <span
            className="hotkey-warning"
            id={`${id}-warning`}
            role="img"
            aria-label={error ?? t('settings.hotkeyTaken')}
          >
            <TriangleAlert size={14} aria-hidden="true" />
          </span>
        )}
        <button
          type="button"
          className={`hotkey-keys ${recording ? 'recording' : ''}`}
          aria-labelledby={`${id}-label ${id}-value`}
          aria-invalid={refused}
          aria-describedby={refused ? `${id}-warning` : undefined}
          aria-keyshortcuts={value || undefined}
          onBlur={() => arm(false)}
          onClick={() => arm(true)}
          onKeyDown={record}
        >
          <span className="hotkey-value" id={`${id}-value`} aria-live="polite">
            {recording && !keys.length ? (
              <span className="hotkey-hint">{t('settings.hotkeyRecording')}</span>
            ) : keys.length ? (
              keys.map((key) => <kbd key={key}>{key}</kbd>)
            ) : (
              <span className="hotkey-hint">{t('settings.hotkeyEmpty')}</span>
            )}
          </span>
        </button>
        <button
          type="button"
          className="hotkey-clear"
          disabled={!value}
          aria-label={t('settings.hotkeyClearFor', { label })}
          onClick={() => onChange('')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
