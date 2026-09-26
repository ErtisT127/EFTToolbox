// Reusable upstream item pull: snapshot loading/fetching, the content-hash image cache and the
// five-field catalog. CLI commands are thin wrappers; a backend pull entry can reuse the same
// functions and artifact contracts (items/manifest.json and items/{mode}/items_*.json).
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { download } from './download.mjs';

export const modes = ['pvp', 'pve', 'pvp-season'];
const upstreamModes = { pvp: 'regular', pve: 'pve', 'pvp-season': 'pvp-season' };
const imageExtensions = ['.webp', '.png', '.jpg'];

const snapshotUrl = (mode, name) => `https://json.tarkov.dev/${upstreamModes[mode]}/${name}`;

// Snapshots for one mode. items carries the item map plus handbook categories, maps the map and
// mob definitions; traders and the name translations are shared across modes.
export async function fetchModeSnapshots(mode) {
  const data = async (name) =>
    JSON.parse((await download(snapshotUrl(mode, name))).toString()).data;
  const [items, maps, traders, zhNames, enNames] = await Promise.all([
    data('items'),
    data('maps'),
    data('traders'),
    data('items_zh'),
    data('items_en'),
  ]);
  return snapshotView(items, maps, traders, zhNames, enNames);
}

// Same shape as fetchModeSnapshots, but from the snapshots a `data sources` run already stored.
export async function loadModeSnapshots(upstream, mode) {
  const data = async (name, dir = mode) =>
    JSON.parse(await readFile(path.join(upstream, 'source', dir, name), 'utf8')).data;
  const [items, maps, traders, zhNames, enNames] = await Promise.all([
    data('items.json'),
    data('maps.json'),
    data('traders.json', '.'),
    data('items_zh.json', '.'),
    data('items_en.json', '.'),
  ]);
  return snapshotView(items, maps, traders, zhNames, enNames);
}

const snapshotView = (items, maps, traders, zhNames, enNames) => ({
  items: items.items,
  handbookCategories: items.handbookCategories,
  mobs: maps.mobs ?? {},
  traders,
  zhNames,
  enNames,
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
  // Start from the prior manifest so sources that dropped out of the upstream data keep their
  // entries (and their files tracked) instead of silently losing the cache record.
  const sources = new Map(entries);
  for (const job of jobs) {
    const result = results.get(job.url);
    if (!result) continue;
    const entry = entries.get(job.url);
    const history = [...(entry?.previous ?? [])];
    if (entry && entry.sha256 !== result.sha256)
      history.unshift({ file: entry.file, sha256: entry.sha256 });
    const previous = [];
    for (const stale of history)
      if (stale.sha256 !== result.sha256 && !previous.some((p) => p.sha256 === stale.sha256))
        previous.push(stale);
    sources.set(job.url, { source: job.url, file: result.file, sha256: result.sha256, previous });
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

// source URL -> served backend path, as baked into catalogs, markers and stickers.
export function imageUrls(manifest) {
  return new Map(manifest.sources.map((entry) => [entry.source, `/api/assets/${entry.file}`]));
}

// The five-field catalog: id, localized name, 64px image, trader/flea/lowest prices. Both
// language files share the records; only `name` differs, resolved from the upstream translation
// maps with the same fallback order the map pipeline uses.
export function buildCatalog(mode, { items, zhNames, enNames }, imageUrls) {
  const records = Object.values(items).map((item) => {
    const key = item.name;
    const prices = (values) => {
      const numbers = values.filter((value) => typeof value === 'number');
      return numbers.length ? Math.max(...numbers) : null;
    };
    return {
      id: item.id,
      zh: zhNames[key] || enNames[key] || key,
      en: enNames[key] || zhNames[key] || key,
      image: imageUrls.get(item.baseImageLink) || '',
      traderPrice: prices((item.sellToTrader || []).map((entry) => entry.priceRUB)),
      fleaPrice: typeof item.avg24hPrice === 'number' ? item.avg24hPrice : null,
      lowestPrice: typeof item.lastLowPrice === 'number' ? item.lastLowPrice : null,
    };
  });
  records.sort((a, b) => a.id.localeCompare(b.id));
  const catalog = (locale) => ({
    schemaVersion: 1,
    fetchedAt: '',
    mode,
    items: records.map((record) => ({
      id: record.id,
      name: locale === 'zh' ? record.zh : record.en,
      image: record.image,
      traderPrice: record.traderPrice,
      fleaPrice: record.fleaPrice,
      lowestPrice: record.lowestPrice,
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
}
