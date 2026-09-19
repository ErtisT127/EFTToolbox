import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyDisplayResources } from '../lib/display-resources.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const upstream = path.join(root, 'data/upstream');
await verifyDisplayResources(path.join(upstream, 'assets'));
const output = path.join(root, 'build/package', new Date().toISOString().replace(/[:.]/g, '-'));
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
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
await cp(path.join(root, 'build/dashboard'), path.join(output, 'dashboard'), { recursive: true });
const data = path.join(output, 'data/upstream');
await mkdir(path.join(data, 'tiles'), { recursive: true });
for (const name of ['maps', 'assets', 'catalog.json', 'stickers.json'])
  await cp(path.join(upstream, name), path.join(data, name), { recursive: true });
// Tiles are fetched on demand. Do not copy a multi-GB developer cache or claim absent files exist.
await writeFile(
  path.join(data, 'tiles/manifest.json'),
  JSON.stringify({ schemaVersion: 1, tiles: {} }) + '\n',
);
await writeFile(
  path.join(output, 'THIRD-PARTY-NOTICES.txt'),
  await readFile(path.join(data, 'assets/THIRD-PARTY-NOTICES.txt')),
);
await verifyDisplayResources(path.join(data, 'assets'));
console.log(`Portable package: ${output}`);
