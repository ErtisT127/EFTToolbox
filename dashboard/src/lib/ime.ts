import { useCallback, useRef, type CompositionEvent } from 'react';

/**
 * Whether a key event belongs to an IME composition. Chromium marks the keys the candidate window
 * consumes with `isComposing` (and the legacy `keyCode` 229), and those include the IME's own
 * Escape and Space: app shortcuts have to stand down until the text is committed.
 */
export function isImeComposing(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/**
 * Composition state for a text field whose text is persisted. While the IME is open the caller keeps
 * the text local, and `onCommit` receives the finished value read from the DOM — so an interrupted
 * composition can never persist half-typed pinyin or get rolled back under the candidate window.
 * Pass `onCommit` only when composing text should be written on commit; without it the returned
 * `composing` ref lets the caller defer its own blur/change handling.
 */
export function useImeComposition(onCommit?: (value: string) => void) {
  const composing = useRef(false);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const onCompositionStart = useCallback(() => {
    composing.current = true;
  }, []);
  const onCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      composing.current = false;
      commit.current?.(event.currentTarget.value);
    },
    [],
  );
  return { composing, composerProps: { onCompositionStart, onCompositionEnd } };
}
