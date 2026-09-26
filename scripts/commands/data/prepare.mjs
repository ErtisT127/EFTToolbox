import { readFile, writeFile, mkdir, copyFile, readdir, rm, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { worldToPixel, tileTransform } from '../../../dashboard/src/pages/map/lib/geometry.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const upstream = path.join(root, 'data/upstream');
const source = path.join(upstream, 'source');
const mode = process.env.EFT_MODE || process.argv[2] || 'pvp';
if (!['pvp', 'pve', 'pvp-season'].includes(mode)) throw new Error(`Unsupported EFT mode: ${mode}`);
const modeSource = path.join(source, mode);
const output = path.join(upstream, 'modes', mode);
const sourceFile = async (name) => {
  const modeFile = path.join(modeSource, name);
  try {
    await readFile(modeFile);
    return modeFile;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(source, name);
  }
};
const read = async (name) => {
  return JSON.parse(await readFile(await sourceFile(name), 'utf8'));
};
const previousBaseline = await read('tarkovdata/maps.json');
const rules = await read('map-rules.json');
const raw = (await read('maps.json')).data;
const tasksData = (await read('tasks.json')).data;
const tasks = Object.values(tasksData.tasks);
const itemsData = (await read('items.json')).data;
const itemImages = new Map(
  JSON.parse(await readFile(path.join(upstream, 'items', 'manifest.json'), 'utf8')).sources.map(
    (s) => [s.source, `/api/assets/${s.file}`],
  ),
);
const staticMarkers = await read('maps-static.json');
// `translations` below merges zh over en, so English map names need their own table. The older
// maps also carry a name in the tarkovdata baseline, but it stops before the newer ones and the
// subtitle would then fall back to a raw id like `the-labyrinth`.
const mapNamesEn = (await read('maps_en.json')).data;
const translations = Object.assign(
  {},
  (await read('maps_en.json')).data,
  (await read('tasks_en.json')).data,
  (await read('maps_zh.json')).data,
  (await read('tasks_zh.json')).data,
  (await read('items_en.json')).data,
  (await read('items_zh.json')).data,
  (await read('traders_en.json')).data,
  (await read('traders_zh.json')).data,
);
const iconMapping = await read('tarkov-dev-icons/mapping.json');
const mapIcons = await read('tarkov-dev-icons/map-icons.json');
const mapTranslations = await read('tarkov-dev-icons/maps-zh.json');
const iconAliases = {
  transit: 'extract_transit',
  boss: 'spawn_boss',
  locks: 'lock',
  switches: 'switch',
  stationaryWeapons: 'stationarygun',
  btrStops: 'btr-stop',
  'task/item': 'quest_item',
  'task/objective': 'quest_objective',
};
// Hazard labels are taken from the snapshot's own translation of `hazard.name`, the same way
// upstream labels its layers, so the layer name can never disagree with the marker name. This
// table only covers values upstream ships untranslated (an identity entry such as Hazard).
const hazardNames = { hazard: '危险区' };
const factionNames = { pmc: 'PMC', scav: 'Scav', shared: '共享', sniper_scav: '狙击手 Scav' };
const adaptationData = JSON.parse(
  await readFile(path.join(root, 'scripts/config/map-adaptations.json'), 'utf8'),
);
const adaptations = adaptationData.maps;
const text = (value) => translations[value] || value || '';
// Every file under assets, as paths relative to it; sticker references are validated against this.
async function walkFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      files.push(...(await walkFiles(path.join(directory, entry.name), relative)));
    else files.push(relative);
  }
  return files;
}
const report = { mode, maps: [], omittedMaps: [], unsupportedMaps: [], sources: [] };
const baseline = {};
for (const group of rules) {
  const rule = group.maps.find((m) => m.projection === 'interactive');
  if (!rule) continue;
  const api = Object.values(raw.maps).find((m) => m.normalizedName === group.normalizedName);
  if (!rule.svgPath && !rule.tilePath) {
    report.unsupportedMaps.push({
      id: group.normalizedName,
      reason: 'Upstream currently provides tiles only; no SVG for this mode',
    });
    continue;
  }
  const previous = Object.entries(previousBaseline).find(([, m]) => m.tdevId === api?.id);
  const id = previous?.[0] || group.normalizedName;
  const baseId = rule.svgLayer || 'base';
  const layers = (rule.layers || [])
    .filter((l) => l.svgLayer || l.tilePath)
    .map((l, i) => ({
      ...l,
      id: l.svgLayer || (l.tilePath === rule.tilePath ? baseId : `level-${i}`),
    }));
  baseline[id] = {
    id: Object.keys(baseline).length,
    tdevId: api?.id,
    ruleMap: group.normalizedName,
    nameId: api?.nameId || '',
    scenePath: api?.scenePath || '',
    rule,
    layers,
    locale: { en: previous?.[1].locale.en || group.normalizedName },
    svg: {
      file: rule.svgPath ? path.basename(new URL(rule.svgPath).pathname) : '',
      floors: [...new Set([baseId, ...layers.map((l) => l.id)])],
      defaultFloor: layers.find((l) => l.show)?.id || baseId,
      baseFloor: baseId,
      coordinateRotation: rule.coordinateRotation,
      bounds: rule.svgBounds || rule.bounds,
    },
  };
}
// The field contract is the only thing standing between "upstream added or renamed a field" and a
// silently thinner artifact, so an unknown key must stop the run until a human decides on it.
const fieldContract = JSON.parse(
  await readFile(path.join(root, 'scripts/config/upstream-fields.json'), 'utf8'),
);
const contractRoots = { live: raw, items: itemsData, tasks: tasksData, rules, staticMarkers };
function selectRecords(value, segments) {
  if (!segments.length) return [value];
  const [head, ...rest] = segments;
  const isElement = head.endsWith('[]'),
    isMember = head.endsWith('[*]');
  const key = isElement || isMember ? head.slice(0, head.lastIndexOf('[')) : head;
  const target = key ? value?.[key] : value;
  if (!isElement && !isMember) return selectRecords(target, rest);
  if (Array.isArray(target)) return target.flatMap((entry) => selectRecords(entry, rest));
  return target && typeof target === 'object'
    ? Object.values(target).flatMap((entry) => selectRecords(entry, rest))
    : [];
}
const unknownFields = new Set();
const missingFields = new Set();
let checkedRecords = 0;
for (const surface of fieldContract.surfaces) {
  const [rootName, ...segments] = surface.path.match(/[A-Za-z]+|\[[*]?\]/g);
  const known = new Set(surface.keys);
  const universal = new Set(surface.universal);
  const optional = new Set(surface.optional || []);
  const seen = new Set();
  for (const record of selectRecords(contractRoots[rootName], segments)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    checkedRecords++;
    for (const key of Object.keys(record)) {
      seen.add(key);
      if (!known.has(key)) unknownFields.add(`${surface.path}.${key}`);
    }
    // A rename shows up as an unknown key, but a plain deletion produces no unknown key at all and
    // leaves conservation balanced at zero on both sides, so it has to be caught per record.
    for (const key of universal)
      if (!(key in record) && !optional.has(key)) missingFields.add(`${surface.path}.${key}`);
  }
  for (const key of surface.keys)
    if (!seen.has(key) && !optional.has(key)) missingFields.add(`${surface.path}.${key}`);
}
console.log(`字段契约：${fieldContract.surfaces.length} 个表面，${checkedRecords} 条记录`);
if (unknownFields.size || missingFields.size)
  throw new Error(
    `上游字段与契约不符。确认后修改 scripts/config/upstream-fields.json 中对应 surface：\n${
      unknownFields.size ? `  keys 外的新字段：\n    ${[...unknownFields].join('\n    ')}\n` : ''
    }${
      missingFields.size
        ? `  已消失的字段（keys 或 universal 中）：\n    ${[...missingFields].join('\n    ')}`
        : ''
    }`,
  );
