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
export type SettingsTab = 'system' | 'map' | 'recognition' | 'hotkeys' | 'data';
export const settingsTabs = ['system', 'map', 'recognition', 'hotkeys', 'data'] as const;
