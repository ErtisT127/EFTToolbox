import { createHash } from 'node:crypto';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [action, target] = process.argv.slice(2);
if (!['check', 'save'].includes(action) || !['dashboard', 'backend'].includes(target))
  throw new Error('Usage: pnpm toolbox cache check|save dashboard|backend');
const inputs =
  target === 'dashboard'
    ? [
        'dashboard',
        'contracts/proto',
        'contracts/generate.mjs',
        'contracts/ts',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
      ]
    : ['backend', 'contracts/go', 'go.work', 'go.work.sum'];
inputs.push('scripts/commands/cache.mjs');
const output = target === 'dashboard' ? 'build/dashboard' : 'build/EFTToolbox.exe';
const entry = target === 'dashboard' ? `${output}/index.html` : output;
const stamp = path.join(root, 'build', `.cache-${target}.json`);

async function digest(names) {
  const hash = createHash('sha256');
  async function visit(name) {
    hash.update(name);
    let info;
    try {
      info = await stat(path.join(root, name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('missing');
      return;
    }
    if (info.isDirectory()) {
      for (const child of (await readdir(path.join(root, name))).sort())
        if (!['node_modules', 'dist', '.git'].includes(child)) await visit(`${name}/${child}`);
    } else hash.update(await readFile(path.join(root, name)));
  }
  for (const name of names) await visit(name);
  return hash.digest('hex');
}
const toolchain =
  target === 'dashboard'
    ? process.version
    : spawnSync('go', ['version'], { encoding: 'utf8', windowsHide: true }).stdout?.trim();
if (!toolchain) throw new Error('Cannot read toolchain version');
let exists = true;
try {
  await stat(path.join(root, entry));
} catch {
  exists = false;
}
const state = {
  toolchain,
  inputs: await digest(inputs),
  output: exists ? await digest([output]) : null,
};
if (action === 'save') {
  if (!exists) throw new Error(`Missing build output: ${entry}`);
  await mkdir(path.dirname(stamp), { recursive: true });
  await writeFile(stamp, JSON.stringify(state) + '\n');
} else {
  let previous;
  try {
    previous = JSON.parse(await readFile(stamp, 'utf8'));
  } catch {
    /* A missing/invalid stamp requires a build. */
  }
  process.exitCode = exists && JSON.stringify(previous) === JSON.stringify(state) ? 0 : 1;
}
