export function tileUrls(map, allZooms = true) {
  const urls = new Set();
  for (const tile of map.tiles) {
    const [a, b, c, d] = tile.transform;
    for (let z = tile.minZoom; z <= (allZooms ? tile.maxZoom : tile.minZoom); z++) {
      const scale = 2 ** z / tile.tileSize;
      const xs = tile.bounds.map((point) => (a * point.x + b) * scale);
      const ys = tile.bounds.map((point) => (c * point.y + d) * scale);
      for (let x = Math.floor(Math.min(...xs)); x < Math.ceil(Math.max(...xs)); x++)
        for (let y = Math.floor(Math.min(...ys)); y < Math.ceil(Math.max(...ys)); y++)
          urls.add(tile.sourceUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
  }
  return urls;
}
