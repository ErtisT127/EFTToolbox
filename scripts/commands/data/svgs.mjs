import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { download } from '../../lib/download.mjs';

const root = fileURLToPath(new URL('../../../data/upstream/source/', import.meta.url));
const rules = JSON.parse(await readFile(path.join(root, 'map-rules.json'), 'utf8'));
const directory = path.join(root, 'current-svg');
await mkdir(directory, { recursive: true });
const sources = [];
for (const url of new Set(rules.flatMap((r) => r.maps.map((m) => m.svgPath)).filter(Boolean))) {
  const bytes = await download(url),
    file = path.basename(new URL(url).pathname);
  await writeFile(path.join(directory, file), bytes);
  sources.push({ source: url, file, sha256: createHash('sha256').update(bytes).digest('hex') });
  console.log(`Downloaded current SVG ${file}: ${bytes.length} bytes`);
}
await writeFile(
  path.join(directory, 'versions.json'),
  JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      sources,
    },
    null,
    2,
  ) + '\n',
);
