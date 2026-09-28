import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type zhCN from '../i18n/locales/zh-CN';

export function useLocale() {
  const { t, i18n } = useTranslation();
  return { t, locale: i18n.language };
}

// Declare this when a component takes t as a prop; inner calls get the same key checking.
export type Translate = TFunction<'translation', undefined>;

type NestedKeyOf<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object ? `${K}.${NestedKeyOf<T[K]>}` : K;
    }[keyof T & string]
  : never;

// Every zh-CN leaf key; runtime-only keys (store error keys, backend error codes, data-derived
// keys) get narrowed with this at the call site. en-US key parity is enforced by i18n:check.
export type LocaleKey = NestedKeyOf<typeof zhCN>;
