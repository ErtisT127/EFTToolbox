// Prepare redistributable, identical static faces for the browser and native renderer.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
const fonts = path.join(assets, 'display', 'fonts');
const licenses = path.join(assets, 'licenses');
const cache = path.join(root, 'build/tools/font-sources');
await Promise.all([fonts, licenses, cache].map((dir) => mkdir(dir, { recursive: true })));
const revision = 'f2bd09badbc763d8757951d52deec29da27e85fb';
const base = `https://raw.githubusercontent.com/google/fonts/${revision}/ofl/`;
const notoEmojiRevision = '1ffdd21391dd1f25c081fa93a9dea0c7c029442b';
const notoEmojiBase = `https://raw.githubusercontent.com/googlefonts/noto-emoji/${notoEmojiRevision}/`;
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
    await save(`display/fonts/${file}.ttf`, ttf, url, license, hash(bytes));
    await save(
      `display/fonts/${file}.woff2`,
      Buffer.from(await wawoff2.compress(ttf)),
      url,
      license,
      hash(bytes),
    );
    console.log(`Prepared ${file}`);
  }
}
const display = JSON.parse(await readFile(path.join(root, 'contracts/map-display.json'), 'utf8'));
const emojiFontUrl = notoEmojiBase + '2D/fonts/NotoColorEmoji_WindowsCompatible.ttf';
const emojiLicenseUrl = notoEmojiBase + '2D/fonts/LICENSE';
const emojiLicense = 'licenses/noto-emoji-OFL.txt';
await save(emojiLicense, await source(emojiLicenseUrl), emojiLicenseUrl, 'SIL OFL 1.1');
const emojiBytes = await source(emojiFontUrl);
const emojiInput = path.join(cache, 'NotoColorEmoji_WindowsCompatible.ttf');
const emojiTtf = path.join(fonts, 'noto-color-emoji.ttf');
await writeFile(emojiInput, emojiBytes);
const unicodes = new Set([0xfe0f]);
for (const emoji of Object.keys(display.emoji))
  for (const character of emoji) unicodes.add(character.codePointAt(0));
const unicodeArg = [...unicodes].map((code) => `U+${code.toString(16).toUpperCase()}`).join(',');
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
    'pyftsubset',
    emojiInput,
    `--output-file=${emojiTtf}`,
    `--unicodes=${unicodeArg}`,
  ],
  { stdio: 'inherit', windowsHide: true },
);
const emojiSubset = await readFile(emojiTtf);
await save(
  'display/fonts/noto-color-emoji.ttf',
  emojiSubset,
  emojiFontUrl,
  emojiLicense,
  hash(emojiBytes),
);
// Chromium rejects WOFF2-transformed CBDT/CBLC fonts; Overlay loads the original TTF directly.
console.log('Prepared noto-color-emoji');
await writeFile(
  path.join(assets, 'display-resources.json'),
  JSON.stringify(
    {
      version: 1,
      googleFontsRevision: revision,
      notoEmojiRevision,
      files: [...new Map(records.map((r) => [r.file, r])).values()],
    },
    null,
    2,
  ) + '\n',
);
