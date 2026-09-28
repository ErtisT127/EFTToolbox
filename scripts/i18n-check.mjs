// i18n 键检查（仓库根执行 pnpm run i18n:check）：
//   ① zh/en 键集合对称（互相不多不少）
//   ② 幽灵键：locale 里定义、但代码不可达的 key
//   ③ 缺失键：代码里以字面量使用的 key、但 locale 没定义
//   ④ 占位符：同一 key 在 zh/en 的 {{placeholder}} 集合必须一致
//
// "可达"的判定：
//   - 全库（AST）收集 key 形状的字符串字面量（key 常先存入变量/数组再传给 t()）
//   - FINITE_KEYS：模板动态 key 已逐一溯源的有限展开（如 settings.hotkeyAction.${key} ← hotkeyKeys）
//   - DYNAMIC_NS：后端/数据驱动的动态命名空间，整棵子树保护、不参与幽灵键检测
// 新增 `xxx.${code}` 形式的动态 key 时，把来源登记进下面两个清单之一。
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // 仓库根
const SRC = join(ROOT, 'dashboard', 'src');

// ---- 动态 key 登记表 ----------------------------------------------------
// 后端错误码 / 地图数据 / 贴纸包数据驱动的子树：key 集合由运行期数据决定。
const DYNAMIC_NS = [
  'errors.', // MapPage: `errors.${message}`；Error.message 约定携带 errors.* 键
  'multiplayer.errors.', // MultiplayerControl/MembersPanel: `multiplayer.errors.${code}`
  'items.category.', // 物品分类 id 来自物品数据
  'items.resource.', // 下载任务 id 来自后端任务列表
  'items.phase.', // 更新阶段来自后端 status.phase
  'items.phaseDetail.',
  'map.groups.', // 地图分组 id 来自地图 JSON
  'map.stickers.emoji.', // 贴纸 emoji key 来自贴纸数据
];

// 本地有限集合的模板展开（来源已核对，改动来源时同步这里）：
//   settings.${key}      ← MinimapSettingsPanel/MapSettingsTab: followCenter|followFloor|followZoom
//   settings.${tab}      ← SettingsPage: settingsTabs（pages/settings/types.ts）
//   items.${label}       ← ItemsPage columns
//   nav.${key}           ← AppHeader appPages
//   mode.${label}        ← AppHeader modeMeta
//   settings.hotkeyAction.${key} ← pages/settings/types.ts hotkeyKeys
//   map.tools.names.${id}        ← MapPage tools
//   errorBoundary.${m}.title     ← AppShell 的 5 个 module
//   map.stickers.emoji.${key}    ← StickerPicker builtInEmoji（字面量元组，已可静态推导）
const FINITE_KEYS = [
  'settings.followCenter',
  'settings.followFloor',
  'settings.followZoom',
  'settings.map',
  'settings.hotkeys',
  'settings.recognition',
  'settings.system',
  'items.name',
  'items.trader',
  'items.flea',
  'items.lowest',
  'nav.map',
  'nav.items',
  'nav.calibrator',
  'nav.settings',
  'mode.pvp',
  'mode.pve',
  'mode.season',
  ...[
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
  ].map((k) => `settings.hotkeyAction.${k}`),
  ...['select', 'edit', 'brush', 'marker', 'text', 'eraser'].map((k) => `map.tools.names.${k}`),
  ...['app', 'map', 'calibrator', 'settings', 'items'].map((k) => `errorBoundary.${k}.title`),
];

const KEY_RE =
  /^(status|common|mode|nav|settings|settingsError|calibrator|items|errorBoundary|errors|map|cast|multiplayer)(\.[A-Za-z][A-Za-z0-9_-]*)+$/;
const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;

// ---- 读取 locale --------------------------------------------------------
const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, path, out);
    else out[path] = v;
  }
  return out;
};
const zh = flatten((await import(pathToFileURL(join(SRC, 'i18n/locales/zh-CN.ts')).href)).default);
const en = flatten((await import(pathToFileURL(join(SRC, 'i18n/locales/en-US.ts')).href)).default);
const zhKeys = new Set(Object.keys(zh));
const enKeys = new Set(Object.keys(en));

