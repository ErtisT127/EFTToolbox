import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyDisplayResources } from '../lib/display-resources.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const upstream = path.join(root, 'data/upstream');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--no-tiles'))
  throw new Error('Usage: pnpm toolbox package [--no-tiles]');
const noTiles = args.includes('--no-tiles');
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
if (noTiles) {
  await mkdir(path.join(data, 'tiles'), { recursive: true });
  await writeFile(
    path.join(data, 'tiles/manifest.json'),
    JSON.stringify({ schemaVersion: 1, tiles: {} }) + '\n',
  );
} else copyDirectory(path.join(upstream, 'tiles'), path.join(data, 'tiles'));
await writeFile(
  path.join(output, 'THIRD-PARTY-NOTICES.txt'),
  await readFile(path.join(data, 'assets/THIRD-PARTY-NOTICES.txt')),
);
await verifyDisplayResources(path.join(data, 'assets'));
console.log(`Portable package: ${output}`);
