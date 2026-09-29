export type DataLoadModule = 'map' | 'calibrator' | 'items' | 'settings';

export class DataLoadError extends Error {
  readonly errorKey: string;
  readonly module: DataLoadModule;

  constructor(errorKey: string, module: DataLoadModule, cause?: unknown) {
    super(errorKey, { cause });
    this.name = 'DataLoadError';
    this.errorKey = errorKey;
    this.module = module;
  }
}

export function isDataLoadError(value: unknown): value is DataLoadError {
  return (
    value instanceof DataLoadError ||
    (value instanceof Error &&
      value.name === 'DataLoadError' &&
      typeof (value as Partial<DataLoadError>).errorKey === 'string' &&
      typeof (value as Partial<DataLoadError>).module === 'string')
  );
}

/**
 * Locale key for a failed request. RTK Query rejections are plain objects carrying the
 * backend error code, so an `error instanceof Error` check alone loses it and every message
 * degrades to the generic fallback.
 */
export function errorKeyOf(reason: unknown, fallback: string): string {
  const data =
    reason !== null && typeof reason === 'object' && 'data' in reason
      ? (reason as { data?: unknown }).data
      : undefined;
  const code =
    data !== null &&
    typeof data === 'object' &&
    'code' in data &&
    typeof (data as { code?: unknown }).code === 'string'
      ? (data as { code: string }).code
      : undefined;
  if (code) return `errors.${code}`;
  return reason instanceof Error ? reason.message : fallback;
}

export function isDashboardDevelopment(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    (globalThis as typeof globalThis & { __EFT_TOOLBOX_DEV__?: boolean }).__EFT_TOOLBOX_DEV__ ===
      true
  );
}

export function shouldPushNotice(
  previous: { key: string; at: number } | null,
  key: string,
  now: number,
  cooldownMs: number,
): boolean {
  return !previous || previous.key !== key || now - previous.at >= cooldownMs;
}
