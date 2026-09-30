import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useLocale } from '../hooks/useLocale';
import { isImeComposing } from '../lib/ime';
import { postHostMessage, subscribeHostEvents } from '../lib/hostWindow';
import { reportClientLog } from '../stores/workspaceStore';

type CloseAction = 'exit' | 'tray' | 'cancel';

// The desktop host asks for this dialog over its event stream instead of drawing it itself, so the
// wording, the layout and the "remember my choice" box stay the app's own. The host keeps a native
// message box as the fallback for a close request that arrives before the page can answer.
export function CloseDialog() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);
  // The dialog opens on the tray button: both answers carry on from here, and the one that ends the
  // session should not be what Enter picks by accident.
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The host asks through an event when the window was closed by other means (Alt+F4, the taskbar
    // menu). It answers with this message so the host knows the dialog is really up instead of
    // falling back to its own message box.
    const unsubscribeHostRequests = subscribeHostEvents('close-request', () => {
      postHostMessage('efttoolbox:close:shown');
      reportClientLog('host_close_request', 'Host asked for the close dialog', '');
      setOpen(true);
    });
    const onLocalRequest = () => setOpen(true);
    window.addEventListener('efttoolbox:close-dialog', onLocalRequest);
    return () => {
      unsubscribeHostRequests();
      window.removeEventListener('efttoolbox:close-dialog', onLocalRequest);
    };
  }, []);
  const choose = useCallback(
    (action: CloseAction) => {
      postHostMessage(`efttoolbox:close:${JSON.stringify({ action, remember })}`);
      setOpen(false);
      setRemember(false);
    },
    [remember],
  );
  useEffect(() => {
    if (!open) return;
    safe.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeComposing(event)) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      choose('cancel');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, choose]);
  if (!open) return null;
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && choose('cancel')}
    >
      <section
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-dialog-title"
      >
        <div className="panel-title">
          <strong id="close-dialog-title">{t('host.closeTitle')}</strong>
          <button
            className="icon-button"
            aria-label={t('common.dismiss')}
            onClick={() => choose('cancel')}
          >
            <X size={15} />
          </button>
        </div>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          {t('host.closeRemember')}
        </label>
        <div className="dialog-actions">
          <button ref={safe} onClick={() => choose('tray')}>
            {t('host.closeTray')}
          </button>
          <button onClick={() => choose('exit')}>{t('host.closeExit')}</button>
        </div>
      </section>
    </div>
  );
}
