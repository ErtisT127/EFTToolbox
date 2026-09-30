export const hotkeyKeys = [
  'toggleEdit',
  'toggleVisible',
  'zoomIn',
  'zoomOut',
  'floorUp',
  'floorDown',
  'toggleBasemap',
  'panUp',
  'panDown',
  'panLeft',
  'panRight',
  'recognition',
] as const;

export type HotkeyKey = (typeof hotkeyKeys)[number];

// The capture key belongs to the recognition popup rather than the minimap, so the hotkeys tab lists
// it in its own group. Both groups come from the one list, which is also what the conflict check reads.
export const minimapHotkeyKeys: readonly HotkeyKey[] = hotkeyKeys.filter(
  (key) => key !== 'recognition',
);
export const recognitionHotkeyKeys: readonly HotkeyKey[] = hotkeyKeys.filter(
  (key) => key === 'recognition',
);

export type SettingsTab = 'system' | 'map' | 'recognition' | 'hotkeys' | 'data' | 'about';
export const settingsTabs = ['system', 'map', 'recognition', 'hotkeys', 'data', 'about'] as const;
