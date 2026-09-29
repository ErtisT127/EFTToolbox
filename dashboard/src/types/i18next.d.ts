import type { MessageTree } from '../../../contracts/ts/messages.gen';

// Key checking and completion for t() against zh-CN; en-US key parity is enforced by the
// contracts generator.
declare module 'i18next' {
  interface CustomTypeOptions {
    resources: {
      translation: MessageTree;
    };
  }
}
