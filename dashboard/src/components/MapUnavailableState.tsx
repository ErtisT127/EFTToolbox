import { WifiOff } from 'lucide-react';
import { useLocale, type LocaleKey } from '../hooks/useLocale';
import { ErrorState } from './ErrorState';

export function MapUnavailableState({
  errorKey,
  onRetry,
}: {
  errorKey: string;
  onRetry: () => void;
}) {
  const { t } = useLocale();
  return (
    <ErrorState
      icon={WifiOff}
      tone="network"
      title={t('map.state.unavailable')}
      description={t(errorKey as LocaleKey)}
      actions={[{ label: t('map.state.reload'), onClick: onRetry }]}
    />
  );
}
