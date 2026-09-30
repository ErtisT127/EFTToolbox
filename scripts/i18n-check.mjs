// i18n 键检查（仓库根执行 pnpm run i18n:check）：
// 键对称与占位符一致性已由 contracts 生成器（pnpm contracts）强制，这里只查代码侧：
//   ① 幽灵键：locale 里定义、但代码不可达的 key
//   ② 缺失键：代码里以字面量使用的 key、但 locale 没定义
//   ③ 动态键登记：模板动态 key 必须登记进 DYNAMIC_NS 或 FINITE_KEYS
//
// "可达"的判定：
//   - 全库（AST）收集 key 形状的字符串字面量（key 常先存入变量/数组再传给 t()）
//   - FINITE_KEYS：模板动态 key 已逐一溯源的有限展开（如 settings.hotkeyActions.${key} ← hotkeyKeys）
//   - DYNAMIC_NS：后端/数据驱动的动态命名空间，整棵子树保护、不参与幽灵键检测
// 新增 `xxx.${code}` 形式的动态 key 时，把来源登记进下面两个清单之一。
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // 仓库根
const SRC = join(ROOT, 'dashboard', 'src');

// ---- 动态 key 登记表 ----------------------------------------------------
// 后端错误码 / 数据 id 驱动的子树：key 集合由运行期数据决定。
const DYNAMIC_NS = [
  'errors.', // MapPage: `errors.${message}`；Error.message 约定携带 errors.* 键
  'settings.dataManagement.cards.', // DataManagementTab: reset 卡片 id 与冲突键同名
  'data.category.', // 物品分类 id 来自物品数据
  'data.resource.', // 下载任务 id 来自后端任务列表
  'data.phase.', // 更新阶段来自后端 status.phase
  'data.phaseDetail.',
  'data.mapGroups.', // 地图分组 id 来自地图 JSON
  'map.stickers.emoji.', // 贴纸 emoji key 来自贴纸数据
];

// 本地有限集合的模板展开（来源已核对，改动来源时同步这里）：
//   minimap.${key}       ← MinimapSettingsPanel/MapSettingsTab: followCenter|followFloor|followZoom
//   settings.tabs.${tab} ← SettingsPage: settingsTabs（pages/settings/types.ts）
//   items.${label}       ← ItemsPage columns
//   nav.${key}           ← AppHeader appPages
//   mode.${label}        ← AppHeader modeMeta
//   settings.hotkeyActions.${key} ← pages/settings/types.ts hotkeyKeys
//   map.tools.names.${id}        ← MapPage tools
//   errorBoundary.${m}.title     ← AppShell 的 5 个 module
const FINITE_KEYS = [
  'minimap.followCenter',
  'minimap.followFloor',
  'minimap.followZoom',
  ...['system', 'map', 'recognition', 'hotkeys', 'data', 'about'].map((k) => `settings.tabs.${k}`),
  // AboutTab: the check button names the phase it is in.
  ...['check', 'recheck', 'checking'].map((k) => `settings.about.${k}`),
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
  'mode.pvpSeason',
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
  ].map((k) => `settings.hotkeyActions.${k}`),
  ...['select', 'edit', 'brush', 'marker', 'text', 'eraser'].map((k) => `map.tools.names.${k}`),
  ...['app', 'map', 'calibrator', 'settings', 'items'].map((k) => `errorBoundary.${k}.title`),
  // lib/invite.ts: 邀请文案格式化/解析经生成 messages bundle 的属性访问消费这组固定 key，
  // 无 t() 字面量可扫，来源 key 集改动时同步这里。
  'multiplayer.shareHeader',
  'multiplayer.stunTitle',
  'multiplayer.lanMode',
  'multiplayer.invite.mode',
  'multiplayer.invite.host',
  'multiplayer.invite.stun',
  'multiplayer.invite.password',
];

const NS_SOURCE =
  '(?:common|nav|mode|settings|minimap|gameMonitor|recognition|items|map|calibrator|cast|multiplayer|errorBoundary|host|titleBar|data|errors)';
const KEY_RE = new RegExp(`^${NS_SOURCE}(\\.[A-Za-z][A-Za-z0-9_-]*)+$`);

// ---- 读取 locale --------------------------------------------------------
const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, path, out);
    else out[path] = v;
  }
  return out;
};
const zh = flatten(JSON.parse(readFileSync(join(ROOT, 'contracts', 'i18n', 'zh-CN.json'), 'utf8')));
const en = flatten(JSON.parse(readFileSync(join(ROOT, 'contracts', 'i18n', 'en-US.json'), 'utf8')));
const zhKeys = new Set(Object.keys(zh));
const enKeys = new Set(Object.keys(en));

// ---- AST 收集 key 的使用 ------------------------------------------------
// broad：全库 key 形状字面量（含存入变量/数组再传 t() 的）→ 用于幽灵键检测（宁多勿漏）
// strict：t() 第一个参数内的字面量与模板前缀 → 用于缺失键检测（避免把纯比较用的
//         后端错误码字面量误判为缺失，如 errors.recognition_result_invalid）
const walk = (dir, pattern = /\.(ts|tsx)$/) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    const s = statSync(p);
    return s.isDirectory() ? walk(p, pattern) : pattern.test(name) ? [p] : [];
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

for (const file of walk(SRC)) {
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

// overlay 进程用生成的 Messages.Get/Has 消费同一棵键树，其 C# 字符串字面量也算"可达"。
const OVERLAY = join(ROOT, 'overlay', 'src');
for (const file of walk(OVERLAY, /\.cs$/)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(
    new RegExp(`"(${NS_SOURCE}(?:\\.[A-Za-z][A-Za-z0-9_-]*)+)"`, 'g'),
  )) {
    broad.add(match[1]);
  }
}

// 桌面宿主是 Go 侧的文案消费者（托盘菜单、关闭弹窗、启动错误页），它同样用 key 字面量调用
// 生成的 contracts.MessageText，所以宿主的 Go 源码也参与可达性判定。
const HOST = join(ROOT, 'backend', 'cmd', 'EFTToolbox');
for (const file of walk(HOST, /\.go$/)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(
    new RegExp(`"(${NS_SOURCE}(?:\\.[A-Za-z][A-Za-z0-9_-]*)+)"`, 'g'),
  )) {
    broad.add(match[1]);
  }
}

const isProtected = (key) => DYNAMIC_NS.some((ns) => key.startsWith(ns));

// ---- 检查 ------------------------------------------------------------
let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(msg);
};

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
const unregistered = [...broad].filter((k) => !zhKeys.has(k) && !isProtected(k));
if (unregistered.length)
  fail(`[未登记] 代码存在该形状的 key 但 locale 未定义:\n  ${unregistered.join('\n  ')}`);

if (failed) {
  console.error('\ni18n:check 未通过');
  process.exit(1);
}
console.log(
  `i18n:check 通过：zh ${zhKeys.size} / en ${enKeys.size} 个 key，t() 模板前缀 ${tArgTemplates.size} 个已全部登记`,
);
