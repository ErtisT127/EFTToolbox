import type { ItemsCatalogItem } from '../../../../contracts/ts/ipc.gen';

export const itemCategories = [
  'headsets',
  'headgear',
  'eyewear',
  'body-armor',
  'tactical-rigs',
  'backpacks',
  'ammo',
  'weapons',
  'weapon-parts-mods',
  'pistol-grips',
  'suppressors',
  'throwables',
  'storage-containers',
  'barter-items',
  'keys',
  'provisions',
] as const;

export type ItemSort = 'id' | 'name' | 'traderPrice' | 'fleaPrice' | 'lowestPrice';

export function filterItems(items: ItemsCatalogItem[], query: string, category: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      (!normalized || item.name.toLocaleLowerCase().includes(normalized)) &&
      (category === '' || item.categories.includes(category)),
  );
}

export function sortItems(items: ItemsCatalogItem[], sort: ItemSort, descending: boolean) {
  return [...items].sort((a, b) => {
    if (sort === 'id') return (descending ? -1 : 1) * a.id.localeCompare(b.id);
    if (sort === 'name') return (descending ? -1 : 1) * a.name.localeCompare(b.name);
    const left = a[sort];
    const right = b[sort];
    if (left === null && right === null) return a.name.localeCompare(b.name);
    if (left === null) return 1;
    if (right === null) return -1;
    return (descending ? -1 : 1) * (left - right || a.name.localeCompare(b.name));
  });
}

export function formatPrice(value: number | null) {
  return value === null ? '—' : `${value.toLocaleString('en-US')} ₽`;
}

// Barter offers can require fractional amounts (upstream reports e.g. 155.1 rounds of ammo).
export function formatCount(value: number) {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
