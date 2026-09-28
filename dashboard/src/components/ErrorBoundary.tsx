import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useLocale, type LocaleKey } from '../hooks/useLocale';
import { ErrorState } from './ErrorState';
import { DataLoadError, isDashboardDevelopment, isDataLoadError } from '../lib/errors';
import { reportClientLog } from '../stores/workspaceStore';

type ErrorBoundaryProps = {
  children: ReactNode;
  module: 'app' | 'map' | 'calibrator' | 'items' | 'settings';
  resetKeys?: readonly unknown[];
  onRetry: () => void;
  onOpenDirectory?: (error: DataLoadError) => void;
  onResetData?: (error: DataLoadError) => void;
};

type ErrorBoundaryState = { error: Error | null; resetVersion: number };

type ErrorBoundaryViewProps = {
  error: Error;
  module: ErrorBoundaryProps['module'];
  onRetry: () => void;
  onOpenDirectory?: (error: DataLoadError) => void;
  onResetData?: (error: DataLoadError) => void;
};

function ErrorBoundaryView({
  error,
  module,
  onRetry,
  onOpenDirectory,
  onResetData,
}: ErrorBoundaryViewProps) {
  const { t } = useLocale();
  const dataError = isDataLoadError(error);
  const actions: Array<{ label: string; onClick: () => void; danger?: boolean }> = [
    { label: t('common.retry'), onClick: onRetry },
  ];
  if (dataError && onOpenDirectory && onResetData) {
    actions.push(
      { label: t('errorBoundary.openDirectory'), onClick: () => onOpenDirectory(error) },
      { label: t('errorBoundary.resetData'), onClick: () => onResetData(error), danger: true },
    );
  }
  return (
    <ErrorState
      icon={AlertTriangle}
      tone={dataError ? 'data' : 'network'}
      title={t(`errorBoundary.${module}.title`)}
      description={t(dataError ? (error.errorKey as LocaleKey) : 'errorBoundary.description')}
      actions={actions}
    />
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, resetVersion: 0 };
  private previousResetKeys?: readonly unknown[];

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    reportClientLog('react_render_failed', error.message, errorInfo.componentStack || '');
    if (isDashboardDevelopment()) {
      console.error(error);
      console.error(errorInfo.componentStack);
    }
  }

  componentDidUpdate() {
    const { resetKeys } = this.props;
    if (!resetKeys || !this.previousResetKeys) {
      this.previousResetKeys = resetKeys;
      return;
    }
    const changed =
      resetKeys.length !== this.previousResetKeys.length ||
      resetKeys.some((value, index) => !Object.is(value, this.previousResetKeys?.[index]));
    this.previousResetKeys = resetKeys;
    if (changed && this.state.error) this.reset();
  }

  private reset = () => {
    this.setState((state) => ({ error: null, resetVersion: state.resetVersion + 1 }));
    this.props.onRetry();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ErrorBoundaryView
        key={this.state.resetVersion}
        error={this.state.error}
        module={this.props.module}
        onRetry={this.reset}
        onOpenDirectory={this.props.onOpenDirectory}
        onResetData={this.props.onResetData}
      />
    );
  }
}
