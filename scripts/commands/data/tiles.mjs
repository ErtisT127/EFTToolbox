import { readFile, mkdir, access, writeFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { downloadResponse, setAnnouncer } from '../../lib/download.mjs';
import { tileUrls } from '../../lib/tile-urls.mjs';

const upstream = new URL('../../../data/upstream/', import.meta.url);
const root = new URL('tiles/', upstream);
const manifestFile = new URL('manifest.json', root);

const args = process.argv.slice(2);
if (args.some((arg) => !['--all', '--count', '--verify'].includes(arg)))
  throw new Error('Usage: pnpm toolbox data tiles [--all] [--count] [--verify]');
const allZooms = args.includes('--all');
const verify = args.includes('--verify');

// Tile rules and projection are shared resources. Read the pvp catalog so mode switches do not
// multiply identical basemap requests; a missing catalog means data refresh has not run yet.
const dataRoot = new URL('modes/pvp/', upstream);
const catalog = JSON.parse(await readFile(new URL('catalog_zh.json', dataRoot), 'utf8'));
const jobs = new Set();
for (const summary of catalog) {
  const map = JSON.parse(await readFile(new URL(`maps/${summary.id}_zh.json`, dataRoot), 'utf8'));
  for (const url of tileUrls(map, allZooms)) jobs.add(url);
}
console.log(`${jobs.size} tile URLs (${allZooms ? 'all zooms' : 'lowest zoom per floor'}).`);
if (args.includes('--count')) process.exit(0);

const concurrency = Number(process.env.TILE_CONCURRENCY ?? 32);
if (!Number.isInteger(concurrency) || concurrency < 1)
  throw new Error('TILE_CONCURRENCY must be a positive integer');

// A live line is only useful on a terminal. Piped or captured output keeps the append-only form it
// had before, so CI logs stay greppable and a finished run leaves a record of its rate.
const live = process.stdout.isTTY === true;
const startedAt = Date.now();

function clearLine() {
  if (live) process.stdout.write('\r\x1b[K');
}

// Retry notices arrive from download.mjs mid-download; clearing first keeps them from landing
// inside the bar, which matters here because a flaky network makes them frequent.
setAnnouncer((line) => {
  clearLine();
  console.log(line);
});

// The cache key is the source URL, which carries no revision, so a re-rendered tile at the same URL
// would stay stale forever — and a distribution ships that copy. The manifest records what the
// server said about each tile so `--verify` can ask whether it is still current instead of
// guessing. It lives beside the tiles so clearing the cache clears it too.
let manifest = {};
try {
  manifest = JSON.parse(await readFile(manifestFile, 'utf8')).tiles ?? {};
} catch {
  /* No manifest yet: an older cache, or the first run. */
}

const checksum = (data) => createHash('sha256').update(data).digest('hex');
// A transparent pixel represents an upstream 404 (sparse tile coverage).
const blank = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RaAAAAAASUVORK5CYII=',
  'base64',
);

