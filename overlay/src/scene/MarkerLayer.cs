using System.Collections.Concurrent;
using System.Numerics;
using System.Text.Json;
using EFTToolbox.Contracts;
using ImGuiNET;

namespace EFTToolbox.Overlay;

internal sealed class MarkerLayer(Action wake) : IDisposable
{
    private readonly ConcurrentQueue<(int Generation, string Key, RasterizedSvg? Image, bool Text)> ready = new();
    private readonly ConcurrentQueue<(int Generation, Dictionary<string, Sticker> Entries)> catalogs = new();
    private readonly HashSet<string> requested = [];
    private readonly Dictionary<string, long> failed = new();
    private Dictionary<string, Sticker> stickers = new();
    private readonly SemaphoreSlim workers = new(4);
    private readonly MapTextRasterizer textRasterizer = new();
    private string assetRoot = "";
    private int generation, catalogGeneration;
    internal void CancelPending() { Interlocked.Increment(ref generation); requested.Clear(); ready.Clear(); failed.Clear(); }
    internal void SetAssets(string root)
    {
        assetRoot = root; CancelPending(); stickers = new();
        var version = ++catalogGeneration;
        _ = Task.Run(() => {
            try {
                var file = Path.Combine(Path.GetDirectoryName(root)!, "stickers.json");
                var entries = File.Exists(file) ? (OverlayStateClient.Read<Sticker[]>(file) ?? []).ToDictionary(s => s.Id) : new();
                catalogs.Enqueue((version, entries)); wake();
            } catch (Exception e) { OverlayDiagnostics.Log("warn", "sticker_catalog_failed", e.Message); }
        });
    }
    internal void Upload(TextureCache images, TextureCache texts)
    {
        var timer = System.Diagnostics.Stopwatch.StartNew();
        while (catalogs.TryDequeue(out var catalog)) if (catalog.Generation == catalogGeneration) stickers = catalog.Entries;
        while (timer.Elapsed.TotalMilliseconds < 4 && ready.TryDequeue(out var item))
        {
            if (item.Generation != generation) continue;
            requested.Remove(item.Key);
            if (item.Image is null) { failed[item.Key] = Environment.TickCount64; continue; }
            try { (item.Text ? texts : images).Put(item.Key, item.Image); }
            catch (Exception e) { failed[item.Key] = Environment.TickCount64; OverlayDiagnostics.Log("warn", "marker_upload_failed", e.Message); }
        }
        if (!ready.IsEmpty) wake();
    }
    private void Request(string key, bool text, Func<string, RasterizedSvg> render, Operation? operation)
    {
        if (assetRoot == "" || requested.Contains(key) || failed.TryGetValue(key, out var at) && Environment.TickCount64 - at < 10_000) return;
        requested.Add(key); var root = assetRoot; var version = generation;
        _ = Task.Run(async () => {
            await workers.WaitAsync();
            try {
                if (version != Volatile.Read(ref generation)) return;
                var image = render(root);
                if (version == Volatile.Read(ref generation)) { ready.Enqueue((version, key, image, text)); wake(); }
            } catch (Exception e) {
                if (version == Volatile.Read(ref generation)) { ready.Enqueue((version, key, null, text)); wake(); }
                OverlayDiagnostics.Log("warn", "marker_asset_failed", e.Message, operation);
            } finally { workers.Release(); }
        });
    }
    private static uint Color(string hex, float opacity = 1)
    {
        if (!uint.TryParse(hex.TrimStart('#'), System.Globalization.NumberStyles.HexNumber, null, out var rgb)) rgb = 0xc4d35f;
        return ((uint)(opacity * 255) << 24) | ((rgb & 255) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 255);
    }
    private static string NamedColor(string category) => category switch {
        "extract/scav" => MapDisplay.ExtractScav, "extract/shared" => MapDisplay.ExtractShared,
        "transit" => MapDisplay.Transit, "btrStops" => MapDisplay.LabelColor, _ => MapDisplay.ExtractPmc,
    };
    internal void Draw(ImDrawListPtr draw, MapScene scene, TextureCache images, TextureCache texts, Operation? operation)
    {
        var map = scene.Map!; var dpi = scene.Dpi;
        var categories = map.Categories.ToDictionary(c => c.Id); var hidden = scene.Preference.HiddenCategories.ToHashSet(); var tasks = scene.Preference.SelectedTasks.ToHashSet();
        bool InView(Vector2 p, Vector2 half) => p.X + half.X >= 0 && p.Y + half.Y >= 0 && p.X - half.X < scene.Width && p.Y - half.Y < scene.Height;
        void Text(string text, string role, float size, float width, string color, Vector2 anchor, float opacity = 1, float rotation = 0, bool bottom = false)
        {
            if (text == "") return;
            var request = new MapText(text, role, size, width, color, dpi);
            var key = $"{generation}:text:{JsonSerializer.Serialize(request)}";
            if (texts.Get(key) is not { } texture) { Request(key, true, root => textRasterizer.Rasterize(root, request), operation); return; }
            var half = texts.Size(key) / 2;
            var p = bottom ? anchor - new Vector2(0, half.Y - 4 * dpi) : anchor;
            var angle = rotation * MathF.PI / 180;
            var extent = new Vector2(MathF.Abs(MathF.Cos(angle)) * half.X + MathF.Abs(MathF.Sin(angle)) * half.Y, MathF.Abs(MathF.Sin(angle)) * half.X + MathF.Abs(MathF.Cos(angle)) * half.Y);
            if (!InView(p, extent)) return;
            Vector2 Rotate(Vector2 v) => p + new Vector2(v.X * MathF.Cos(angle) - v.Y * MathF.Sin(angle), v.X * MathF.Sin(angle) + v.Y * MathF.Cos(angle));
            draw.AddImageQuad(texture.NativePointer, Rotate(-half), Rotate(new(half.X, -half.Y)), Rotate(half), Rotate(new(-half.X, half.Y)), Vector2.Zero, Vector2.UnitX, Vector2.One, Vector2.UnitY, Color("ffffff", opacity));
        }
        void Icon(string url, Vector2 p, float size, float opacity, bool art = false, bool placeholder = false, bool rim = true)
        {
            if (!InView(p, new Vector2((size / 2 + MapDisplay.IconPad) * dpi))) return;
            if (url == "") { if (placeholder) Text("?", "annotation", 15, 0, MapDisplay.LabelColor, p); return; }
            var key = $"{generation}:{url}:{size}:{dpi}:{art}:{rim}:2";
            if (images.Get(key) is { } texture) {
                var half = images.Size(key) / 2;
                draw.AddImage(texture.NativePointer, p - half, p + half, Vector2.Zero, Vector2.One, Color("ffffff", opacity));
            } else {
                Request(key, false, root => {
                    var path = Path.Combine(root, Path.GetFileName(url));
                    RasterizedSvg image;
                    if (path.EndsWith(".svg", StringComparison.OrdinalIgnoreCase)) { using var raster = new SvgRasterizer(); image = raster.Rasterize(path, Math.Max(64, (int)Math.Ceiling(size * dpi))); }
                    else image = SvgRasterizer.Decode(File.ReadAllBytes(path));
                    return SvgRasterizer.Artwork(image, size, dpi, art, rim);
                }, operation);
                if (placeholder && failed.ContainsKey(key)) Text("?", "annotation", 15, 0, MapDisplay.LabelColor, p);
            }
        }
        var annotations = scene.Preference.ShowAnnotations ? scene.Annotations.Where(a => a.FloorId == scene.Floor).ToArray() : [];
        // Leaflet's vector pane sits below labels and symbols. Round caps also preserve a brush tap.
        foreach (var a in annotations.Where(a => a.Kind == "stroke")) {
            var thickness = (float)a.Width * dpi;
            for (int i = 0; i < a.Points.Length; i++) {
                var p = scene.Screen(a.Points[i]);
                if (i > 0) draw.AddLine(scene.Screen(a.Points[i - 1]), p, Color(a.Color), thickness);
                draw.AddCircleFilled(p, thickness / 2, Color(a.Color));
            }
        }
        var markers = map.Markers.Where(m => !m.CategoryIds.All(hidden.Contains) && !(m.TaskId != "" && scene.Preference.TaskFilterActive && !tasks.Contains(m.TaskId)))
            .Select((m, index) => (Marker: m, Category: categories[m.CategoryId], P: scene.Screen(m.Position), Active: m.FloorIds.Length == 0 || m.FloorIds.Contains(scene.Floor), Index: index)).ToArray();
        foreach (var m in markers.Where(m => m.Category.Symbol == "label" && m.Active))
            Text(m.Marker.Name, "landmark", (float)(MapDisplay.LandmarkFontSize * (m.Marker.LabelSize > 0 ? m.Marker.LabelSize / 100 : 1)), MapDisplay.LandmarkWidth, MapDisplay.LabelColor, m.P, rotation: (float)m.Marker.LabelRotation);
        foreach (var m in markers.Where(m => m.Category.Symbol is not ("label" or "exit" or "btr")).OrderBy(m => m.P.Y / dpi + (m.Active ? 1000 : 0)).ThenBy(m => m.Index))
            Icon(m.Marker.IconUrl != "" ? m.Marker.IconUrl : m.Category.IconUrl, m.P, MapDisplay.IconSize, m.Active ? 1 : MapDisplay.InactiveOpacity, m.Marker.IconUrl.Contains("/item-") && m.Marker.IconUrl != m.Category.IconUrl);
        // Named POIs and user marker anchors share the same screen-y ordered pane.
        var foreground = new List<(float Order, Action Draw)>();
        foreach (var m in markers.Where(m => m.Category.Symbol is "exit" or "btr")) foreground.Add((m.P.Y / dpi + (m.Active ? 1000 : 0), () => {
            var size = MapDisplay.IconSize * (m.Category.Symbol == "btr" ? MapDisplay.BtrScale : 1);
            var opacity = m.Active ? 1 : MapDisplay.InactiveOpacity;
            Icon(m.Marker.IconUrl != "" ? m.Marker.IconUrl : m.Category.IconUrl, m.P + new Vector2((size - MapDisplay.IconSize) / 2 * dpi, 0), size, opacity);
            // Text textures are centred; use the cached width to place their left content edge.
            var request = new MapText(m.Marker.Name, "named", MapDisplay.NamedFontSize, 0, NamedColor(m.Category.Id), dpi);
            var key = $"{generation}:text:{JsonSerializer.Serialize(request)}";
            var x = (-MapDisplay.IconSize / 2 + size + MapDisplay.NamedGap - 4) * dpi + texts.Size(key).X / 2;
            Text(m.Marker.Name, "named", MapDisplay.NamedFontSize, 0, NamedColor(m.Category.Id), m.P + new Vector2(x, 0), opacity);
        }));
        foreach (var a in annotations.Where(a => a.Kind != "stroke" && a.Points.Length > 0)) {
            var p = scene.Screen(a.Points[0]);
            foreground.Add((p.Y / dpi, () => {
                var glyph = a.ImageId != "" || a.Emoji != "";
                if (a.ImageId != "") { stickers.TryGetValue(a.ImageId, out var sticker); Icon(sticker?.IconUrl ?? "", p, MapDisplay.StickerSize, 1, sticker is not null && sticker.Group is not ("extract" or "container"), true, sticker?.Group is not ("boss" or "trader")); }
                else if (a.Emoji != "") Icon(MapDisplay.Emoji.TryGetValue(a.Emoji, out var code) ? $"emoji-{code}.png" : "", p, MapDisplay.EmojiSize, 1, placeholder: true);
                Text(a.Text, "annotation", (float)a.TextSize, 0, a.Color, p - new Vector2(0, glyph ? MapDisplay.StickerSize / 2 * dpi : 0), bottom: glyph);
            }));
        }
        foreach (var item in foreground.OrderBy(item => item.Order)) item.Draw();
        foreach (var player in scene.Players.Values.Where(p => p.MapId == map.Id)) {
            var p = scene.Screen(player.Position); if (!InView(p, new Vector2(14 * dpi))) continue;
            var angle = (float)((player.Heading + 180) * Math.PI / 180); var d = new Vector2(MathF.Sin(angle), -MathF.Cos(angle)); var side = new Vector2(-d.Y, d.X);
            draw.AddTriangleFilled(p + d * 12 * dpi, p - d * 12 * dpi + side * 10 * dpi, p - d * 12 * dpi - side * 10 * dpi, Color(MapDisplay.Accent, player.FloorId == scene.Floor ? 1 : MapDisplay.OtherFloorPlayerOpacity));
        }
    }
    public void Dispose()
    {
        CancelPending();
        _ = Task.Run(async () => { for (var i = 0; i < 4; i++) await workers.WaitAsync(); textRasterizer.Dispose(); });
    }
}
