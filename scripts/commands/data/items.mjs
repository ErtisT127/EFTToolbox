// Developer pull for the item catalog and the shared image cache. Without an argument every
// mode refreshes; `data items <mode>` pulls one. The same lib functions back the future backend
// pull entry, which passes the current mode explicitly.
import { fileURLToPath } from 'node:url';
import {
  buildCatalog,
  imageJobs,
  imageUrls,
  loadModeSnapshots,
  modes,
  syncImages,
  writeCatalog,
} from '../../lib/item-pull.mjs';

const upstream = fileURLToPath(new URL('../../../data/upstream/', import.meta.url));
const requested = process.argv.slice(2).filter(Boolean);
const unknown = requested.filter((mode) => !modes.includes(mode));
if (unknown.length) throw new Error(`Unsupported mode(s): ${unknown.join(', ')}`);

for (const mode of requested.length ? requested : modes) {
  const snapshots = await loadModeSnapshots(upstream, mode);
  const { manifest, downloaded, skipped } = await syncImages(upstream, imageJobs(snapshots));
  const catalog = buildCatalog(mode, snapshots, imageUrls(manifest));
  await writeCatalog(upstream, mode, catalog);
  console.log(
    `${mode}: ${downloaded} images downloaded, ${skipped} cached, ${catalog.zh.items.length} items catalogued`,
  );
}