const summaries = [];
const mapOrder = [
  'groundzero',
  'factory',
  'customs',
  'woods',
  'shoreline',
  'interchange',
  'reserve',
  'lighthouse',
  'streetsoftarkov',
  'lab',
  'the-labyrinth',
  'icebreaker',
  'terminal',
];
const mapRanks = new Map(mapOrder.map((id, index) => [id, index]));
// Category ids are shared across maps, so the sticker picker offers each one once no matter how
// many maps carry it.
const catalogCategories = new Map();
await mkdir(path.join(output, 'maps'), { recursive: true });
await mkdir(path.join(upstream, 'assets', 'maps', 'icons'), { recursive: true });
await mkdir(path.join(upstream, 'assets', 'maps', 'svg'), { recursive: true });
for (const icon of new Set(Object.values(iconMapping)))
  await copyFile(
    path.join(source, 'tarkov-dev-icons', `${icon}.png`),
    path.join(upstream, 'assets', 'maps', 'icons', `${icon}.png`),
  );

export function inExtent(position, extent) {
  if (position.y < extent.height[0] || position.y >= extent.height[1]) return false;
  return (
    !extent.bounds ||
    extent.bounds.some(
      ([a, b]) =>
        position.x >= Math.min(a[0], b[0]) &&
        position.x <= Math.max(a[0], b[0]) &&
        position.z >= Math.min(a[1], b[1]) &&
        position.z <= Math.max(a[1], b[1]),
    )
  );
}

