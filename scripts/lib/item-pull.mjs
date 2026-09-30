// Reusable upstream item pull: snapshot loading/fetching, the content-hash image cache and the
// five-field catalog. CLI commands are thin wrappers; a backend pull entry can reuse the same
// functions and artifact contracts (items/manifest.json and items/{mode}/items_*.json).
import { readFile, writeFile, mkdir, rename, stat, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { download } from './download.mjs';
import { ContractSchemaVersion } from '../../contracts/version.gen.mjs';

export const modes = ['pvp', 'pve', 'pvp-season'];
const upstreamModes = { pvp: 'regular', pve: 'pve', 'pvp-season': 'pvp-season' };
const imageExtensions = ['.webp', '.png', '.jpg'];
const retainedPreviousImages = 2;
const contentImageName = /^(?:item|trader|mob|category)-[0-9a-f]{24}\.(?:webp|png|jpg)$/;

const snapshotUrl = (mode, name) => `https://json.tarkov.dev/${upstreamModes[mode]}/${name}`;

// Snapshots for one mode. items carries the item map plus handbook categories, maps the map and
// mob definitions; traders and the name translations are shared across modes.
export async function fetchModeSnapshots(mode) {
  const data = async (name) =>
    JSON.parse((await download(snapshotUrl(mode, name))).toString()).data;
  const [items, maps, traders, traderNames, zhNames, enNames, tasks, tasksZh, tasksEn, barters] =
    await Promise.all([
      data('items'),
      data('maps'),
      data('traders'),
      data('traders_en'),
      data('items_zh'),
      data('items_en'),
      data('tasks'),
      data('tasks_zh'),
      data('tasks_en'),
      data('barters'),
    ]);
  return snapshotView(
    items,
    maps,
    traders,
    traderNames,
    zhNames,
    enNames,
    tasks,
    tasksZh,
    tasksEn,
    barters,
  );
}

// Same shape as fetchModeSnapshots, but from the snapshots a `data sources` run already stored.
export async function loadModeSnapshots(upstream, mode) {
  const data = async (name, dir = mode) =>
    JSON.parse(await readFile(path.join(upstream, 'source', dir, name), 'utf8')).data;
  const [items, maps, traders, traderNames, zhNames, enNames, tasks, tasksZh, tasksEn, barters] =
    await Promise.all([
      data('items.json'),
      data('maps.json'),
      data('traders.json', '.'),
      data('traders_en.json', '.'),
      data('items_zh.json', '.'),
      data('items_en.json', '.'),
      data('tasks.json'),
      data('tasks_zh.json'),
      data('tasks_en.json'),
      data('barters.json'),
    ]);
  return snapshotView(
    items,
    maps,
    traders,
    traderNames,
    zhNames,
    enNames,
    tasks,
    tasksZh,
    tasksEn,
    barters,
  );
}

const snapshotView = (
  items,
  maps,
  traders,
  traderNames,
  zhNames,
  enNames,
  tasks,
  tasksZh,
  tasksEn,
  barters,
) => ({
  items: items.items,
  handbookCategories: items.handbookCategories,
  mobs: maps.mobs ?? {},
  traders,
  traderNames,
  zhNames,
  enNames,
  tasks: tasks.tasks,
  taskNamesZh: tasksZh,
  taskNamesEn: tasksEn,
  barters,
});

// Every image the map, sticker and catalog surfaces need, keyed by source URL. The prefix feeds
// the content-hash file name; dir is the served namespace under assets/. Traders and mobs are
// not items, which is why they land in portraits/ instead of items/.
export function imageJobs({ items, handbookCategories, traders, mobs }) {
  const jobs = new Map();
  const add = (url, prefix, dir) => {
    if (!url || jobs.has(url)) return;
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (!imageExtensions.includes(ext)) throw new Error(`Unsupported image extension: ${url}`);
    jobs.set(url, { url, prefix, dir, ext });
  };
  // base-image is the clean render: transparent, no grid-cell background, border or shortName
  // text (grid-image bakes all three in, which is wrong for markers, stickers and the catalog).
  for (const item of Object.values(items)) add(item.baseImageLink, 'item-', 'items');
  for (const category of Object.values(handbookCategories))
    add(category.imageLink, 'category-', 'maps/icons');
  for (const trader of Object.values(traders)) add(trader.imageLink, 'trader-', 'portraits');
  for (const mob of Object.values(mobs)) add(mob.imagePortraitLink, 'mob-', 'portraits');
  return [...jobs.values()];
}

// Content-hash cache sync. A URL whose manifest entry still matches its recorded hash on disk is
// skipped; when upstream changes an image the old file moves into `previous`, so references from
// older generations keep resolving. Files are never deleted here, and a failed run leaves the
// manifest untouched because it is rewritten atomically only after every download succeeded.
export async function syncImages(upstream, jobs, concurrency = 6) {
  const assets = path.join(upstream, 'assets');
  const manifestPath = path.join(upstream, 'items', 'manifest.json');
  await Promise.all(
    [...new Set(jobs.map((job) => job.dir))].map((dir) =>
      mkdir(path.join(assets, dir), { recursive: true }),
    ),
  );
  let prior = { fetchedAt: '', sources: [] };
  try {
    prior = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const entries = new Map((prior.sources || []).map((entry) => [entry.source, entry]));
  const queue = [...jobs];
  const results = new Map();
  let downloaded = 0;
  let skipped = 0;
  const cached = async (job, entry) => {
    if (!entry) return false;
    const expected = `${job.dir}/${job.prefix}${entry.sha256.slice(0, 24)}${job.ext}`;
    if (entry.file !== expected) return false;
    try {
      const bytes = await readFile(path.join(assets, entry.file));
      return createHash('sha256').update(bytes).digest('hex') === entry.sha256;
    } catch {
      return false;
    }
  };
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const job = queue.shift();
        if (await cached(job, entries.get(job.url))) {
          results.set(job.url, null);
          skipped++;
          continue;
        }
        const bytes = await download(job.url);
        const digest = createHash('sha256').update(bytes).digest('hex');
        const file = `${job.dir}/${job.prefix}${digest.slice(0, 24)}${job.ext}`;
        const target = path.join(assets, file);
        // Distinct sources can hash to the same file, so the temporary name must be unique per
        // job or two workers would interleave writes into one buffer.
        const temporary = `${target}.${createHash('sha256').update(job.url).digest('hex').slice(0, 8)}.tmp`;
        await writeFile(temporary, bytes);
        await rename(temporary, target);
        results.set(job.url, { file, sha256: digest });
        downloaded++;
        if (downloaded % 50 === 0) console.log(`Cached ${downloaded}/${jobs.length} item images`);
      }
    }),
  );
  // Rebuild the manifest from active jobs. A dropped source survives only while an existing
  // catalog or map still references its file, which lets the next catalog write reclaim it.
  const sources = new Map();
  const jobUrls = new Set(jobs.map((job) => job.url));
  for (const job of jobs) {
    const result = results.get(job.url);
    const entry = entries.get(job.url);
    if (!result) {
      if (entry)
        sources.set(job.url, {
          ...entry,
          previous: (entry.previous ?? []).slice(0, retainedPreviousImages),
        });
      continue;
    }
    const history = [...(entry?.previous ?? [])];
    if (entry && entry.sha256 !== result.sha256)
      history.unshift({ file: entry.file, sha256: entry.sha256 });
    const previous = [];
    for (const stale of history)
      if (stale.sha256 !== result.sha256 && !previous.some((p) => p.sha256 === stale.sha256))
        previous.push(stale);
    sources.set(job.url, {
      source: job.url,
      file: result.file,
      sha256: result.sha256,
      previous: previous.slice(0, retainedPreviousImages),
    });
  }
  const referenced = await referencedImageFiles(upstream);
  for (const [url, entry] of entries) {
    if (jobUrls.has(url)) continue;
    const previous = (entry.previous ?? [])
      .filter((image) => referenced.has(image.file))
      .slice(0, retainedPreviousImages);
    if (referenced.has(entry.file) || previous.length) sources.set(url, { ...entry, previous });
  }
  const manifest = {
    fetchedAt: new Date().toISOString(),
    sources: [...sources.values()].sort((a, b) => a.source.localeCompare(b.source)),
  };
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const staging = `${manifestPath}.tmp`;
  await writeFile(staging, JSON.stringify(manifest, null, 2) + '\n');
  await rename(staging, manifestPath);
  return { manifest, downloaded, skipped };
}

