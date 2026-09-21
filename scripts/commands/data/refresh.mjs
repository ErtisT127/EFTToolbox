import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

console.log('Refreshing upstream map data...');
await import('./sources.mjs');
await import('./icons.mjs');
await import('./fonts.mjs');
await import('./svgs.mjs');
await import('./item-images.mjs');
for (const mode of ['pvp', 'pve', 'pvp-season'])
  execFileSync(process.execPath, [fileURLToPath(new URL('./prepare.mjs', import.meta.url)), mode], {
    stdio: 'inherit',
  });
