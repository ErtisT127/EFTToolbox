import { useEffect } from 'react';
import { X } from 'lucide-react';
import rewardQrCode from '../assets/reward_qrcode.png';
import { useLocale } from '../hooks/useLocale';
import { isImeComposing } from '../lib/ime';

/**
 * The author's reward code, shown on request. It follows the app's dialog convention rather than the
 * platform's, so it looks like every other panel the user has already seen.
 */
export function RewardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useLocale();
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeComposing(event)) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="confirm-dialog reward-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reward-dialog-title"
      >
        <div className="panel-title">
          <strong id="reward-dialog-title">{t('settings.about.rewardTitle')}</strong>
          <button className="icon-button" aria-label={t('common.dismiss')} onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <img className="reward-qrcode" src={rewardQrCode} alt="" />
      </section>
    </div>
  );
}
