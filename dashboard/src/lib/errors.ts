export type DataLoadModule = 'map' | 'calibrator' | 'settings';

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
