import type zhCN from '../i18n/locales/zh-CN';

// Key checking and completion for t() against zh-CN; en-US key parity is enforced by i18n:check.
declare module 'i18next' {
  interface CustomTypeOptions {
    resources: {
      translation: typeof zhCN;
    };
  }
}
