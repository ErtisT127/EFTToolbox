import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocale } from './useLocale';
import { notices } from '../stores/noticeStore';
import { workspace, useWorkspace } from '../stores/workspaceStore';
import { useOverlay } from '../stores/overlayStore';
import { gameMonitor, useGameMonitor } from '../stores/gameMonitorStore';
import { shouldPushNotice } from '../lib/errors';

const NOTICE_COOLDOWN_MS = 3000;

export function useGlobalErrorRecovery() {
  const { t } = useLocale();
  const w = useWorkspace(workspace);
  const overlay = useOverlay();
  const monitor = useGameMonitor();
  const session = w.sessions.get(w.activeId);
  const failed = useMemo(
    () =>
      overlay.error ||
      w.error ||
      session?.error ||
      w.preferenceError ||
      w.calibratorPreferenceError ||
      (monitor.error !== 'errors.user_settings_invalid' ? monitor.error : ''),
    [
      monitor.error,
      overlay.error,
      session?.error,
      w.calibratorPreferenceError,
      w.error,
      w.preferenceError,
    ],
  );
  const saving =
    overlay.saving || session?.saving || w.savingPreferences || w.savingCalibratorPreferences;
  const recover = useCallback(() => {
    if (overlay.error) void overlay.retry();
    if (w.error) void workspace.initialize();
    if (session?.error) void workspace.save(w.activeId);
    if (w.preferenceError) void workspace.savePreferences();
    if (w.calibratorPreferenceError) void workspace.saveCalibratorPreferences();
    if (monitor.error && monitor.error !== 'errors.user_settings_invalid')
      void gameMonitor.initialize();
  }, [
    monitor.error,
    overlay,
    session?.error,
    w.activeId,
    w.calibratorPreferenceError,
    w.error,
    w.preferenceError,
  ]);
  const lastNotice = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (!failed) {
      lastNotice.current = null;
      return;
    }
    const now = Date.now();
    const previous = lastNotice.current;
    if (!shouldPushNotice(previous, failed, now, NOTICE_COOLDOWN_MS)) return;
    lastNotice.current = { key: failed, at: now };
    notices.push(t(failed), recover);
  }, [failed, recover, t]);
  return { failed, saving, workspace: w, overlay, monitor };
}