// ---- AST 收集 key 的使用 ------------------------------------------------
// broad：全库 key 形状字面量（含存入变量/数组再传 t() 的）→ 用于幽灵键检测（宁多勿漏）
// strict：t() 第一个参数内的字面量与模板前缀 → 用于缺失键检测（避免把纯比较用的
//         后端错误码字面量误判为缺失，如 errors.recognition_result_invalid）
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    const s = statSync(p);
    return s.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });

const broad = new Set(FINITE_KEYS);
const tArgLiterals = new Set();
const tArgTemplates = new Set();

const collectTArg = (node) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    if (KEY_RE.test(node.text)) tArgLiterals.add(node.text);
  } else if (ts.isTemplateExpression(node)) {
    tArgTemplates.add(node.head.text);
  }
  ts.forEachChild(node, collectTArg);
};

for (const file of walk(SRC).filter((f) => !f.includes(join('src', 'i18n')))) {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 't') ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 't'))
    ) {
      collectTArg(node.arguments[0]);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (KEY_RE.test(node.text)) broad.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const isProtected = (key) => DYNAMIC_NS.some((ns) => key.startsWith(ns));

// ---- 四项检查 ------------------------------------------------------------
let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(msg);
};

const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));
const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k));
if (onlyZh.length) fail(`[对称] 仅 zh-CN 存在:\n  ${onlyZh.join('\n  ')}`);
if (onlyEn.length) fail(`[对称] 仅 en-US 存在:\n  ${onlyEn.join('\n  ')}`);

const ghosts = [...zhKeys].filter((k) => !broad.has(k) && !isProtected(k));
if (ghosts.length) fail(`[幽灵键] locale 已定义但代码不可达:\n  ${ghosts.join('\n  ')}`);

const missing = [...tArgLiterals].filter((k) => !zhKeys.has(k) || !enKeys.has(k));
if (missing.length) fail(`[缺失键] t() 直接使用但 locale 未定义:\n  ${missing.join('\n  ')}`);

// 每个动态模板前缀必须登记：要么落在 DYNAMIC_NS，要么 FINITE_KEYS 里有以它为前缀的展开
const uncoveredTemplates = [...tArgTemplates].filter(
  (prefix) =>
    !DYNAMIC_NS.some((ns) => prefix.startsWith(ns) || ns.startsWith(prefix)) &&
    !FINITE_KEYS.some((k) => k.startsWith(prefix)),
);
if (uncoveredTemplates.length)
  fail(
    `[模板登记] t() 中的动态模板未登记进 DYNAMIC_NS / FINITE_KEYS:\n  ${uncoveredTemplates.join('\n  ')}`,
  );

// 宽扫描到的 key 形状字面量若 locale 没有、又不在动态命名空间里，说明有经变量传入 t()
// 的 key 未登记（如 map 驱动的 label 数组），要求补进 locale 或登记为动态来源。
const unregistered = [...broad].filter((k) => !zhKeys.has(k) && !enKeys.has(k) && !isProtected(k));
if (unregistered.length)
  fail(`[未登记] 代码存在该形状的 key 但 locale 未定义:\n  ${unregistered.join('\n  ')}`);

const placeholderBad = [];
for (const k of zhKeys) {
  if (!enKeys.has(k)) continue;
  const set = (s) => new Set([...s.matchAll(PLACEHOLDER_RE)].map((m) => m[1].trim()));
  const a = set(zh[k]);
  const b = set(en[k]);
  if (a.size !== b.size || [...a].some((p) => !b.has(p)))
    placeholderBad.push(`${k}: zh {${[...a].join(', ')}} vs en {${[...b].join(', ')}}`);
}
if (placeholderBad.length) fail(`[占位符] zh/en 插值不一致:\n  ${placeholderBad.join('\n  ')}`);

if (failed) {
  console.error('\ni18n:check 未通过');
  process.exit(1);
}
console.log(
  `i18n:check 通过：zh ${zhKeys.size} / en ${enKeys.size} 个 key，t() 模板前缀 ${tArgTemplates.size} 个已全部登记`,
);
