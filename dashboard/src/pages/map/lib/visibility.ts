import type {
  Annotation,
  MapPreference,
  MarkerPreferences,
} from '../../../../../contracts/ts/ipc.gen';

/** Per-owner visibility context: hidden/shown are user preferences, active is the live roster. */
export type OwnerVisibility = {
  selfId: string;
  active: Set<string>;
  visible: (ownerId: string) => boolean;
};

/**
 * The one owner-visibility rule, shared by the dashboard map and the cast mirror (the native overlay
 * mirrors it in C#, see overlay/src/scene/OwnerVisibility.cs): a manual hide always wins, your own
 * markers always render unless you hid them yourself, explicitly shown owners render, room members
 * default visible, departed owners default hidden. No identity means nothing is filtered.
 */
export function ownerVisibleFor(context: {
  selfId: string;
  activeOwners: Iterable<string>;
  hiddenOwners: string[];
  shownOwners: string[];
}): ((ownerId: string) => boolean) | undefined {
  if (!context.selfId) return undefined;
  const active = new Set(context.activeOwners);
  return (ownerId: string) =>
    !context.hiddenOwners.includes(ownerId) &&
    (ownerId === context.selfId || context.shownOwners.includes(ownerId) || active.has(ownerId));
}

/** `ownerVisibleFor` as the render context the map canvas consumes; undefined means "show all". */
export function ownerVisibilityFor(context: {
  selfId: string;
  activeOwners: Iterable<string>;
  hiddenOwners: string[];
  shownOwners: string[];
}): OwnerVisibility | undefined {
  const visible = ownerVisibleFor(context);
  return visible
    ? { selfId: context.selfId, active: new Set(context.activeOwners), visible }
    : undefined;
}

/**
 * The owner checkbox transition, shared by the dashboard layer panel and its save path. Checking
 * clears the manual hide and, for an owner that is hidden by default (a departed teammate), records
 * the explicit show; unchecking records the manual hide so the choice survives that owner rejoining.
 * Returns the same object when the toggle changes nothing, so no write is issued.
 */
export function nextMarkerPreferences(
  current: MarkerPreferences,
  ownerId: string,
  visible: boolean,
  context: { selfId: string; activeOwners: Iterable<string> },
): MarkerPreferences {
  const without = (list: string[]) =>
    list.includes(ownerId) ? list.filter((id) => id !== ownerId) : list;
  const withId = (list: string[]) => (list.includes(ownerId) ? list : [...list, ownerId]);
  // A departed owner is hidden by default, so showing one has to be recorded explicitly; your own
  // markers are visible by identity and never need the shown list.
  const explicitlyShown = ownerId !== context.selfId && !new Set(context.activeOwners).has(ownerId);
  const hiddenOwners = visible ? without(current.hiddenOwners) : withId(current.hiddenOwners);
  const shownOwners = visible
    ? explicitlyShown
      ? withId(current.shownOwners)
      : current.shownOwners
    : without(current.shownOwners);
  if (hiddenOwners === current.hiddenOwners && shownOwners === current.shownOwners) return current;
  return { ...current, hiddenOwners, shownOwners };
}

/**
 * Whether an annotation renders at all: the group master switch, the floor, and the owner rule
 * above. Shared by the dashboard map, the cast mirror and (mirrored in C#) the native overlay.
 */
export function isAnnotationVisible(
  a: Annotation,
  preference: MapPreference,
  owners?: OwnerVisibility,
) {
  if (a.floorId !== preference.floorId || !preference.showAnnotations) return false;
  if (owners && !owners.visible(a.ownerId)) return false;
  return true;
}
