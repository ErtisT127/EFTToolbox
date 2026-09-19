import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
process.chdir(root);

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

function jsTool(name, args) {
  run(process.execPath, [path.join(root, 'node_modules', ...name.split('/')), ...args]);
}

console.log('React / TypeScript / formatting');
jsTool('eslint/bin/eslint.js', [
  'dashboard/src',
  'dashboard/test',
  'contracts/generate.mjs',
  'scripts',
  'eslint.config.mjs',
  '--max-warnings=0',
]);
jsTool('typescript/bin/tsc', ['--noEmit', '-p', 'dashboard/tsconfig.json']);
jsTool('prettier/bin/prettier.cjs', ['--check', '.']);
run(process.execPath, ['contracts/generate.mjs', '--check']);

console.log('Dashboard i18n');
const localeDir = path.join(root, 'dashboard', 'src', 'i18n', 'locales');
const cjk = /[一-鿿]/;
for (const file of sources(path.join(root, 'dashboard', 'src'))) {
  if (file.startsWith(localeDir)) continue;
  if (cjk.test(readFileSync(file, 'utf8'))) {
    console.error(`Hardcoded Chinese outside the locale files: ${path.relative(root, file)}`);
    process.exit(1);
  }
}

console.log('Go');
for (const module of ['backend', 'contracts/go']) {
  run(
    'go',
    ['tool', 'golangci-lint', 'run', '--config', path.join(root, '.golangci.yml'), './...'],
    path.join(root, module),
  );
  run(
    'go',
    [
      'tool',
      'golangci-lint',
      'fmt',
      '--diff',
      '--config',
      path.join(root, '.golangci.yml'),
      './...',
    ],
    path.join(root, module),
  );
}

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(name) : /\.tsx?$/.test(name) ? [name] : [];
  });
}

function projects(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['bin', 'obj'].includes(entry.name)) return [];
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? projects(name) : entry.name.endsWith('.csproj') ? [name] : [];
  });
}

const csharp = projects(path.join(root, 'overlay'));
if (csharp.length === 0)
  console.log('C#: no overlay project yet; shared analyzer configuration is ready.');
for (const project of csharp) run('dotnet', ['build', project, '--nologo', '--verbosity', 'quiet']);
console.log('Lint passed.');
