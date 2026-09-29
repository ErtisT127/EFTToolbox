import { useSelector } from 'react-redux';
import { clearNotices, dismissNotice, pushNotice, type ClientNotice } from './clientState';
import { store, type RootState } from './store';

export type Notice = ClientNotice;

export type NoticeSeverity = 'error' | 'warning' | 'success';

const retryHandlers = new Map<number, () => void>();

/**
 * Transient, actionable messages that belong to no single page. Anything a page can show next to
 * the control that caused it (a rejected shortcut, an invalid field) stays on the page instead.
 */
class NoticeStore {
  get notices() {
    return store.getState().client.notices;
  }
  push(message: string, retry?: () => void, severity: NoticeSeverity = 'error') {
    if (!message) return;
    store.dispatch(pushNotice({ message, severity }));
    const id = this.notices.find((notice) => notice.message === message)?.id;
    if (id === undefined) return;
    if (retry) retryHandlers.set(id, retry);
    else retryHandlers.delete(id);
  }
  hasRetry(id: number) {
    return retryHandlers.has(id);
  }
  retry(id: number) {
    const handler = retryHandlers.get(id);
    retryHandlers.delete(id);
    handler?.();
    this.dismiss(id);
  }
  dismiss(id: number) {
    retryHandlers.delete(id);
    store.dispatch(dismissNotice(id));
  }
  clear() {
    retryHandlers.clear();
    store.dispatch(clearNotices());
  }
}

export const notices = new NoticeStore();

export function useNotices() {
  useSelector((state: RootState) => state.client.notices);
  return notices;
}
