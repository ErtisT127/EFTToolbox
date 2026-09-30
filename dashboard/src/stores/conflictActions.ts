import { useEffect, useRef, useSyncExternalStore } from 'react';

/** The two conflict choices only the owning page can perform; "keep local" is universal. */
export type ConflictActions = {
  loadRemote: () => void;
  retry: () => void;
};

// Conflict prompts render once, at the window level, while their actions live in the page that
// owns the draft. The page registers those closures here for as long as it is mounted.
const registry = new Map<string, ConflictActions>();
const listeners = new Set<() => void>();
let version = 0;

const notify = () => {
  version += 1;
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const conflictActionsFor = (key: string) => registry.get(key);

/**
 * Registers one conflict key's actions. The closures are held behind a ref so a re-render keeps
 * them fresh without re-registering. The entry deliberately outlives the page: a conflict lives in
 * global state, so its choices have to stay usable after the user navigates away from the page
 * that raised it. A remount of that page replaces the entry with fresh closures.
 */
export function useRegisterConflictActions(key: string, actions: ConflictActions) {
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    registry.set(key, {
      loadRemote: () => latest.current.loadRemote(),
      retry: () => latest.current.retry(),
    });
    notify();
  }, [key]);
}

/** Re-renders the banner when a page (un)registers its actions. */
export function useConflictActionsVersion() {
  return useSyncExternalStore(subscribe, () => version);
}
