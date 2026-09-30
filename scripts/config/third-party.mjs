// Third-party software and data this build ships. `scripts/generate-third-party.mjs` renders this
// one list into both the About page's thanks list and the packaged THIRD-PARTY-NOTICES.txt.

/** The projects the About page thanks. Generated output is sorted A-Z by name. */
export const thirdParty = [
  { name: '.NET', license: 'MIT', url: 'https://dotnet.microsoft.com' },
  { name: 'BruTile', license: 'Apache-2.0', url: 'https://github.com/BruTile/BruTile' },
  { name: 'coder/websocket', license: 'MIT', url: 'https://github.com/coder/websocket' },
  { name: 'Floating UI', license: 'MIT', url: 'https://floating-ui.com' },
  { name: 'i18next', license: 'MIT', url: 'https://www.i18next.com' },
  { name: 'ImGui.NET', license: 'MIT', url: 'https://github.com/ImGuiNET/ImGui.NET' },
  { name: 'Leaflet', license: 'BSD-2-Clause', url: 'https://leafletjs.com' },
  { name: 'Lucide', license: 'ISC', url: 'https://lucide.dev' },
  { name: 'OpenCvSharp', license: 'Apache-2.0', url: 'https://github.com/shimat/opencvsharp' },
  {
    name: 'PaddleOCRSharp',
    license: 'Apache-2.0',
    url: 'https://github.com/raoyutian/PaddleOCRSharp',
  },
  { name: 'Pion', license: 'MIT', url: 'https://pion.ly' },
  { name: 'React', license: 'MIT', url: 'https://react.dev' },
  { name: 'Redux Toolkit', license: 'MIT', url: 'https://redux-toolkit.js.org' },
  { name: 'Svg.Skia', license: 'MIT', url: 'https://github.com/wieslawsoltes/Svg.Skia' },
  {
    name: 'tarkov.dev',
    license: 'MIT',
    url: 'https://github.com/the-hideout/tarkov-dev',
    note: 'item prices, barter recipes and map data',
  },
  { name: 'Vortice.Windows', license: 'MIT', url: 'https://github.com/amerokolec/Vortice.Windows' },
  { name: 'Wails', license: 'MIT', url: 'https://wails.io' },
];

/**
 * Data this build redistributes: it belongs in the shipped notices, not in the About page's list of
 * projects the app is built from.
 */
export const redistributed = [
  {
    name: 'always-online-stun',
    license: 'MIT',
    url: 'https://github.com/pradt2/always-online-stun',
    note: 'reachability list behind the STUN server picker',
  },
];

/**
 * Display resources are downloaded rather than linked, so their notices point at the license texts
 * and manifest that ship with them. Paths are written from the package root, where the notices are
 * read.
 */
export const displayNotices = [
  'Map fonts: Noto Sans / Noto Sans SC (Google), Barlow Condensed (Jeremy Tribby), JetBrains Mono (JetBrains), SIL Open Font License 1.1. Original copyright notices are in data/upstream/assets/licenses/*.txt.',
  'Emoji: Twemoji 14.0.2, Copyright Twitter, Inc. and other contributors, CC-BY 4.0, https://github.com/twitter/twemoji. Images are unmodified. License: data/upstream/assets/licenses/twemoji-LICENSE-GRAPHICS.',
  'Source URLs, pinned versions, source hashes and shipped-file hashes: data/upstream/assets/display-resources.json.',
];
