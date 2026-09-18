import { useTranslation } from 'react-i18next';

export function EmptyState() {
  const { t } = useTranslation();
  return <div className="placeholder">{t('common.empty')}</div>;
}
