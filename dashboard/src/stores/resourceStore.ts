import { useSyncExternalStore } from 'react';

class ResourceStore {
  itemsRevision = 0;
  private version = 0;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.version;
  handleEvent(event: { type?: string }) {
    if (event.type !== 'items_changed') return;
    this.itemsRevision++;
    this.version++;
    this.listeners.forEach((listener) => listener());
  }
}

export const resources = new ResourceStore();

export function useItemsRevision() {
  useSyncExternalStore(resources.subscribe, resources.snapshot);
  return resources.itemsRevision;
}
