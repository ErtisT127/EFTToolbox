const [group, command, ...args] = process.argv.slice(2);

const commands = {
  'data:refresh': ['commands/data/refresh.mjs', []],
  'data:sources': ['commands/data/sources.mjs', []],
  'data:icons': ['commands/data/icons.mjs', args],
  'data:svgs': ['commands/data/svgs.mjs', []],
  'data:items': ['commands/data/items.mjs', args],
  'data:fonts': ['commands/data/fonts.mjs', args],
  package: ['commands/package.mjs', [command, ...args].filter((arg) => arg !== undefined)],
  'data:prepare': ['commands/data/prepare.mjs', args],
  'data:tiles': ['commands/data/tiles.mjs', args],
  clean: ['commands/clean.mjs', []],
  lint: ['commands/lint.mjs', []],
  cache: ['commands/cache.mjs', [command, ...args]],
};

function usage() {
  console.log(`Usage: pnpm toolbox <command> [options]

Commands:
  data refresh       Download and prepare all map data
  data sources       Download upstream source snapshots
  data icons         Download upstream map icons
  data svgs          Download current map SVGs
  data items [mode]  Pull item images (cache-skip) and the item catalog (overwrite) for one or all modes
  data fonts         Prepare licensed static fonts and emoji (uv); --check verifies hashes
  package            Build a portable package (--fast skips data, --lite keeps required tiles, --debug includes symbols and source maps)
  data prepare       Generate runtime map data
  data tiles         Prefetch map tiles (--all, --count)
  clean               Remove generated build outputs quickly
  lint               Run repository lint checks
  cache check|save   Check or save a build cache (dashboard|backend)`);
}

if (group === 'help' || group === '--help' || group === undefined) {
  usage();
  process.exit(0);
}

const key = group === 'data' ? `data:${command}` : group;
const entry = commands[key];
if (!entry) {
  usage();
  throw new Error(`Unknown command: ${group}${command ? ` ${command}` : ''}`);
}

process.argv = [process.argv[0], process.argv[1], ...entry[1]];
await import(new URL(entry[0], import.meta.url));
