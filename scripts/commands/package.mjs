import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyDisplayResources } from '../lib/display-resources.mjs';
import { tileUrls } from '../lib/tile-urls.mjs';
import { noticesText } from '../lib/third-party.mjs';
import { ContractSchemaVersion } from '../../contracts/version.gen.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const upstream = path.join(root, 'data/upstream');
const defaultsDirectory = path.join(root, 'scripts/defaults');
const args = process.argv.slice(2);
if (args.some((arg) => !['--lite', '--debug'].includes(arg)))
  throw new Error('Usage: pnpm toolbox package [--lite] [--debug]');
const lite = args.includes('--lite');
const debug = args.includes('--debug');
await verifyDisplayResources(path.join(upstream, 'assets'));
const output = path.join(root, 'build/package', new Date().toISOString().replace(/[:.]/g, '-'));
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
let stepCount = 0;
const step = (label) => console.log(`[${++stepCount}/11] ${label}`);
const copyDirectory = (source, destination) => {
  const result = spawnSync(
    'robocopy',
    [source, destination, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status === null || result.status > 7)
    throw new Error(`robocopy failed with exit code ${result.status ?? 'unknown'}`);
};
const copyIfPresent = async (source, destination) => {
  try {
    await access(source);
    await copyFile(source, destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
};
// The package is what users double-click, so it is checked against what the desktop host needs to
// start (validateStartup in backend/cmd/EFTToolbox) plus the data it reads later. Missing pieces
// then fail the package instead of surfacing as a startup error page.
const verifyPackage = async (output) => {
  for (const name of [
    'EFTToolbox.exe',
    'dashboard/index.html',
    'dashboard/cast.html',
    'overlay/overlay.exe',
    'data/upstream/modes',
    'data/upstream/assets',
    'data/upstream/items',
    'data/upstream/stickers.json',
    'data/upstream/tiles/manifest.json',
    'THIRD-PARTY-NOTICES.txt',
  ]) {
    try {
      await access(path.join(output, name));
    } catch {
      throw new Error(`Package is missing ${name}`);
    }
  }
  // 2 is IMAGE_SUBSYSTEM_WINDOWS_GUI; a console binary would open a console next to the window.
  const exe = await readFile(path.join(output, 'EFTToolbox.exe'));
  const optionalHeader = exe.readUInt32LE(0x3c) + 0x18;
  const subsystem = exe.readUInt16LE(optionalHeader + 0x44);
  if (subsystem !== 2)
    throw new Error(`EFTToolbox.exe is not a GUI binary (PE subsystem ${subsystem})`);
};
// Map files carry their language in the name ("<id>_zh.json"), so the id has to drop both suffixes;
// the backend reads them the same way (mapIDFromFile in internal/server/maps.go).
const mapIdFromFile = (name) => {
  if (!name.endsWith('.json')) return '';
  const base = name.slice(0, -'.json'.length);
  const index = base.lastIndexOf('_');
  if (index <= 0) return '';
  const language = base.slice(index + 1);
  return language === 'zh' || language === 'en' ? base.slice(0, index) : '';
};
// Keep tiles for any map with a floor that has no SVG artwork. The viewport uses the first/base tile
// as a satellite fallback when the selected floor has no tile, so mixed maps must retain all layers.
const mapsNeedingTiles = async (modes) => {
  const ids = new Set();
  for (const mode of await readdir(modes, { withFileTypes: true })) {
    if (!mode.isDirectory()) continue;
    const maps = path.join(modes, mode.name, 'maps');
    for (const file of await readdir(maps, { withFileTypes: true })) {
      const id = file.isFile() ? mapIdFromFile(file.name) : '';
      if (!id) continue;
      const map = JSON.parse(await readFile(path.join(maps, file.name), 'utf8'));
      const tiles = (map.tiles ?? []).length;
      const floorsWithoutSvg = (map.floors ?? []).filter(
        (floor) => !(floor.svgGroups ?? []).length,
      );
      if (!tiles && floorsWithoutSvg.length === (map.floors ?? []).length)
        throw new Error(`Map ${id} has neither tiles nor SVG`);
      if (tiles && floorsWithoutSvg.length) ids.add(id);
    }
  }
  return ids;
};
const simplifyMaps = async (modes, keep) => {
  for (const mode of await readdir(modes, { withFileTypes: true })) {
    if (!mode.isDirectory()) continue;
    const maps = path.join(modes, mode.name, 'maps');
    for (const file of await readdir(maps, { withFileTypes: true })) {
      const id = file.isFile() ? mapIdFromFile(file.name) : '';
      if (!id) continue;
      const name = path.join(maps, file.name);
      const map = JSON.parse(await readFile(name, 'utf8'));
      if (!keep.has(id)) map.tiles = [];
      await writeFile(name, JSON.stringify(map));
    }
  }
};
const copyLiteTiles = async (modes, sourceRoot, destinationRoot, keep) => {
  const urls = new Set();
  for (const mode of await readdir(modes, { withFileTypes: true })) {
    if (!mode.isDirectory()) continue;
    const maps = path.join(modes, mode.name, 'maps');
    for (const file of await readdir(maps, { withFileTypes: true })) {
      const id = file.isFile() ? mapIdFromFile(file.name) : '';
      if (!id || !keep.has(id)) continue;
      const map = JSON.parse(await readFile(path.join(maps, file.name), 'utf8'));
      for (const url of tileUrls(map)) urls.add(url);
    }
  }
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'manifest.json'), 'utf8')).tiles;
  const filesByShard = new Map();
  const selectedManifest = {};
  for (const url of urls) {
    const entry = manifest[url];
    if (!entry) throw new Error(`Missing tile manifest entry: ${url}`);
    const hash = createHash('sha256').update(url).digest('hex');
    const file = `${hash}.png`;
    await access(path.join(sourceRoot, hash.slice(0, 2), file));
    const files = filesByShard.get(hash.slice(0, 2)) || [];
    files.push(file);
    filesByShard.set(hash.slice(0, 2), files);
    selectedManifest[url] = entry;
  }
  for (const [shard, files] of filesByShard) {
    const result = spawnSync(
      'robocopy',
      [
        path.join(sourceRoot, shard),
        path.join(destinationRoot, shard),
        ...files,
        '/NFL',
        '/NDL',
        '/NJH',
        '/NJS',
        '/NP',
        '/R:1',
        '/W:1',
      ],
      { cwd: root, stdio: 'inherit', windowsHide: true },
    );
    if (result.error) throw result.error;
    if (result.status === null || result.status > 7)
      throw new Error(`robocopy failed with exit code ${result.status ?? 'unknown'}`);
  }
  await writeFile(
    path.join(destinationRoot, 'manifest.json'),
    JSON.stringify({ schemaVersion: ContractSchemaVersion, tiles: selectedManifest }) + '\n',
  );
};
step('Checking contracts');
run(process.execPath, ['contracts/generate.mjs', '--check']);
step('Checking defaults');
run(process.execPath, ['scripts/generate-defaults.mjs', '--check']);
step('Checking third-party list');
run(process.execPath, ['scripts/generate-third-party.mjs', '--check']);
step('Testing splash logo');
run('go', [
  'test',
  './backend/cmd/EFTToolbox',
  '-run',
  'TestSplashLogoIsTransparentPNG',
  '-count=1',
]);
step('Type-checking dashboard');
run(process.execPath, [
  'node_modules/typescript/bin/tsc',
  '--noEmit',
  '-p',
  'dashboard/tsconfig.json',
]);
step('Building dashboard');
run(process.execPath, [
  'dashboard/node_modules/vite/bin/vite.js',
  'build',
  'dashboard',
  '--outDir',
  '../build/dashboard',
  '--emptyOutDir',
]);
await mkdir(output, { recursive: true });
// The desktop host opens a WebView2 window, so the package entry point must be a GUI binary:
// without the windowsgui subsystem a console window opens next to it on every launch.
step('Building backend');
run('go', [
  'build',
  '-ldflags',
  ['-H=windowsgui', ...(!debug ? ['-s', '-w'] : [])].join(' '),
  '-o',
  path.join(output, 'EFTToolbox.exe'),
  './backend/cmd/EFTToolbox',
]);
step('Building overlay');
run('dotnet', [
  'publish',
  'overlay/Overlay.csproj',
  '-c',
  'Release',
  '-o',
  path.join(output, 'overlay'),
  '--self-contained',
  'true',
]);
step('Copying package files');
copyDirectory(path.join(root, 'build/dashboard'), path.join(output, 'dashboard'));
const data = path.join(output, 'data/upstream');
copyDirectory(path.join(upstream, 'modes'), path.join(data, 'modes'));
copyDirectory(path.join(upstream, 'assets'), path.join(data, 'assets'));
copyDirectory(path.join(upstream, 'items'), path.join(data, 'items'));
await copyFile(path.join(upstream, 'stickers.json'), path.join(data, 'stickers.json'));
await copyIfPresent(path.join(upstream, 'catalog_zh.json'), path.join(data, 'catalog_zh.json'));
await copyIfPresent(path.join(upstream, 'catalog_en.json'), path.join(data, 'catalog_en.json'));
await copyIfPresent(
  path.join(defaultsDirectory, 'stun-valid-hosts.txt'),
  path.join(data, 'stun-valid-hosts.txt'),
);
await copyIfPresent(
  path.join(defaultsDirectory, 'stun-valid-ipv4s.txt'),
  path.join(data, 'stun-valid-ipv4s.txt'),
);
await copyIfPresent(
  path.join(defaultsDirectory, 'stun-valid-ipv6s.txt'),
  path.join(data, 'stun-valid-ipv6s.txt'),
);
await copyIfPresent(
  path.join(defaultsDirectory, 'stun-nat-ipv4s.txt'),
  path.join(data, 'stun-nat-ipv4s.txt'),
);
if (lite) {
  const keep = await mapsNeedingTiles(path.join(data, 'modes'));
  await simplifyMaps(path.join(data, 'modes'), keep);
  await mkdir(path.join(data, 'tiles'), { recursive: true });
  await copyLiteTiles(
    path.join(data, 'modes'),
    path.join(upstream, 'tiles'),
    path.join(data, 'tiles'),
    keep,
  );
} else copyDirectory(path.join(upstream, 'tiles'), path.join(data, 'tiles'));
// The notices are generated here rather than copied: the single shipped file then always names every
// third-party component of this build.
step('Writing third-party notices');
await writeFile(path.join(output, 'THIRD-PARTY-NOTICES.txt'), noticesText());
step('Verifying package');
await verifyDisplayResources(path.join(data, 'assets'));
await verifyPackage(output);
console.log(`Portable package: ${output}`);
