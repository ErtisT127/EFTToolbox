import { useSyncExternalStore } from 'react';

export interface Notice {
  id: number;
  message: string;
  severity: NoticeSeverity;
  /** Present only when retrying the failed operation can actually change the outcome. */
  retry?: () => void;
}

export type NoticeSeverity = 'error' | 'warning' | 'success';

/**
 * Transient, actionable messages that belong to no single page. Anything a page can show next to
 * the control that caused it (a rejected shortcut, an invalid field) stays on the page instead.
 */
class NoticeStore {
  notices: Notice[] = [];
  private version = 0;
  private sequence = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  private changed() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }
  push(message: string, retry?: () => void, severity: NoticeSeverity = 'error') {
    if (!message) return;
    const existing = this.notices.find((notice) => notice.message === message);
    if (existing) {
      // A newer retry for the same failure supersedes the one already on screen.
      existing.retry = retry;
      existing.severity = severity;
      this.changed();
      return;
    }
    this.notices = [...this.notices.slice(-2), { id: ++this.sequence, message, retry, severity }];
    this.changed();
  }
  dismiss(id: number) {
    this.notices = this.notices.filter((notice) => notice.id !== id);
    this.changed();
  }
  clear() {
    if (!this.notices.length) return;
    this.notices = [];
    this.changed();
  }
}

export const notices = new NoticeStore();

export function useNotices() {
  useSyncExternalStore(notices.subscribe, notices.snapshot);
  return notices;
}
