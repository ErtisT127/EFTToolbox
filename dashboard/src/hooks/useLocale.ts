import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  defaultLocale,
  locales,
  type Locale,
  type MessageTree,
} from '../../../contracts/ts/messages.gen.ts';

export function useLocale() {
  const { t, i18n } = useTranslation();
  // i18next accepts arbitrary language tags; narrow to the contract locales with the default as
  // fallback so locale-consuming APIs keep their generated union type.
  return {
    t,
    locale: (locales as readonly string[]).includes(i18n.language)
      ? (i18n.language as Locale)
      : defaultLocale,
  };
}

// Declare this when a component takes t as a prop; inner calls get the same key checking.
export type Translate = TFunction<'translation', undefined>;

type NestedKeyOf<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object ? `${K}.${NestedKeyOf<T[K]>}` : K;
    }[keyof T & string]
  : never;

// Every zh-CN leaf key; runtime-only keys (store error keys, backend error codes, data-derived
// keys) get narrowed with this at the call site. en-US key parity is enforced by the contracts
// generator.
export type LocaleKey = NestedKeyOf<MessageTree>;
