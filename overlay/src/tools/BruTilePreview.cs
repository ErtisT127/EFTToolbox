using System.Drawing;
using System.Drawing.Drawing2D;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BruTile;

namespace EFTToolbox.Overlay;

internal static class BruTilePreview
{
    internal static async Task Run(string root)
    {
        var mapFile = Path.Combine(root, "data", "upstream", "maps", "factory.json");
        var manifestFile = Path.Combine(root, "data", "upstream", "tiles", "manifest.json");
        var cacheRoot = Path.Combine(root, "data", "upstream", "tiles");
        using var map = JsonDocument.Parse(await File.ReadAllTextAsync(mapFile));
        var tile = map.RootElement.GetProperty("tiles")[0];
        var source = tile.GetProperty("sourceUrl").GetString()!;
        var z = tile.GetProperty("minZoom").GetInt32();
        var size = tile.GetProperty("tileSize").GetInt32();
        var transform = tile.GetProperty("transform").EnumerateArray().Select(x => x.GetDouble()).ToArray();
        var bounds = tile.GetProperty("bounds").EnumerateArray().ToArray();
        var mapPoints = bounds.Select(p => (X: p.GetProperty("x").GetDouble(), Y: p.GetProperty("y").GetDouble())).ToArray();
        var scale = Math.Pow(2, z);
        var xs = mapPoints.Select(p => (transform[0] * p.X + transform[1]) * scale).ToArray();
        var ys = mapPoints.Select(p => (transform[2] * p.Y + transform[3]) * scale).ToArray();
        var minX = Math.Floor(xs.Min() / size) * size;
        var minY = Math.Floor(ys.Min() / size) * size;
        var maxX = Math.Ceiling(xs.Max() / size) * size;
        var maxY = Math.Ceiling(ys.Max() / size) * size;
        var schema = new TileSchema
        {
            Name = "factory",
            Extent = new Extent(minX, minY, maxX, maxY),
            OriginX = minX,
            OriginY = maxY,
            YAxis = YAxis.OSM,
        };
        schema.Resolutions[z] = new Resolution(z, 1, size, size, maxY, minX,
            (long)Math.Ceiling((maxX - minX) / size), (long)Math.Ceiling((maxY - minY) / size), 1);
        var manifest = JsonDocument.Parse(await File.ReadAllTextAsync(manifestFile));
        var tiles = schema.GetTileInfos(schema.Extent, z).ToArray();
        using var image = new Bitmap((int)(maxX - minX), (int)(maxY - minY));
        using var graphics = Graphics.FromImage(image);
        graphics.Clear(Color.Transparent);
        graphics.InterpolationMode = InterpolationMode.NearestNeighbor;
        var loaded = 0;
        foreach (var info in tiles)
        {
            var url = source.Replace("{z}", z.ToString()).Replace("{x}", info.Index.Col.ToString()).Replace("{y}", info.Index.Row.ToString());
            if (!manifest.RootElement.GetProperty("tiles").TryGetProperty(url, out var record) || record.GetProperty("missing").GetBoolean()) continue;
            // The manifest sha256 is the content digest. The on-disk cache is keyed by
            // the substituted source URL (the same rule used by the backend and tiles.mjs).
            var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url))).ToLowerInvariant();
            var file = Path.Combine(cacheRoot, key[..2], key + ".png");
            if (!File.Exists(file)) continue;
            var bytes = await File.ReadAllBytesAsync(file);
            var expected = record.GetProperty("sha256").GetString();
            if (expected is null || !Convert.ToHexString(SHA256.HashData(bytes)).Equals(expected, StringComparison.OrdinalIgnoreCase))
            {
                Console.Error.WriteLine($"BruTile preview: skipped invalid cache entry {url}");
                continue;
            }
            using var stream = new MemoryStream(bytes, writable: false);
            using var tileImage = new Bitmap(stream);
            var x = (int)(info.Extent.MinX - minX);
            // The source URL uses TMS-style rows (y=0 is the bottom row), while
            // this schema is configured with the OSM/top-origin matrix so that
            // BruTile can enumerate the viewport. Flip the destination row when
            // composing; otherwise the map is vertically scrambled.
            var y = (int)(maxY - info.Extent.MaxY);
            graphics.DrawImageUnscaled(tileImage, x, y);
            loaded++;
        }
        var output = Path.Combine(root, "build", "overlay-factory-tile-preview.png");
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        image.Save(output, System.Drawing.Imaging.ImageFormat.Png);
        Console.WriteLine($"BruTile preview: {loaded}/{tiles.Length} tiles loaded -> {output}");
    }
}