async function referencedImageFiles(upstream) {
  const files = new Set();
  const add = (value) => {
    if (typeof value !== 'string' || !value.startsWith('/api/assets/')) return;
    const file = value.slice('/api/assets/'.length);
    if (/^(?:items|portraits|maps\/icons)\/[A-Za-z0-9_./-]+$/.test(file)) files.add(file);
  };
  const visit = (value) => {
    if (typeof value === 'string') add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  const roots = [
    path.join(upstream, 'stickers.json'),
    path.join(upstream, 'items'),
    path.join(upstream, 'modes'),
  ];
  const walk = async (file) => {
    let fileStat;
    try {
      fileStat = await stat(file);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (fileStat.isDirectory()) {
      for (const name of await readdir(file)) await walk(path.join(file, name));
    } else if (file.endsWith('.json') && !file.endsWith('manifest.json')) {
      visit(JSON.parse(await readFile(file, 'utf8')));
    }
  };
  for (const root of roots) await walk(root);
  return files;
}

export async function pruneImageAssets(upstream, manifest) {
  const referenced = await referencedImageFiles(upstream);
  for (const entry of manifest.sources ?? []) {
    if (entry.file) referenced.add(entry.file);
    for (const image of entry.previous ?? []) if (image.file) referenced.add(image.file);
  }
  for (const directory of ['items', 'portraits', 'maps/icons']) {
    const root = path.join(upstream, 'assets', directory);
    let names;
    try {
      names = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of names) {
      if (!entry.isFile() || !contentImageName.test(entry.name)) continue;
      const file = `${directory}/${entry.name}`;
      if (!referenced.has(file)) await unlink(path.join(root, entry.name));
    }
  }
}

// source URL -> served backend path, as baked into catalogs, markers and stickers.
export function imageUrls(manifest) {
  return new Map(manifest.sources.map((entry) => [entry.source, `/api/assets/${entry.file}`]));
}

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
];

// Currencies traders and the flea settle in. An offer priced in one of them is a normal cash
// purchase even when upstream models it through `requiredItems`.
const moneyItems = new Set([
  '5449016a4bdc2d6f028b456f', // roubles
  '5696686a4bdc2da3298b456a', // dollars
  '569668774bdc2da2298b4568', // euros
]);

// Keep category identifiers and price provenance from the upstream source so the UI can localize
// labels without falling back to slugs or inventing price explanations.
export function buildCatalog(
  mode,
  {
    items,
    handbookCategories,
    traders,
    traderNames,
    zhNames,
    enNames,
    tasks,
    taskNamesZh,
    taskNamesEn,
    barters,
  },
  imageUrls,
) {
  const traderName = (id) => traderNames?.[`${id} Nickname`] || traders?.[id]?.normalizedName || id;
  const traderImage = (id) => imageUrls.get(traders?.[id]?.imageLink) || '';
  const itemName = (id, locale) => {
    const names = locale === 'zh' ? zhNames : enNames;
    const fallback = locale === 'zh' ? enNames : zhNames;
    return names?.[`${id} Name`] || fallback?.[`${id} Name`] || '';
  };
  // The grid cell in game carries the short name, so the catalog keeps both: the recognition
  // matcher and any list that has room for the shorter label read it from here.
  const itemShortName = (key, locale) => {
    const names = locale === 'zh' ? zhNames : enNames;
    const fallback = locale === 'zh' ? enNames : zhNames;
    return (
      names?.[key.replace(/ Name$/, ' ShortName')] ||
      fallback?.[key.replace(/ Name$/, ' ShortName')] ||
      ''
    );
  };
  const taskName = (id, locale) => {
    const names = locale === 'zh' ? taskNamesZh : taskNamesEn;
    return names?.[`${id} name`] || names?.[`${id} Name`] || '';
  };
  // What one unit costs to obtain: the flea listing you buy from, or the cheapest trader offer.
  // The catalog's own lowest price and every task/barter cost are built from this same figure.
  const buyPrice = (item) => {
    const prices = [];
    if (!item.types?.includes('noFlea')) {
      const flea = item.avg24hPrice ?? item.lastLowPrice;
      if (typeof flea === 'number' && flea > 0) prices.push(flea);
    }
    for (const offer of item.buyFromTrader || []) {
      if (typeof offer.priceRUB === 'number' && offer.priceRUB > 0) prices.push(offer.priceRUB);
    }
    return prices.length ? Math.min(...prices) : null;
  };
  const requirement = (itemId, count, locale) => {
    const required = items[itemId];
    if (!required || !(count > 0)) return null;
    const unitPrice = buyPrice(required);
    return {
      itemId,
      name: itemName(itemId, locale),
      image: imageUrls.get(required.baseImageLink) || '',
      count,
      unitPrice,
      totalPrice: unitPrice === null ? null : Math.round(unitPrice * count),
    };
  };
  // Hand-ins are the item cost of a task; shooting, visiting or locating objectives cost nothing
  // and must not show up as a prerequisite purchase.
  const taskUnlock = (taskId, locale) => {
    const name = taskName(taskId, locale);
    if (!name) return null;
    const requirements = [];
    const seen = new Set();
    for (const objective of tasks?.[taskId]?.objectives || []) {
      if (objective.type !== 'giveItem') continue;
      for (const itemId of objective.items || []) {
        const entry = requirement(itemId, objective.count, locale);
        if (!entry || seen.has(itemId)) continue;
        seen.add(itemId);
        requirements.push(entry);
      }
    }
    return { id: taskId, name, requirements };
  };
  // Barters live in their own snapshot: `offeredItem` is what you receive, `requiredItems` is
  // what you hand over. Indexed by reward so each catalog row can look up its own exchanges.
  const barterOffers = new Map();
  for (const barter of Array.isArray(barters) ? barters : Object.values(barters || {})) {
    const reward = barter?.offeredItem?.item;
    if (!reward) continue;
    barterOffers.set(reward, [...(barterOffers.get(reward) ?? []), barter]);
  }
  const records = (locale) => {
    const result = Object.values(items).map((item) => {
      const key = item.name;
      const traderOffers = item.sellToTrader || [];
      const bestTraderOffer = traderOffers.reduce(
        (best, offer) =>
          typeof offer.priceRUB === 'number' && (!best || offer.priceRUB > best.priceRUB)
            ? offer
            : best,
        null,
      );
      const lowestCandidates = [];
      const fleaUnavailable = item.types?.includes('noFlea');
      const fleaBuyPrice = item.avg24hPrice ?? item.lastLowPrice;
      if (!fleaUnavailable && typeof fleaBuyPrice === 'number' && fleaBuyPrice > 0) {
        lowestCandidates.push({
          price: fleaBuyPrice,
          source: { kind: 'flea', label: 'FleaMarket', task: null, barter: null },
        });
      }
      for (const offer of item.buyFromTrader || []) {
        if (typeof offer.priceRUB !== 'number' || typeof offer.minTraderLevel !== 'number')
          continue;
        lowestCandidates.push({
          price: offer.priceRUB,
          source: {
            kind: offer.taskUnlock ? 'task' : 'trader',
            label: `${traderName(offer.trader)} LL${offer.minTraderLevel}`,
            task: offer.taskUnlock ? taskUnlock(offer.taskUnlock, locale) : null,
            barter: null,
          },
        });
      }
      for (const barter of barterOffers.get(item.id) || []) {
        if (typeof barter.minTraderLevel !== 'number') continue;
        const entries = (barter.requiredItems || [])
          .map((entry) => requirement(entry.item, entry.count, locale))
          .filter(Boolean);
        const priced = entries.length > 0 && entries.every((entry) => entry.totalPrice !== null);
        if (!priced) continue;
        const cashOnly = entries.every((entry) => moneyItems.has(entry.itemId));
        lowestCandidates.push({
          price: entries.reduce((sum, entry) => sum + entry.totalPrice, 0),
          source: {
            kind: cashOnly ? 'trader' : 'barter',
            label: `${traderName(barter.trader)} LL${barter.minTraderLevel}`,
            task: barter.taskUnlock ? taskUnlock(barter.taskUnlock, locale) : null,
            barter: cashOnly ? null : { items: entries },
          },
        });
      }
      lowestCandidates.push({
        price: Number.POSITIVE_INFINITY,
        source: { kind: 'flea', label: 'FleaMarket', task: null, barter: null },
      });
      lowestCandidates.sort((a, b) => a.price - b.price || (a.source.kind === 'flea' ? -1 : 1));
      const lowest =
        lowestCandidates[0]?.price === Number.POSITIVE_INFINITY
          ? { price: null, source: null }
          : lowestCandidates[0];
      return {
        id: item.id,
        zh: zhNames[key] || enNames[key] || key,
        en: enNames[key] || zhNames[key] || key,
        short: itemShortName(key, locale),
        image: imageUrls.get(item.baseImageLink) || '',
        categories: (item.handbookCategories || [])
          .map((id) => handbookCategories?.[id]?.normalizedName)
          .filter((id) => itemCategories.includes(id)),
        traderPrice: bestTraderOffer?.priceRUB ?? null,
        trader: bestTraderOffer
          ? {
              id: bestTraderOffer.trader,
              name: traderName(bestTraderOffer.trader),
              image: traderImage(bestTraderOffer.trader),
            }
          : null,
        traderStatus: traderOffers.length ? 'available' : 'unavailable',
        // Selling to the flea pays the most recent lowest listing; the buy side used by the lowest
        // price column is the 24h average, exactly like the upstream API's sellFor/buyFor split.
        fleaPrice:
          !fleaUnavailable && typeof item.lastLowPrice === 'number' ? item.lastLowPrice : null,
        fleaStatus: fleaUnavailable
          ? 'noFlea'
          : item.lastLowPrice == null
            ? 'notScanned'
            : 'available',
        lowestPrice: lowest.price,
        lowestPriceSource: lowest.source,
      };
    });
    result.sort((a, b) => a.id.localeCompare(b.id));
    return result;
  };
  const catalog = (locale) => ({
    schemaVersion: ContractSchemaVersion,
    fetchedAt: '',
    mode,
    items: records(locale).map((record) => ({
      id: record.id,
      name: locale === 'zh' ? record.zh : record.en,
      shortName: record.short || (locale === 'zh' ? record.zh : record.en),
      image: record.image,
      categories: record.categories,
      traderPrice: record.traderPrice,
      trader: record.trader,
      traderStatus: record.traderStatus,
      fleaPrice: record.fleaPrice,
      fleaStatus: record.fleaStatus,
      lowestPrice: record.lowestPrice,
      lowestPriceSource: record.lowestPriceSource,
    })),
  });
  return { zh: catalog('zh'), en: catalog('en') };
}

// Atomic overwrite of both language files; a pull regenerates them from scratch.
export async function writeCatalog(upstream, mode, catalogs) {
  const fetchedAt = new Date().toISOString();
  const dir = path.join(upstream, 'items', mode);
  await mkdir(dir, { recursive: true });
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const target = path.join(dir, `items_${locale}.json`);
    const staging = `${target}.tmp`;
    await writeFile(staging, JSON.stringify({ ...catalog, fetchedAt }) + '\n');
    await rename(staging, target);
  }
  let manifest = { sources: [] };
  try {
    manifest = JSON.parse(await readFile(path.join(upstream, 'items', 'manifest.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await pruneImageAssets(upstream, manifest);
}
