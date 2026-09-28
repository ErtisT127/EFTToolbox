import { useMemo } from 'react';

export function useVirtualList<T>(items: T[], scrollTop: number, height: number, rowHeight = 46) {
  return useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 4);
    const end = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + 4);
    return { items: items.slice(start, end), start, totalHeight: items.length * rowHeight };
  }, [height, items, rowHeight, scrollTop]);
}
