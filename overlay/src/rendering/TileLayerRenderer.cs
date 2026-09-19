using System.Collections.Concurrent;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BruTile;
using EFTToolbox.Contracts;

namespace EFTToolbox.Overlay;

internal sealed record VisibleTile(string Key, string Path, string Digest, string Url, Vector2 A, Vector2 B, float Opacity, bool InViewport);
internal sealed class TileLayerRenderer : IDisposable
{
    private readonly SemaphoreSlim workers = new(4);
    private readonly Dictionary<string, CancellationTokenSource> pending = new();
    // A failed tile is retried after a pause rather than for good: the backend answers a tile it
    // cannot fetch right now with an error, and that must not leave a permanent hole.
    private readonly Dictionary<string, long> failed = new();
    private readonly ConcurrentQueue<(string Key, RasterizedSvg Image, int Generation, Operation? Operation, string Resource, double Queue, double Read, double Decode)> ready = new();
    private HashSet<string> viewport = [];
    private readonly Action wake;
    private readonly OverlayStateClient client;
    private readonly object gate = new();
    private Dictionary<string, string> manifest = new();
    private int generation;
    private const long RetryAfter = 10_000;
    internal VisibleTile[] Visible { get; private set; } = [];
    internal bool Loading { get { lock (gate) return pending.Keys.Any(viewport.Contains) || ready.Any(r => r.Generation == generation && viewport.Contains(r.Key)); } }
    internal TileLayerRenderer(Action wake, OverlayStateClient client)
    {
        this.wake = wake; this.client = client;
    }
    internal void SetManifest(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
        var next = doc.RootElement.GetProperty("tiles").EnumerateObject().Where(p => !p.Value.GetProperty("missing").GetBoolean()).ToDictionary(p => p.Name, p => p.Value.GetProperty("sha256").GetString()!);
        Volatile.Write(ref manifest, next);
        lock (gate) failed.Clear();
        wake();
    }
    internal static IEnumerable<(int X, int Y)> Indices(TileLayer tile, Vector2 a, Vector2 b, int z)
    {
        var t = tile.Transform; var scale = Math.Pow(2, z);
        double X(double x) => (t[0] * x + t[1]) * scale;
        double Y(double y) => (t[2] * y + t[3]) * scale;
        var bounds = tile.Bounds;
        var extent = new Extent(Math.Min(X(bounds[0].X), X(bounds[1].X)), Math.Min(Y(bounds[0].Y), Y(bounds[1].Y)), Math.Max(X(bounds[0].X), X(bounds[1].X)), Math.Max(Y(bounds[0].Y), Y(bounds[1].Y)));
        var minX = Math.Max(extent.MinX, Math.Min(X(a.X), X(b.X)) - tile.TileSize); var maxX = Math.Min(extent.MaxX, Math.Max(X(a.X), X(b.X)) + tile.TileSize);
        var minY = Math.Max(extent.MinY, Math.Min(Y(a.Y), Y(b.Y)) - tile.TileSize); var maxY = Math.Min(extent.MaxY, Math.Max(Y(a.Y), Y(b.Y)) + tile.TileSize);
        if (minX >= maxX || minY >= maxY) yield break;
        // Adapted map coordinates already include source orientation. TMS rows increase
        // from the matrix origin; never apply the OSM 2^z-1-y rule to this affine grid.
        var schema = new TileSchema { Name = tile.Id, Extent = extent, OriginX = 0, OriginY = 0, YAxis = YAxis.TMS };
        schema.Resolutions[z] = new Resolution(z, 1, tile.TileSize, tile.TileSize);
        foreach (var info in schema.GetTileInfos(new Extent(minX, minY, maxX, maxY), z)) yield return (info.Index.Col, info.Index.Row);
    }
    internal void Update(MapScene scene, string root, TextureCache cache, Operation? operation = null)
    {
        if (scene.Map is null || scene.Basemap != "tiles") { Visible = []; return; }
        var map = scene.Map; var active = map.Tiles.FirstOrDefault(t => t.FloorId == scene.Floor); var basis = map.Tiles.FirstOrDefault(t => t.FloorId == map.BaseFloor) ?? map.Tiles.FirstOrDefault();
        var layers = new[] { basis, active }.Where(t => t is not null).Distinct().Cast<TileLayer>().ToArray();
        var now = Environment.TickCount64;
        var visible = new List<VisibleTile>();
        var contentManifest = Volatile.Read(ref manifest);
        foreach (var tile in layers)
        {
            var z = Math.Clamp((int)Math.Round(scene.Zoom), tile.MinZoom, tile.MaxZoom);
            var topLeft = scene.MapPoint(Vector2.Zero); var bottomRight = scene.MapPoint(new(scene.Width, scene.Height));
            var indices = Indices(tile, topLeft, bottomRight, z).ToArray();
            // Keep the viewport and its prefetch ring resident together, including both floors.
            while (indices.Length > cache.Capacity / layers.Length && z > tile.MinZoom)
                indices = Indices(tile, topLeft, bottomRight, --z).ToArray();
            var scale = Math.Pow(2, z); var t = tile.Transform;
            foreach (var (x, y) in indices)
            {
                var url = tile.SourceUrl.Replace("{z}", z.ToString()).Replace("{x}", x.ToString()).Replace("{y}", y.ToString());
                var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url))).ToLowerInvariant();
                var a = new Vector2((float)((x * tile.TileSize / scale - t[1]) / t[0]), (float)((y * tile.TileSize / scale - t[3]) / t[2]));
                var b = new Vector2((float)(((x + 1) * tile.TileSize / scale - t[1]) / t[0]), (float)(((y + 1) * tile.TileSize / scale - t[3]) / t[2]));
                var sa = scene.Screen(a); var sb = scene.Screen(b);
                var inside = Math.Max(sa.X, sb.X) > 0 && Math.Min(sa.X, sb.X) < scene.Width && Math.Max(sa.Y, sb.Y) > 0 && Math.Min(sa.Y, sb.Y) < scene.Height;
                visible.Add(new(key, Path.Combine(root, key[..2], key + ".png"), contentManifest.GetValueOrDefault(url, ""), tile.Url.Replace("{z}", z.ToString()).Replace("{x}", x.ToString()).Replace("{y}", y.ToString()), a, b, tile == basis && scene.Floor != basis.FloorId ? 0.2f : 1, inside));
            }
        }
        Visible = visible.OrderByDescending(t => t.InViewport).ToArray();
        viewport = Visible.Where(t => t.InViewport).Select(t => t.Key).ToHashSet(); var needed = Visible.Select(t => t.Key).ToHashSet();
        lock (gate)
        {
            foreach (var key in pending.Keys.Where(k => !needed.Contains(k)).ToArray()) { pending[key].Cancel(); pending.Remove(key); }
            foreach (var tile in Visible)
            {
                if (cache.Contains(tile.Key) || pending.ContainsKey(tile.Key)) continue;
                if (failed.TryGetValue(tile.Key, out var failedAt) && now - failedAt < RetryAfter) continue;
                var cts = new CancellationTokenSource(); pending[tile.Key] = cts; var version = generation; var queued = System.Diagnostics.Stopwatch.GetTimestamp();
                _ = Task.Run(async () =>
                {
                    var entered = false;
                    try
                    {
                        await workers.WaitAsync(cts.Token); entered = true;
                        var queueMs = System.Diagnostics.Stopwatch.GetElapsedTime(queued).TotalMilliseconds; var timer = System.Diagnostics.Stopwatch.StartNew();
                        // A tile the pipeline validated is read straight off the disk; anything deeper
                        // than its low-zoom baseline is asked of the backend, which downloads it.
                        byte[] bytes;
                        if (tile.Digest.Length == 64)
                        {
                            bytes = await File.ReadAllBytesAsync(tile.Path, cts.Token);
                            if (!Convert.ToHexString(SHA256.HashData(bytes)).Equals(tile.Digest, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Tile digest mismatch");
                        }
                        else bytes = await client.TileAsync(tile.Url, cts.Token);
                        var readMs = timer.Elapsed.TotalMilliseconds; timer.Restart();
                        var image = SvgRasterizer.Decode(bytes); cts.Token.ThrowIfCancellationRequested(); ready.Enqueue((tile.Key, image, version, tile.InViewport ? operation : null, tile.Url, queueMs, readMs, timer.Elapsed.TotalMilliseconds)); wake();
                    }
                    catch (OperationCanceledException) { }
                    catch (Exception e) { lock (gate) { if (version == generation) failed[tile.Key] = Environment.TickCount64; } OverlayDiagnostics.Log("warn", "tile_load_failed", e.Message, operation, tile.Url); }
                    finally { if (entered) workers.Release(); lock (gate) { if (pending.TryGetValue(tile.Key, out var current) && current == cts) pending.Remove(tile.Key); } cts.Dispose(); wake(); }
                });
            }
        }
    }
    internal void Upload(TextureCache cache)
    {
        var timer = System.Diagnostics.Stopwatch.StartNew();
        while (timer.Elapsed.TotalMilliseconds < 4 && ready.TryDequeue(out var value)) if (value.Generation == generation) {
            var upload = System.Diagnostics.Stopwatch.StartNew(); cache.Put(value.Key, value.Image);
            value.Operation?.Resource(value.Resource, value.Queue, value.Read, value.Decode, upload.Elapsed.TotalMilliseconds);
        }
        if (!ready.IsEmpty) wake();
    }
    internal void Clear()
    {
        lock (gate) { generation++; foreach (var c in pending.Values) c.Cancel(); pending.Clear(); failed.Clear(); }
        while (ready.TryDequeue(out _)) { }
        Visible = [];
    }
    public void Dispose() => Clear();
}