function validate(data) {
  if (data.length > 4 * 1024 * 1024 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    throw new Error('Invalid PNG');
  return data;
}

async function isCached(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// Written through a temp name so an interrupted run cannot leave a truncated PNG that the backend
// would then serve for good.
async function persist(key, data) {
  const dir = new URL(`${key.slice(0, 2)}/`, root);
  await mkdir(dir, { recursive: true });
  const file = new URL(`${key}.png`, dir);
  const temp = new URL(`${key}.${process.pid}.tmp`, dir);
  try {
    await writeFile(temp, data);
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

// Revalidates one tile against the server. Returns the bytes to store, or null when the cached copy
// is already correct. Without a recorded validator this degrades to a plain download and compares
// content instead.
async function reconcile(source, file) {
  const previous = manifest[source];
  const headers = {};
  if (previous?.etag) headers['If-None-Match'] = previous.etag;
  else if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
  let response = await downloadResponse(source, { headers, tolerate: [304, 404] });
  if (response.status === 304) {
    // The server vouches for the tile being unchanged upstream, not for what is on this disk, so the
    // cached bytes still have to match the manifest before the entry counts as current. A truncated
    // or edited file would otherwise survive every verify and ship inside a distribution.
    const onDisk = await readFile(file).catch(() => null);
    if (onDisk && checksum(onDisk) === previous.sha256) return null;
    // Freshness and integrity are separate questions and the answers just disagreed: upstream still
    // has the tile, but this disk does not hold it. Whatever comes back has to be written.
    response = await downloadResponse(source, { tolerate: [404] });
    return { data: response.status === 404 ? blank : validate(response.bytes), response };
  }
  if (response.status === 404) return previous?.missing ? null : { data: blank, response };
  const data = validate(response.bytes);
  if (previous && !previous.missing && checksum(data) === previous.sha256) return null;
  return { data, response };
}

const record = (source, data, response) => {
  manifest[source] = {
    sha256: checksum(data),
    etag: response?.etag ?? null,
    lastModified: response?.lastModified ?? null,
    missing: response?.status === 404,
  };
};

const queue = [...jobs];
let nextJob = 0;
let completed = 0;
let failed = 0;
let added = 0;
let updated = 0;

let sampledAt = startedAt;
let sampledCount = 0;

// A bare second count stops being readable once it runs into the thousands, which is exactly the
// range `--all` lives in.
function duration(seconds) {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(total / 3600)}h${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
}

function drawProgress() {
  const now = Date.now();
  const elapsed = (now - sampledAt) / 1000;
  // Redrawn on a half-second tick, which both bounds the output and gives the rate a real window. An
  // average since the start reads as nonsense: a warm cache skips instantly, so the first pass shows
  // thousands per second and the network-bound tail then drags the figure down.
  if (elapsed < 0.5) return;
  const rate = (completed - sampledCount) / elapsed;
  sampledAt = now;
  sampledCount = completed;
  const speed =
    rate > 0 ? ` ${rate.toFixed(0)}/s ETA ${duration((jobs.size - completed) / rate)}` : '';
  process.stdout.write(
    `\r\x1b[K${Math.floor((completed / jobs.size) * 100)}% ${completed}/${jobs.size}` +
      `${failed ? ` ${failed} failed` : ''}${speed}`,
  );
}
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (nextJob < queue.length) {
      const source = queue[nextJob++];
      const key = createHash('sha256').update(source).digest('hex');
      const file = new URL(`${key.slice(0, 2)}/${key}.png`, root);
      try {
        const cached = await isCached(file);
        if (verify) {
          // A plain run only fills gaps; revalidating the whole cache is what --verify is for.
          const change = await reconcile(source, file);
          if (change) {
            await persist(key, change.data);
            record(source, change.data, change.response);
            if (cached) updated++;
            else added++;
          }
        } else if (!cached) {
          const response = await downloadResponse(source, { tolerate: [404] });
          const data = validate(response.status === 404 ? blank : response.bytes);
          await persist(key, data);
          record(source, data, response);
          added++;
        }
      } catch (error) {
        failed++;
        console.error(`${source}: ${error.message}`);
      }
      completed++;
      if (live) drawProgress();
      else if (completed % 100 === 0 || completed === jobs.size)
        console.log(`${completed}/${jobs.size}, ${failed} failed`);
    }
  }),
);
clearLine();

// Cache entries the current maps no longer reference. Reported rather than deleted: a distribution
// may still be serving them, and dropping files is not this command's call to make.
const orphans = Object.keys(manifest).filter((source) => !jobs.has(source));

await mkdir(root, { recursive: true });
const temp = new URL(`manifest.${process.pid}.tmp`, root);
await writeFile(temp, JSON.stringify({ fetchedAt: new Date().toISOString(), tiles: manifest }));
await rename(temp, manifestFile);

if (verify)
  console.log(
    `Verified ${completed} tiles: ${updated} updated, ${added} added, ${completed - updated - added - failed} unchanged.`,
  );
if (orphans.length)
  console.log(`${orphans.length} cached tiles are no longer referenced by any map.`);
if (failed) process.exitCode = 1;