for (const [id, meta] of Object.entries(baseline).sort((a, b) => a[1].id - b[1].id)) {
  try {
    const warnings = [],
      skipped = new Map();
    const adaptation = { clock: adaptations[id]?.clock };
    // Every upstream element offered to add() must land in one of these buckets, so a
    // structural change cannot silently shrink the output while the run stays green.
    const counts = { emitted: 0, skipped: 0, dedup: 0, unclassified: 0, lookupMisses: 0 };
    const sites = [];
    let open = null;
    const closeSite = () => {
      if (!open) return;
      sites.push({
        label: open.label,
        intended: open.intended,
        emitted: counts.emitted - open.base.emitted,
        skipped: counts.skipped - open.base.skipped,
        dedup: counts.dedup - open.base.dedup,
        unclassified: counts.unclassified - open.base.unclassified,
        lookupMisses: counts.lookupMisses - open.base.lookupMisses,
      });
      open = null;
    };
    const count = (label, intended) => {
      closeSite();
      open = { label, intended, base: { ...counts } };
    };
    const warn = (reason) => {
      counts.skipped++;
      skipped.set(reason, (skipped.get(reason) || 0) + 1);
    };
    if (!meta.svg) {
      report.omittedMaps.push({ id, reason: 'Missing SVG metadata' });
      continue;
    }
    const svg = meta.svg.file
      ? await readFile(path.join(source, 'current-svg', meta.svg.file), 'utf8')
      : '';
    const doc = svg ? new DOMParser().parseFromString(svg, 'image/svg+xml') : null;
    // Tile-only maps use a stable world-sized plane; the upstream affine transform provides raster placement.
    const angle = (meta.svg.coordinateRotation * Math.PI) / 180;
    const dx = Math.abs(meta.svg.bounds[1][0] - meta.svg.bounds[0][0]),
      dy = Math.abs(meta.svg.bounds[1][1] - meta.svg.bounds[0][1]);
    const viewBox = doc
      ? doc.documentElement.getAttribute('viewBox').split(/[ ,]+/).map(Number)
      : [
          0,
          0,
          Math.abs(Math.cos(angle)) * dx + Math.abs(Math.sin(angle)) * dy,
          Math.abs(Math.sin(angle)) * dx + Math.abs(Math.cos(angle)) * dy,
        ];
    const groupIds = doc ? [...doc.getElementsByTagName('g')].map((g) => g.getAttribute('id')) : [];
    const groupFor = (f) => f;
    const floors = meta.svg.floors.map((f) => ({
      id: f,
      name: f.replaceAll('_', ' '),
      svgGroups: groupIds.includes(groupFor(f)) ? [groupFor(f)] : [],
    }));
    const requiredGroups = [meta.rule.svgLayer, ...meta.layers.map((l) => l.svgLayer)].filter(
      Boolean,
    );
    const missing = requiredGroups.filter((f) => !groupIds.includes(f));
    if (missing.length) throw new Error(`底图缺少楼层组：${missing.join(', ')}`);
    if (
      !Number.isFinite(meta.svg.coordinateRotation) ||
      !Array.isArray(meta.svg.bounds) ||
      meta.svg.bounds.length !== 2 ||
      meta.svg.bounds.some((p) => p.length !== 2 || !p.every(Number.isFinite)) ||
      meta.svg.bounds[0][0] === meta.svg.bounds[1][0] ||
      meta.svg.bounds[0][1] === meta.svg.bounds[1][1]
    )
      throw new Error('Missing or degenerate projection bounds/rotation');
    if (
      viewBox.length !== 4 ||
      !viewBox.every(Number.isFinite) ||
      viewBox[2] <= 0 ||
      viewBox[3] <= 0 ||
      !floors.some((f) => f.id === meta.svg.defaultFloor)
    ) {
      report.omittedMaps.push({ id, reason: 'Invalid viewBox or default floor' });
      continue;
    }
    // SVGs are source assets, not active web documents. Reject executable/external content.
    if (
      /<(?:script|foreignObject)\b|\bon\w+\s*=|(?:href|url\()\s*=?\s*["']?(?:https?:|javascript:|data:)/i.test(
        svg,
      )
    )
      throw new Error(`Unsafe SVG: ${id}`);
    // A missing anchor would otherwise degrade to a marker-less map with exit code 0.
    const apiMap = raw.maps[meta.tdevId];
    if (!apiMap)
      throw new Error(
        meta.tdevId
          ? `上游 API 缺少地图 "${meta.tdevId}"（规则组 ${meta.ruleMap}），规则已失效`
          : `上游 API 中找不到规则组 "${meta.ruleMap}" 的 normalizedName 对应地图`,
      );
    const ruleMap = rules.find((r) => r.normalizedName === meta.ruleMap);
    const rule = ruleMap?.maps.find((m) => m.projection === 'interactive');
    const floorIds = new Set(floors.map((f) => f.id));
    const baseFloor = meta.svg.baseFloor;
    if (floors.length > 1 && (!rule || !floorIds.has(baseFloor)))
      throw new Error('Missing multi-floor rule or explicit base floor');
    const layerRules = meta.layers.flatMap((layer) => {
      const floorId = layer.id;
      const floor = floors.find((f) => f.id === floorId);
      if (floor) floor.name = mapTranslations[layer.name] || layer.name;
      return floorIds.has(floorId) ? [{ floorId, extents: layer.extents || [] }] : [];
    });
    const base = floors.find((f) => f.id === baseFloor);
    if (base && !meta.layers.some((layer) => layer.id === baseFloor))
      base.name = mapTranslations['1st Floor'] || base.name;
    if (floors.length > 1)
      for (const floor of floors) {
        if (floor.id !== baseFloor && !layerRules.some((r) => r.floorId === floor.id))
          warnings.push(`${floor.name} 缺少高度规则，仅显示明确归属该层的数据`);
      }
    const assign = (p) => {
      if (floors.length === 1) return [floors[0].id];
      const matches = layerRules
        .filter((r) => r.extents.some((e) => inExtent(p, e)))
        .map((r) => r.floorId);
      if (matches.length) return matches;
      if (
        floorIds.has(baseFloor) &&
        (!rule.heightRange || inExtent(p, { height: rule.heightRange }))
      )
        return [baseFloor];
      return [];
    };
    const projection = {
      rotation: meta.svg.coordinateRotation,
      bounds: meta.svg.bounds.map(([x, z]) => ({ x, z })),
      viewBox,
    };
    const tiles = [];
    const addTiles = (floorId, url) => {
      if (!url || tiles.some((t) => t.sourceUrl === url && t.floorId === floorId)) return;
      if (
        !/^https:\/\/assets\.tarkov\.dev\/maps\/.+\/\{z\}\/\{x\}\/\{y\}\.png$/.test(url) ||
        !Array.isArray(rule.transform) ||
        rule.transform.length !== 4 ||
        !rule.transform.every(Number.isFinite) ||
        rule.transform[0] <= 0 ||
        rule.transform[2] <= 0 ||
        !Array.isArray(rule.bounds) ||
        rule.bounds.length !== 2 ||
        !rule.bounds.every((p) => p.length === 2 && p.every(Number.isFinite))
      )
        throw new Error(`Invalid tile URL, transform or bounds: ${floorId}`);
      const layerId = `raster-${tiles.length}`;
      tiles.push({
        id: layerId,
        floorId,
        sourceUrl: url,
        url: `/api/map-tiles/${id}/${layerId}/{z}/{x}/{y}.png`,
        tileSize: rule.tileSize || 256,
        minZoom: rule.minZoom || 1,
        maxZoom: rule.maxZoom || 6,
        transform: tileTransform(projection, rule.transform),
        bounds: rule.bounds.map(([x, z]) => worldToPixel({ x, z }, projection)),
      });
    };
    addTiles(baseFloor, rule.tilePath);
    for (const layer of meta.layers) addTiles(layer.id, layer.tilePath);
    const categories = new Map(),
      markers = [],
      mapTasks = new Map();
    const category = (key, name, groupId, color, symbol) => {
      const icon =
        iconMapping[
          iconAliases[key] || (key.startsWith('loose/') ? 'loose_loot' : key.replaceAll('/', '_'))
        ] || (symbol === 'hazard' ? iconMapping.hazard : undefined);
      if (!categories.has(key))
        categories.set(key, {
          id: key,
          name,
          groupId,
          color,
          symbol,
          iconUrl: icon ? `/api/assets/maps/icons/${icon}.png` : '',
        });
      return key;
    };
    function add(entry, categoryId, name, taskId = '', explicit) {
      const p = entry.position;
      if (!explicit && (!p || ![p.x, p.z].every(Number.isFinite))) {
        warn('missing coordinates');
        return;
      }
      // An empty floor list means unresolved elevation, not an invented floor.
      // Keep a projectable point visible on all floors until its rule is available.
      const assigned = explicit
        ? floorIds.has(explicit.floor)
          ? [explicit.floor]
          : []
        : Number.isFinite(p.y)
          ? assign(p)
          : [];
      const position = explicit
        ? {
            x: viewBox[0] + (explicit.leftPercent * viewBox[2]) / 100,
            y: viewBox[1] + (explicit.topPercent * viewBox[3]) / 100,
          }
        : worldToPixel({ x: p.x, z: p.z }, projection);
      if (![position.x, position.y].every(Number.isFinite)) {
        warn('missing coordinates');
        return;
      }
      const markerId = createHash('sha256')
        .update(JSON.stringify([id, categoryId, entry.id || '', name, p || position, taskId]))
        .digest('hex')
        .slice(0, 24);
      if (markers.some((m) => m.id === markerId)) {
        counts.dedup++;
        return;
      }
      counts.emitted++;
      markers.push({
        id: markerId,
        name: text(name),
        categoryId,
        // Normalised so the primary always leads and nothing repeats. The `used` union, the
        // conservation accounting and the dashboard's visibility predicate all rely on both, and an
        // empty array would slip past a plain `||` default because `[]` is truthy.
        categoryIds: [...new Set([categoryId, ...(entry.categoryIds || [])])],
        floorIds: entry.floorIds || assigned,
        position,
        outline: (entry.outline || [])
          .filter((p) => [p.x, p.z].every(Number.isFinite))
          .map((p) => worldToPixel({ x: p.x, z: p.z }, projection)),
        taskId,
        iconUrl: entry.iconUrl || '',
        labelSize: entry.labelSize || 100,
        labelRotation: entry.labelRotation || 0,
      });
    }
    const green = '#7BC576',
      blue = '#4F9FB3',
      gold = '#C8A24A',
      red = '#C4554B';
    count('extracts', (apiMap?.extracts || []).length);
    for (const e of apiMap?.extracts || [])
      add(
        e,
        category(
          `extract/${e.faction}`,
          factionNames[e.faction] || '共享',
          'extracts',
          green,
          'exit',
        ),
        e.name,
      );
    count('transits', (apiMap?.transits || []).length);
    for (const e of apiMap?.transits || [])
      add(
        e,
        category('transit', '转移点', 'extracts', green, 'exit'),
        e.description || `前往 ${text(raw.maps[e.map]?.name)}`,
      );
    count('spawns', (apiMap?.spawns || []).length);
    for (const e of apiMap?.spawns || []) {
      const flags = e.categories || [],
        sides = e.sides || [];
      // A `player` flag only settles the side when the zone is actually PMC. Returning early
      // otherwise drops every player-capable scav zone, so it has to fall through instead.
      const side = flags.includes('boss')
        ? !apiMap.bosses.some((boss) =>
            boss.spawnLocations.some((location) => location.spawnKey === e.zoneName),
          ) &&
          flags.includes('bot') &&
          sides.includes('scav')
          ? 'scav'
          : ''
        : flags.includes('player') && (sides.includes('pmc') || sides.includes('all'))
          ? 'pmc'
          : flags.includes('sniper')
            ? 'sniper_scav'
            : sides.includes('scav') && (flags.includes('bot') || flags.includes('all'))
              ? 'scav'
              : '';
      // Anything left unresolved is counted in `unclassified` and not drawn. Most of it is `botpmc`
      // (mobs.PmcBot, i.e. Raiders): upstream ships no spawn_raider icon and tarkov.dev's own map
      // drops the same entries (src/pages/map/index.jsx), so this is a gap we share with it rather
      // than one we introduced. Those points mostly stay visible through the same zone's scav row,
      // and the remaining boss-flagged ones are drawn by the bosses loop below.
      if (side)
        add(
          e,
          category(`spawn/${side}`, factionNames[side], 'spawns', blue, 'spawn'),
          `${factionNames[side]} 出生点`,
        );
      else counts.unclassified++;
    }
    count(
      'bosses',
      (apiMap?.bosses || []).reduce(
        (n, b) => n + (b.spawnLocations || []).reduce((m, l) => m + (l.positions || []).length, 0),
        0,
      ),
    );
    for (const boss of apiMap?.bosses || []) {
      const mob = raw.mobs[boss.mob];
      if (!mob) counts.lookupMisses++;
      const specific = mob && iconMapping[`spawn_${mob.normalizedName}`];
      for (const location of boss.spawnLocations || [])
        for (const position of location.positions || [])
          add(
            { position },
            category(
              specific ? `spawn/${mob.normalizedName}` : 'boss',
              specific ? text(mob.name) : 'Boss',
              'spawns',
              red,
              'boss',
            ),
            text(raw.mobs[boss.mob]?.name || boss.mob),
          );
    }
    for (const [key, label, symbol] of [
      ['locks', '锁', 'lock'],
      ['switches', '开关', 'switch'],
      ['stationaryWeapons', '固定机枪', 'weapon'],
    ]) {
      count(key, (apiMap?.[key] || []).length);
      for (const e of apiMap?.[key] || [])
        add(
          e.position ? e : { ...e, position: e },
          category(key, label, 'usable', blue, symbol),
          e.name || label,
        );
    }
    count('btrStops', (apiMap?.btrStops || []).length);
    for (const stop of apiMap?.btrStops || [])
      add(
        { ...stop, position: stop },
        category('btrStops', 'BTR 停车点', 'landmarks', blue, 'btr'),
        stop.name,
      );
    count('hazards', (apiMap?.hazards || []).length);
    for (const e of apiMap?.hazards || []) {
      const translated = text(e.name);
      add(
        e,
        category(
          `hazard/${e.hazardType}`,
          translated === e.name ? hazardNames[e.hazardType] || e.hazardType : translated,
          'hazards',
          red,
          'hazard',
        ),
        e.name || e.hazardType,
      );
    }
    count('artillery zones', (apiMap?.artillery?.zones || []).length);
    for (const zone of apiMap?.artillery?.zones || [])
      add(zone, category('hazard/mortar', '迫击炮', 'hazards', red, 'hazard'), '迫击炮轰击区域');
    count('lootContainers', (apiMap?.lootContainers || []).length);
    for (const e of apiMap?.lootContainers || []) {
      const c = raw.lootContainers[e.lootContainer];
      if (!c) counts.lookupMisses++;
      add(
        e,
        category(
          `container/${c?.normalizedName || e.lootContainer}`,
          text(c?.name || '容器'),
          'containers',
          gold,
          'container',
        ),
        text(c?.name || '容器'),
      );
    }
    count('lootLoose', (apiMap?.lootLoose || []).length);
    for (const e of apiMap?.lootLoose || []) {
      const resolved = (e.items || []).map((id) => itemsData.items[id]);
      if (resolved.some((item) => !item)) counts.lookupMisses++;
      const items = resolved.filter(Boolean);
      // A point belongs to every handbook category of the items that can spawn there rather than to
      // one of them: filtering by "medical supplies" has to keep a point that may also yield food.
      // Upstream adds the marker to each of those layers for the same reason and has no generic layer
      // at all.
      const groups = [...new Set(items.map((i) => i.handbookCategories[0]).filter(Boolean))];
      // Nothing to file the point under. Skipping keeps the accounting exact and leaves the count
      // visible in the report, rather than inventing a category the panel would then have to list.
      if (!groups.length) {
        warn('unresolved loose loot items');
        continue;
      }
      const categoryIds = groups.map((id) => `loose/${id}`);
      // Every category the point belongs to has to be created, not just its primary one: the panel
      // lists whatever categories were emitted, so an id that only ever appears as a secondary would
      // never exist and the dashboard would have nothing to resolve it against.
      for (const [index, id] of categoryIds.entries()) {
        const group = itemsData.handbookCategories[groups[index]];
        category(id, group ? text(group.name) : id, 'loose', gold, 'loot');
        if (group && itemImages.has(group.imageLink))
          categories.get(id).iconUrl = itemImages.get(group.imageLink);
      }
      const only = groups.length === 1 ? itemsData.handbookCategories[groups[0]] : null;
      const single = items.length === 1 ? items[0] : null;
      // One item shows itself, one category shows itself, and a point spanning several categories is
      // a collection with no single image to borrow, so it falls back to the generic loot icon.
      const collection = groups.length > 1 ? iconMapping.loose_loot : null;
      add(
        {
          ...e,
          categoryIds,
          iconUrl: collection
            ? `/api/assets/maps/icons/${collection}.png`
            : itemImages.get(single ? single.baseImageLink : only?.imageLink) || '',
        },
        // The primary only steers symbol, colour and the popup label; membership is the whole list.
        categoryIds[0],
        items.length ? items.map((i) => text(i.name)).join('、') : '散落物资',
      );
    }
    for (const task of tasks)
      for (const objective of task.objectives || []) {
        const key = category(
          objective.type === 'findQuestItem' ? 'task/item' : 'task/objective',
          objective.type === 'findQuestItem' ? '物品' : '目标',
          'tasks',
          gold,
          'task',
          true,
        );
        const before = markers.length;
        const zones = (objective.zones || []).filter((zone) => zone.map === meta.tdevId);
        count('task zones', zones.length);
        for (const zone of zones) add(zone, key, objective.description, task.id);
        const positions = (objective.possibleLocations || []).flatMap((loc) =>
          loc.map === meta.tdevId ? loc.positions || [] : [],
        );
        count('task positions', positions.length);
        for (const position of positions) add({ position }, key, objective.description, task.id);
        if (markers.length > before) mapTasks.set(task.id, { id: task.id, name: text(task.name) });
      }
    for (const [key, entries] of Object.entries(staticMarkers[meta.ruleMap] || {})) {
      count(`static ${key}`, entries.length);
      for (const entry of entries)
        add(
          entry,
          category(
            key,
            factionNames[key.replace('spawn_', '')] || key.replaceAll('_', ' '),
            'spawns',
            blue,
            'spawn',
          ),
          entry.name,
        );
    }
    count('labels', (rule?.labels || []).length);
    for (const label of rule?.labels || []) {
      const labelSize = Number(label.size || 100),
        labelRotation = Number(label.rotation || 0);
      if (!Number.isFinite(labelSize) || labelSize <= 0 || !Number.isFinite(labelRotation))
        throw new Error(`Invalid landmark typography: ${label.text}`);
      // Reference markerIsOnLayer: labels span a vertical interval, not just their bottom height.
      const bottom = label.bottom ?? -1000,
        top = label.top ?? 1000;
      const position = { x: label.position[0], z: label.position[1] };
      const overlaps = (extent) =>
        top >= extent.height[0] &&
        bottom < extent.height[1] &&
        inExtent({ ...position, y: Math.max(bottom, extent.height[0]) }, extent);
      const containingRooms = layerRules.filter((layer) =>
        layer.extents.some(
          (extent) =>
            extent.bounds &&
            bottom >= extent.height[0] &&
            top <= extent.height[1] &&
            overlaps(extent),
        ),
      );
      const labelFloors = [
        { floorId: baseFloor, extents: [{ height: rule.heightRange || [-1000, 1000] }] },
        ...layerRules,
      ]
        .filter(
          (layer) =>
            layer.extents.some(overlaps) &&
            containingRooms.every((room) => room.floorId === layer.floorId),
        )
        .map((layer) => layer.floorId);
      add(
        {
          position,
          floorIds: [...new Set(labelFloors)],
          labelSize,
          labelRotation,
        },
        category('landmark', '地名', 'landmarks', '#C8C2A6', 'label'),
        mapTranslations[label.text] || label.text,
      );
    }
    closeSite();
    const consumed = sites.reduce(
      (total, site) => {
        total.intended += site.intended;
        total.emitted += site.emitted;
        total.skipped += site.skipped;
        total.dedup += site.dedup;
        total.unclassified += site.unclassified;
        total.lookupMisses += site.lookupMisses;
        return total;
      },
      { intended: 0, emitted: 0, skipped: 0, dedup: 0, unclassified: 0, lookupMisses: 0 },
    );
    const unbalanced = sites.filter(
      (site) => site.intended !== site.emitted + site.skipped + site.dedup + site.unclassified,
    );
    if (unbalanced.length) {
      const byLabel = new Map();
      for (const site of unbalanced) {
        const row = byLabel.get(site.label) || { intended: 0, accounted: 0 };
        row.intended += site.intended;
        row.accounted += site.emitted + site.skipped + site.dedup + site.unclassified;
        byLabel.set(site.label, row);
      }
      throw new Error(
        `守恒校验未通过 ${unbalanced.length} 处：\n${[...byLabel]
          .map(([label, row]) => `  ${label}: 输入 ${row.intended}，已交代 ${row.accounted}`)
          .join('\n')}`,
      );
    }
    // Every id a marker belongs to, not just its primary: a category referenced only as a secondary
    // would otherwise be dropped here and the dashboard would fail to resolve the marker's category.
    const used = new Set(markers.flatMap((m) => m.categoryIds));
    if (skipped.size)
      warnings.push(
        `已跳过 ${[...skipped.values()].reduce((a, b) => a + b, 0)} 个缺少可靠坐标或楼层归属的数据点，详见数据校验报告`,
      );
    const map = {
      schemaVersion: 1,
      id,
      name: text(apiMap?.name) || meta.locale.en,
      subtitle: mapNamesEn[apiMap?.name] || meta.locale.en,
      iconUrl: mapIcons[meta.ruleMap] || '',
      defaultFloor: meta.svg.defaultFloor,
      baseFloor: meta.svg.baseFloor,
      svgUrl: meta.svg.file ? `/api/assets/maps/svg/${meta.svg.file}` : '',
      tiles,
      projection,
      floors,
      categories: [...categories.values()].filter((c) => used.has(c.id)),
      markers,
      tasks: [...mapTasks.values()],
      raidDuration: apiMap?.raidDuration || meta.raidDuration?.day || 0,
      players: apiMap?.players || '—',
      clock: {
        ...(adaptation.clock || adaptationData.defaultClock),
        phases: adaptationData.daylightPhases,
      },
      warnings,
    };
    for (const category of map.categories)
      if (!catalogCategories.has(category.id))
        catalogCategories.set(category.id, {
          id: category.id,
          name: category.name,
          group: category.groupId,
          iconUrl: category.iconUrl,
        });
    if (meta.svg.file)
      await copyFile(
        path.join(source, 'current-svg', meta.svg.file),
        path.join(upstream, 'assets', 'maps', 'svg', meta.svg.file),
      );
    await writeFile(path.join(output, 'maps', `${id}.json`), JSON.stringify(map));
    summaries.push({
      id,
      name: map.name,
      subtitle: map.subtitle,
      iconUrl: map.iconUrl,
      defaultFloor: map.defaultFloor,
    });
    report.maps.push({
      id,
      floors: floors.length,
      markers: markers.length,
      tasks: map.tasks.length,
      warnings,
      skipped: Object.fromEntries(skipped),
      consumed,
      retainedWithoutFloor: markers.filter((m) => !m.floorIds.length).length,
      retainedOutsideBounds: markers.filter(
        (m) =>
          m.position.x < viewBox[0] ||
          m.position.y < viewBox[1] ||
          m.position.x > viewBox[0] + viewBox[2] ||
          m.position.y > viewBox[1] + viewBox[3],
      ).length,
      svgSha256: createHash('sha256').update(svg).digest('hex'),
    });
    console.log(
      `${id}: ${floors.length} floors, ${markers.length} markers, ${map.tasks.length} tasks`,
    );
  } catch (error) {
    report.omittedMaps.push({ id, reason: String(error) });
  }
}
// Remove only previously generated maps that the current SVG catalog no longer supports.
for (const file of await readdir(path.join(output, 'maps'))) {
  if (
    file.endsWith('.json') &&
    Object.hasOwn(previousBaseline, file.slice(0, -5)) &&
    !Object.hasOwn(baseline, file.slice(0, -5))
  )
    await unlink(path.join(output, 'maps', file));
}
summaries.sort(
  (a, b) => (mapRanks.get(a.id) ?? mapOrder.length) - (mapRanks.get(b.id) ?? mapOrder.length),
);
await writeFile(path.join(output, 'catalog.json'), JSON.stringify(summaries));
await writeFile(path.join(upstream, 'catalog.json'), JSON.stringify(summaries));
// The game log identifies locations by EFT scene/name ids rather than our stable map id. Keep the
// lookup table mode-local so a mode can evolve independently without changing the public map shape.
const locations = {};
for (const [id, meta] of Object.entries(baseline)) {
  locations[id] = id;
  if (meta.ruleMap) locations[meta.ruleMap] = id;
  if (meta.nameId) locations[meta.nameId] = id;
  if (meta.scenePath) {
    locations[meta.scenePath] = id;
    locations[path.basename(meta.scenePath, path.extname(meta.scenePath))] = id;
  }
}
await writeFile(path.join(output, 'locations.json'), JSON.stringify(locations));
// The sticker picker's built-in images. An entry is only listed when the item pull cached its
// file, so an image upstream stops shipping drops out of the picker instead of rendering as a
// broken tile. Stored annotations reference the id, never the file, so a rename cannot strand
// them. The catalogue is shared by all three modes: each prepare merges its mode's entries into
// data/upstream/stickers.json, keeping ids it has not seen before.
const stickers = [];
const cachedAssets = new Set(await walkFiles(path.join(upstream, 'assets')));
// Entity images arrive as an upstream URL that the item pull mapped to a file; map category icons
// are already a served path, because prepare copies those from the icon mapping itself. Both are
// checked against what is actually on disk.
const sticker = (id, name, group, source) => {
  const iconUrl = source?.startsWith('/api/assets/') ? source : itemImages.get(source);
  if (iconUrl && cachedAssets.has(iconUrl.slice('/api/assets/'.length)))
    stickers.push({ id, name: text(name).trim(), group, iconUrl });
};
const mobsData = (await read('maps.json')).data.mobs;
const tradersData = (await read('traders.json')).data;
const battlePass = '6a35427afc3f27b15905a876';
for (const mob of Object.values(mobsData))
  sticker(`mob:${mob.normalizedName}`, mob.name, 'boss', mob.imagePortraitLink);
for (const trader of Object.values(tradersData))
  sticker(`trader:${trader.normalizedName}`, trader.name, 'trader', trader.imageLink);
for (const item of Object.values(itemsData.items))
  if ((item.types || []).some((type) => type.toLowerCase().includes('key')))
    sticker(`key:${item.id}`, item.name, 'key', item.baseImageLink);
  else if (item.handbookCategories?.[0] === battlePass)
    sticker(`item:${item.id}`, item.name, 'battlepass', item.baseImageLink);
// The handbook category icons stay out of the catalogue on purpose: they belong to the layer
// menu's loose-loot group, and the picker has no category for them, so listing them would put
// tiles in "all" that appear under no heading. item-images still downloads them for that group.
// Only the two layer-menu groups the picker offers: the rest (spawns, hazards, loose loot, tasks)
// are map coverage rather than something you place by hand.
const categoryGroups = { extracts: 'extract', containers: 'container' };
for (const category of catalogCategories.values())
  if (categoryGroups[category.group])
    sticker(
      `category:${category.id}`,
      category.name,
      categoryGroups[category.group],
      category.iconUrl,
    );
// Group order is the picker's category order, so the "all" list and the rail agree without the
// dashboard having to re-sort anything.
const stickerGroupOrder = ['extract', 'trader', 'boss', 'container', 'key', 'battlepass'];
// A normalizedName is not unique on its own: upstream ships `vsRF` and `vsRFSniper` as the same
// `af`, sharing one portrait, so without this the picker would show that tile three times.
const byStickerId = new Map();
for (const entry of stickers) if (!byStickerId.has(entry.id)) byStickerId.set(entry.id, entry);
// Merged into the shared catalogue: an id already present from an earlier mode wins, so the
// refresh order (pvp, pve, pvp-season) decides conflicts deterministically and reruns are
// idempotent. Entries the current mode no longer produces stay listed with their cached files.
const shared = new Map();
try {
  for (const entry of JSON.parse(await readFile(path.join(upstream, 'stickers.json'), 'utf8')))
    // A prior entry survives only while its cached file still exists: a cache purge or an
    // upstream removal must not leave picker tiles pointing at images that are gone.
    if (
      entry.iconUrl?.startsWith('/api/assets/') &&
      cachedAssets.has(entry.iconUrl.slice('/api/assets/'.length))
    )
      shared.set(entry.id, entry);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
for (const entry of byStickerId.values()) if (!shared.has(entry.id)) shared.set(entry.id, entry);
const merged = [...shared.values()].sort(
  (a, b) =>
    stickerGroupOrder.indexOf(a.group) - stickerGroupOrder.indexOf(b.group) ||
    a.name.localeCompare(b.name),
);
await writeFile(path.join(upstream, 'stickers.json'), JSON.stringify(merged));
// The per-mode catalogue files this script used to write are superseded by the shared one.
await rm(path.join(output, 'stickers.json'), { force: true });
console.log(
  `Prepared ${byStickerId.size} stickers for ${mode}; shared catalogue now has ${merged.length}.`,
);
for (const name of [
  'tarkovdata/maps.json',
  'map-rules.json',
  'maps.json',
  'tasks.json',
  'maps_en.json',
  'maps_zh.json',
  'tasks_en.json',
  'tasks_zh.json',
  'items.json',
  'items_zh.json',
  'items_en.json',
  'maps-static.json',
])
  report.sources.push({
    file: path.relative(source, await sourceFile(name)).replaceAll(path.sep, '/'),
    sha256: createHash('sha256')
      .update(await readFile(await sourceFile(name)))
      .digest('hex'),
  });
for (const name of ['map-adaptations.json', 'upstream-fields.json'])
  report.sources.push({
    file: `scripts/config/${name}`,
    sha256: createHash('sha256')
      .update(await readFile(path.join(root, 'scripts/config', name)))
      .digest('hex'),
  });
await writeFile(
  path.join(output, 'validation-report.json'),
  JSON.stringify(report, null, 2) + '\n',
);
if (report.omittedMaps.length) {
  console.error(
    `Some maps could not be prepared; see data/upstream/modes/${mode}/validation-report.json\n  ${report.omittedMaps.map((m) => m.id).join(', ')}`,
  );
  process.exitCode = 1;
}
await writeFile(
  path.join(output, 'versions.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      gameModes: [mode],
      ...(await read('versions.json')),
      rulesSource: (await read('versions.json')).sources.find((s) => s.file === 'map-rules.json')
        .source,
      hashes: report.sources,
      svgAssets: await read('current-svg/versions.json'),
      iconAssets: await read('tarkov-dev-icons/versions.json'),
      itemAssets: JSON.parse(await readFile(path.join(upstream, 'items', 'manifest.json'), 'utf8')),
    },
    null,
    2,
  ) + '\n',
);
