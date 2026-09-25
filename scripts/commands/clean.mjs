import { existsSync } from 'node:fs';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (!existsSync(path.join(root, 'pnpm-workspace.yaml')))
  throw new Error(`Refusing to clean: ${root} is not the EFTToolbox repository`);
const build = path.join(root, 'build');
if ((await lstat(build).catch(() => null))?.isSymbolicLink())
  throw new Error(`Refusing to clean: ${build} is a junction or symlink`);
const empty = await mkdtemp(path.join(tmpdir(), 'efttoolbox-clean-'));
try {
  const source = await realpath(empty);
  const result = spawnSync(
    'robocopy',
    [source, build, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status === null || result.status > 7)
    throw new Error(`robocopy failed with exit code ${result.status ?? 'unknown'}`);
  await rm(build, { recursive: true, force: true });
} finally {
  await rm(empty, { recursive: true, force: true });
}
console.log('Build outputs cleaned.');
