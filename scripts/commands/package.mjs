import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyDisplayResources } from '../lib/display-resources.mjs';
import { tileUrls } from '../lib/tile-urls.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const upstream = path.join(root, 'data/upstream');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--lite')) throw new Error('Usage: pnpm toolbox package [--lite]');
const lite = args.includes('--lite');
await verifyDisplayResources(path.join(upstream, 'assets'));
const output = path.join(root, 'build/package', new Date().toISOString().replace(/[:.]/g, '-'));
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
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
const simplifyMaps = async (modes) => {
  const tileMaps = new Set(['lab', 'the-labyrinth', 'icebreaker']);
  for (const mode of await readdir(modes, { withFileTypes: true })) {
    if (!mode.isDirectory()) continue;
    const maps = path.join(modes, mode.name, 'maps');
    for (const file of await readdir(maps, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const name = path.join(maps, file.name);
      const map = JSON.parse(await readFile(name, 'utf8'));
      if (!tileMaps.has(file.name.slice(0, -5))) map.tiles = [];
      await writeFile(name, JSON.stringify(map));
    }
  }
};
const copyLiteTiles = async (modes, sourceRoot, destinationRoot) => {
  const tileMaps = new Set(['lab', 'the-labyrinth', 'icebreaker']);
  const urls = new Set();
  for (const mode of await readdir(modes, { withFileTypes: true })) {
    if (!mode.isDirectory()) continue;
    const maps = path.join(modes, mode.name, 'maps');
    for (const file of await readdir(maps, { withFileTypes: true })) {
      if (!file.isFile() || !tileMaps.has(file.name.slice(0, -5)) || !file.name.endsWith('.json'))
        continue;
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
    JSON.stringify({ schemaVersion: 1, tiles: selectedManifest }) + '\n',
  );
};
run(process.execPath, ['contracts/generate.mjs', '--check']);
run(process.execPath, [
  'node_modules/typescript/bin/tsc',
  '--noEmit',
  '-p',
  'dashboard/tsconfig.json',
]);
run(process.execPath, [
  'dashboard/node_modules/vite/bin/vite.js',
  'build',
  'dashboard',
  '--outDir',
  '../build/dashboard',
  '--emptyOutDir',
]);
await mkdir(output, { recursive: true });
run('go', ['build', '-o', path.join(output, 'EFTToolbox.exe'), './backend/cmd/EFTToolbox']);
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
copyDirectory(path.join(root, 'build/dashboard'), path.join(output, 'dashboard'));
const data = path.join(output, 'data/upstream');
copyDirectory(path.join(upstream, 'modes'), path.join(data, 'modes'));
copyDirectory(path.join(upstream, 'assets'), path.join(data, 'assets'));
copyDirectory(path.join(upstream, 'items'), path.join(data, 'items'));
await copyFile(path.join(upstream, 'stickers.json'), path.join(data, 'stickers.json'));
if (lite) {
  await simplifyMaps(path.join(data, 'modes'));
  await mkdir(path.join(data, 'tiles'), { recursive: true });
  await copyLiteTiles(
    path.join(data, 'modes'),
    path.join(upstream, 'tiles'),
    path.join(data, 'tiles'),
  );
} else copyDirectory(path.join(upstream, 'tiles'), path.join(data, 'tiles'));
await writeFile(
  path.join(output, 'THIRD-PARTY-NOTICES.txt'),
  await readFile(path.join(data, 'assets/THIRD-PARTY-NOTICES.txt')),
);
await verifyDisplayResources(path.join(data, 'assets'));
console.log(`Portable package: ${output}`);
