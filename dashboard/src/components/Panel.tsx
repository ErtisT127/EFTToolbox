import type { PropsWithChildren } from 'react';

export function Panel({ children, className = '' }: PropsWithChildren<{ className?: string }>) {
  return <section className={`floating ${className}`}>{children}</section>;
}
