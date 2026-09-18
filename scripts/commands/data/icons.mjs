import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as mdi from '@mdi/js';
import { download as fetchBytes } from '../../lib/download.mjs';

// Pin the mapping and artwork together. Update this revision deliberately when refreshing data.
const {
  reference: { revision },
} = JSON.parse(
  await readFile(new URL('../../config/upstream-sources.json', import.meta.url), 'utf8'),
);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const target = path.join(root, 'data/upstream/source/tarkov-dev-icons');
const checkout = process.argv[2];
await mkdir(target, { recursive: true });
const sources = [];
async function download(file, name) {
  const url = `https://raw.githubusercontent.com/the-hideout/tarkov-dev/${revision}/${file}`;
  let bytes;
  if (checkout) bytes = await readFile(path.join(checkout, file));
  else {
    bytes = await fetchBytes(url);
  }
  await writeFile(path.join(target, name), bytes);
  sources.push({
    file: name,
    source: url,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  return bytes.toString();
}
const source = await download('src/pages/map/map-images.mjs', 'map-images.mjs');
await download('src/translations/zh/maps.json', 'maps-zh.json');
// Extract only the literal mapping; never execute downloaded JavaScript.
const start = source.indexOf('{'),
  end = source.lastIndexOf('}');
const mapping = JSON.parse(source.slice(start, end + 1).replace(/,\s*}/g, '}'));
await writeFile(path.join(target, 'mapping.json'), JSON.stringify(mapping, null, 2) + '\n');
const assets = path.join(root, 'data/upstream/assets');
await mkdir(assets, { recursive: true });
const mapSource = await download('src/features/maps/index.js', 'maps-index.js');
const mapIconBlock = mapSource.match(/export const mapIcons = \{([\s\S]*?)\};/);
if (!mapIconBlock) throw new Error('Missing upstream map icon mapping');
const mapIcons = {};
for (const [, id, symbol] of mapIconBlock[1].matchAll(/"([a-z0-9-]+)":\s*(mdi\w+)/g)) {
  if (!mdi[symbol]) throw new Error(`Unknown upstream map icon: ${symbol}`);
  const file = `map-${id}.svg`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${mdi[symbol]}"/></svg>`;
  await writeFile(path.join(assets, file), svg);
  sources.push({
    file: `../../assets/${file}`,
    source: `https://www.npmjs.com/package/@mdi/js/v/7.4.47#${symbol}`,
    sha256: createHash('sha256').update(svg).digest('hex'),
  });
  mapIcons[id] = `/api/map-assets/${file}`;
}
await writeFile(path.join(target, 'map-icons.json'), JSON.stringify(mapIcons, null, 2) + '\n');
await copyFile(path.join(root, 'node_modules/@mdi/js/LICENSE'), path.join(target, 'MDI-LICENSE'));
for (const name of new Set(Object.values(mapping))) {
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`Invalid icon name: ${name}`);
  await download(`public/maps/interactive/${name}.png`, `${name}.png`);
  await copyFile(path.join(target, `${name}.png`), path.join(assets, `${name}.png`));
}
await download('public/fonts/bender-bold.woff2', 'bender-bold.woff2');
await copyFile(path.join(target, 'bender-bold.woff2'), path.join(assets, 'bender-bold.woff2'));
await download('LICENSE', 'LICENSE');
await writeFile(
  path.join(target, 'versions.json'),
  JSON.stringify({ revision, sources }, null, 2) + '\n',
);
console.log(`Cached ${new Set(Object.values(mapping)).size} upstream map icons (${revision}).`);
