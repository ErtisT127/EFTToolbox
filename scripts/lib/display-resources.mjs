import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function verifyDisplayResources(assets) {
  const manifest = JSON.parse(await readFile(path.join(assets, 'display-resources.json'), 'utf8'));
  for (const entry of manifest.files) {
    const file = path.resolve(assets, entry.file);
    if (!file.startsWith(path.resolve(assets) + path.sep))
      throw new Error('Resource manifest path escapes assets');
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
      throw new Error(`Changed display resource: ${entry.file}`);
    if (entry.license.startsWith('licenses/')) await readFile(path.join(assets, entry.license));
  }
  const approved = new Set(manifest.files.map((entry) => entry.file));
  async function fonts(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await fonts(path.join(directory, entry.name), relative + '/');
      else if (/\.(ttf|otf|ttc|woff2?)$/i.test(entry.name) && !approved.has(relative))
        throw new Error(`Unverified font cannot ship: ${relative}`);
    }
  }
  await fonts(assets);
  return manifest;
}
