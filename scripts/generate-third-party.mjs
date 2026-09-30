// Renders the third-party list (scripts/config/third-party.mjs) into the module the About page
// imports. The packaged THIRD-PARTY-NOTICES.txt comes from the same list, but the packager writes
// it; this script only keeps the committed dashboard module fresh.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { thirdPartyModuleText } from './lib/third-party.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const modulePath = path.join(root, 'dashboard/src/third-party.gen.ts');
const check = process.argv.includes('--check');

if (check) {
  if ((await readFile(modulePath, 'utf8')) !== thirdPartyModuleText())
    throw new Error('Stale third-party list: dashboard/src/third-party.gen.ts');
  console.log('Third-party list is up to date');
} else {
  await writeFile(modulePath, thirdPartyModuleText());
  console.log('Wrote dashboard/src/third-party.gen.ts');
}
