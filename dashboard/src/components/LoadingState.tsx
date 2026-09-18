import { useTranslation } from 'react-i18next';

export function LoadingState() {
  const { t } = useTranslation();
  return <div className="placeholder">{t('common.loading')}</div>;
}
