import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { download } from '../../lib/download.mjs';

const root = fileURLToPath(new URL('../../../data/upstream/', import.meta.url));
const read = async (name) => {
  const candidates =
    name === 'items.json'
      ? [path.join(root, 'source/pvp', name), path.join(root, 'source', name)]
      : [path.join(root, 'source', name)];
  for (const file of candidates) {
    try {
      return JSON.parse(await readFile(file, 'utf8')).data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Missing upstream source: ${name}`);
};
const { maps, mobs } = await read('maps.json');
const { items, handbookCategories } = await read('items.json');
const traders = await read('traders.json');

// Handbook categories whose items belong in the sticker picker even when no map places them,
// so the picker can offer a category that is otherwise too new to have reached a loot point.
const stickerCategories = new Set(['6a35427afc3f27b15905a876']); // Battle Pass documents

// url -> filename prefix. The prefix is part of the served name, and `.marker-art` in the
// dashboard keys off `item-`, so the existing sets keep it.
const jobs = new Map();
const add = (url, prefix = 'item-') => {
  if (url && !jobs.has(url)) jobs.set(url, prefix);
};
const isKey = (item) => (item.types || []).some((type) => type.toLowerCase().includes('key'));

for (const map of Object.values(maps))
  for (const id of [
    ...map.lootLoose.flatMap((loot) => loot.items),
    ...map.locks.map((lock) => lock.key),
  ])
    add(items[id]?.baseImageLink);
for (const item of Object.values(items))
  if (isKey(item) || stickerCategories.has(item.handbookCategories?.[0])) add(item.baseImageLink);
for (const category of Object.values(handbookCategories)) add(category.imageLink);
for (const trader of Object.values(traders)) add(trader.imageLink, 'trader-');
for (const mob of Object.values(mobs)) add(mob.imagePortraitLink, 'mob-');

const queue = [...jobs],
  sources = [];
await mkdir(path.join(root, 'assets'), { recursive: true });
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const [url, prefix] = queue.shift();
      const bytes = await download(url);
      const extension = path.extname(new URL(url).pathname);
      if (!['.webp', '.png', '.jpg'].includes(extension))
        throw new Error(`Unsupported map image: ${url}`);
      // Hash the bytes, not the URL. Most keys share one texture with each other, so hashing the
      // URL stored one copy per key and left two thirds of the cache as duplicate content.
      // Content addressing also makes the name immutable, which is what lets the asset route
      // serve these with a long max-age instead of revalidating every one.
      // Two URLs that differ only in encoding (say .webp and .png of the same picture) still
      // land in separate files: those are distinct files, not duplicate content.
      const digest = createHash('sha256').update(bytes).digest('hex');
      const file = `${prefix}${digest.slice(0, 24)}${extension}`;
      const target = path.join(root, 'assets', file);
      // Distinct sources can resolve to the same file, so the temporary name has to be unique
      // per job or two workers would interleave writes into one buffer.
      const temporary = `${target}.${digest.slice(24, 32)}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, target);
      sources.push({ source: url, file, sha256: digest });
      if (sources.length % 50 === 0)
        console.log(`Cached ${sources.length}/${jobs.size} map images`);
    }
  }),
);
sources.sort((a, b) => a.source.localeCompare(b.source));
await writeFile(
  path.join(root, 'source', 'item-images.json'),
  JSON.stringify({ fetchedAt: new Date().toISOString(), sources }, null, 2) + '\n',
);
console.log(
  `Cached ${sources.length} images across ${new Set(sources.map((s) => s.file)).size} files.`,
);
