import { useTranslation } from 'react-i18next';

export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="placeholder">
      <p>{t('common.error')}</p>
      {onRetry && <button onClick={onRetry}>{t('common.retry')}</button>}
    </div>
  );
}
