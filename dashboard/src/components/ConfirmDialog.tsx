import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useLocale } from '../hooks/useLocale';
import { isImeComposing } from '../lib/ime';

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  danger = false,
  portalContainer,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  portalContainer?: HTMLElement | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    confirm.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeComposing(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);
  if (!open) return null;
  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <section
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <div className="panel-title">
          <strong id="confirm-title">{title}</strong>
          <button className="icon-button" aria-label={t('common.dismiss')} onClick={onCancel}>
            <X size={15} />
          </button>
        </div>
        <p>{message}</p>
        <div className="dialog-actions">
          <button onClick={onCancel}>{t('common.cancel')}</button>
          <button
            ref={confirm}
            className={danger ? 'danger-button' : 'primary'}
            onClick={onConfirm}
          >
            {confirmLabel || t('common.confirm')}
          </button>
        </div>
      </section>
    </div>,
    portalContainer || document.body,
  );
}
