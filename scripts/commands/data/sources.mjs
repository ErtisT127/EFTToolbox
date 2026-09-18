import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { download } from '../../lib/download.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const recipe = JSON.parse(
  await readFile(new URL('../../config/upstream-sources.json', import.meta.url), 'utf8'),
);
const target = path.join(root, 'data/upstream/source');
const staged = [];
async function fetchSource(name, url) {
  const bytes = await download(url);
  if (name.endsWith('.json')) JSON.parse(bytes.toString());
  staged.push({
    name,
    bytes,
    source: url,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  console.log(`Downloaded ${name}: ${bytes.length} bytes`);
  return bytes;
}
const baselineUrl = `https://raw.githubusercontent.com/${recipe.baseline.repository}/${recipe.baseline.revision}`;
// maps.json alone is consumed, for stable map ids and English subtitles. The rest of that
// repository (its SVGs, objective dumps and quests) is downloaded by nothing that reads it.
await fetchSource('tarkovdata/maps.json', `${baselineUrl}/maps.json`);
for (const name of recipe.snapshots)
  await fetchSource(`${name}.json`, `https://json.tarkov.dev/regular/${name}`);
const referenceUrl = `https://raw.githubusercontent.com/${recipe.reference.repository}/${recipe.reference.revision}`;
await fetchSource('map-rules.json', `${referenceUrl}/src/data/maps.json`);
await fetchSource('maps-static.json', `${referenceUrl}/src/data/maps_static.json`);
// Preserve the previous snapshot if any download fails.
for (const entry of staged) {
  const name = path.join(target, entry.name);
  await mkdir(path.dirname(name), { recursive: true });
  await writeFile(`${name}.tmp`, entry.bytes);
  await rename(`${name}.tmp`, name);
}
await writeFile(
  path.join(target, 'versions.json'),
  JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      ...recipe,
      sources: staged.map(({ name: file, source, sha256 }) => ({ file, source, sha256 })),
    },
    null,
    2,
  ) + '\n',
);
