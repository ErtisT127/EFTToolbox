// Third-party software and data this build ships. `thirdParty` drives the About library list;
// packaged notices also include `redistributed` and `displayNotices`.

/** The projects the About page thanks. Generated output is sorted A-Z by name. */
export const thirdParty = [
  { name: 'BruTile', license: 'Apache-2.0', url: 'https://github.com/BruTile/BruTile' },
  { name: 'ExCSS', license: 'MIT', url: 'https://github.com/TylerBrinks/ExCSS' },
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
  { name: 'Newtonsoft.Json', license: 'MIT', url: 'https://www.newtonsoft.com/json' },
  { name: 'Pion', license: 'MIT', url: 'https://pion.ly' },
  { name: 'Masterminds/semver', license: 'MIT', url: 'https://github.com/Masterminds/semver' },
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
 * Bundled software and data sources that belong in shipped notices, not the About library list.
 */
export const redistributed = [
  { name: '.NET', license: 'MIT', url: 'https://dotnet.microsoft.com', note: 'runtime framework' },
  {
    name: 'Barlow Condensed',
    license: 'OFL-1.1',
    url: 'https://fonts.google.com/specimen/Barlow+Condensed',
    note: 'bundled display font',
  },
  {
    name: 'JetBrains Mono',
    license: 'OFL-1.1',
    url: 'https://fonts.google.com/specimen/JetBrains+Mono',
    note: 'bundled display font',
  },
  {
    name: 'Noto Color Emoji',
    license: 'OFL-1.1',
    url: 'https://github.com/googlefonts/noto-emoji',
    note: 'bundled display font',
  },
  {
    name: 'Noto Sans',
    license: 'OFL-1.1',
    url: 'https://fonts.google.com/noto/specimen/Noto+Sans',
    note: 'bundled display font',
  },
  {
    name: 'Noto Sans SC',
    license: 'OFL-1.1',
    url: 'https://fonts.google.com/noto/specimen/Noto+Sans+SC',
    note: 'bundled display font',
  },
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
  'Display font license texts: data/upstream/assets/licenses/*.txt, including data/upstream/assets/licenses/noto-emoji-OFL.txt. All display fonts are licensed under SIL Open Font License 1.1.',
  'Source URLs, pinned versions, source hashes and shipped-file hashes: data/upstream/assets/display-resources.json.',
];
