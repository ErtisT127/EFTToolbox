// Prepare redistributable, identical static faces for the browser and native renderer.
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import wawoff2 from 'wawoff2';
import { download } from '../../lib/download.mjs';
import { verifyDisplayResources } from '../../lib/display-resources.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const assets = path.join(root, 'data/upstream/assets');
if (process.argv.includes('--check')) {
  const manifest = await verifyDisplayResources(assets);
  console.log(`Verified ${manifest.files.length} licensed display resources`);
  process.exit(0);
}
const fonts = path.join(assets, 'fonts');
const licenses = path.join(assets, 'licenses');
const cache = path.join(root, 'build/tools/font-sources');
await Promise.all([fonts, licenses, cache].map((dir) => mkdir(dir, { recursive: true })));
const revision = 'f2bd09badbc763d8757951d52deec29da27e85fb';
const base = `https://raw.githubusercontent.com/google/fonts/${revision}/ofl/`;
const records = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function source(url) {
  const file = path.join(cache, hash(url));
  try {
    return await readFile(file);
  } catch {
    /* Immutable download cache. */
  }
  const bytes = await download(url);
  await writeFile(file, bytes);
  return bytes;
}
async function save(file, bytes, url, license, sourceHash = hash(bytes)) {
  await writeFile(path.join(assets, file), bytes);
  records.push({ file, source: url, sourceSha256: sourceHash, sha256: hash(bytes), license });
}
for (const [family, filename, name, weights] of [
  ['notosanssc', 'NotoSansSC[wght].ttf', 'noto-sans-sc', [400, 700]],
  ['notosans', 'NotoSans[wdth,wght].ttf', 'noto-sans', [700]],
  ['barlowcondensed', 'BarlowCondensed-Regular.ttf', 'barlow-condensed', [400]],
  ['barlowcondensed', 'BarlowCondensed-Medium.ttf', 'barlow-condensed', [500]],
  ['barlowcondensed', 'BarlowCondensed-SemiBold.ttf', 'barlow-condensed', [600]],
  ['jetbrainsmono', 'JetBrainsMono[wght].ttf', 'jetbrains-mono', [400]],
]) {
  const url = base + family + '/' + encodeURIComponent(filename);
  const bytes = await source(url);
  const license = `licenses/${family}-OFL.txt`;
  await save(
    license,
    await source(base + family + '/OFL.txt'),
    base + family + '/OFL.txt',
    'SIL OFL 1.1',
  );
  const input = path.join(cache, `${family}.ttf`);
  await writeFile(input, bytes);
  for (const weight of weights) {
    const file = `${name}-${weight}`;
    const target = path.join(fonts, `${file}.ttf`);
    execFileSync(
      'uv',
      [
        'run',
        '--managed-python',
        '--python',
        '3.13',
        '--with',
        'fonttools==4.60.1',
        '--no-project',
        path.join(root, 'scripts/lib/static-font.py'),
        input,
        target,
        String(weight),
      ],
      { stdio: 'inherit', windowsHide: true },
    );
    const ttf = await readFile(target);
    await save(`fonts/${file}.ttf`, ttf, url, license, hash(bytes));
    await save(
      `${file}.woff2`,
      Buffer.from(await wawoff2.compress(ttf)),
      url,
      license,
      hash(bytes),
    );
    console.log(`Prepared ${file}`);
  }
}
const twemoji = 'https://raw.githubusercontent.com/twitter/twemoji/v14.0.2/';
await save(
  'licenses/twemoji-LICENSE-GRAPHICS',
  await source(twemoji + 'LICENSE-GRAPHICS'),
  twemoji + 'LICENSE-GRAPHICS',
  'CC-BY 4.0',
);
const display = JSON.parse(await readFile(path.join(root, 'contracts/map-display.json'), 'utf8'));
for (const code of new Set(Object.values(display.emoji))) {
  const url = twemoji + `assets/72x72/${code}.png`;
  await save(`emoji-${code}.png`, await source(url), url, 'licenses/twemoji-LICENSE-GRAPHICS');
}
// Obsolete generated files with no verified distribution provenance must not ship.
for (const file of [
  'bender-bold.woff2',
  'fonts/bender-bold.ttf',
  'fonts/NotoSansSC.ttf',
  'barlow-condensed-700.woff2',
  'fonts/barlow-condensed-700.ttf',
])
  await rm(path.join(assets, file), { force: true });
await writeFile(
  path.join(assets, 'display-resources.json'),
  JSON.stringify(
    {
      version: 1,
      googleFontsRevision: revision,
      twemojiVersion: '14.0.2',
      files: [...new Map(records.map((r) => [r.file, r])).values()],
    },
    null,
    2,
  ) + '\n',
);
await writeFile(
  path.join(assets, 'THIRD-PARTY-NOTICES.txt'),
  'Map fonts: Noto Sans / Noto Sans SC (Google), Barlow Condensed (Jeremy Tribby), JetBrains Mono (JetBrains), SIL Open Font License 1.1. Original copyright notices are in licenses/*.txt.\nEmoji: Twemoji 14.0.2, Copyright Twitter, Inc. and other contributors, CC-BY 4.0, https://github.com/twitter/twemoji. Images are unmodified. License: licenses/twemoji-LICENSE-GRAPHICS.\nSource URLs, pinned versions, source hashes and shipped-file hashes: display-resources.json.\n',
);
