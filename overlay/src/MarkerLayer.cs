using System.Collections.Concurrent;
using System.Numerics;
using EFTToolbox.Contracts;
using ImGuiNET;

namespace EFTToolbox.Overlay;

internal sealed class MarkerLayer(Action wake)
{
    private readonly ConcurrentQueue<(int Generation, string Key, RasterizedSvg Image)> ready = new();
    private readonly ConcurrentQueue<(int Generation, Dictionary<string, string> Urls)> catalogs = new();
    private readonly HashSet<string> requested = [];
    private Dictionary<string, string> stickerUrls = new();
    private readonly SemaphoreSlim workers = new(4);
    private string assetRoot = "";
    private int generation;
    private int catalogGeneration;
    internal void CancelPending()
    {
        Interlocked.Increment(ref generation); requested.Clear(); ready.Clear();
    }
    internal void SetAssets(string root)
    {
        assetRoot = root; CancelPending(); stickerUrls = new();
        var version = ++catalogGeneration;
        _ = Task.Run(() => {
            try {
                var urls = new Dictionary<string, string>();
                var file = Path.Combine(Path.GetDirectoryName(root)!, "stickers.json");
                if (File.Exists(file)) foreach (var s in OverlayStateClient.Read<Sticker[]>(file) ?? []) urls[s.Id] = s.IconUrl;
                catalogs.Enqueue((version, urls)); wake();
            } catch (Exception e) { OverlayDiagnostics.Log("warn", "sticker_catalog_failed", e.Message); }
        });
    }
    internal void Upload(TextureCache images)
    {
        var timer = System.Diagnostics.Stopwatch.StartNew();
        while (catalogs.TryDequeue(out var catalog)) if (catalog.Generation == catalogGeneration) stickerUrls = catalog.Urls;
        while (timer.Elapsed.TotalMilliseconds < 4 && ready.TryDequeue(out var item)) {
            if (item.Generation != generation) continue;
            images.Put(item.Key, item.Image); requested.Remove(item.Key);
        }
        if (!ready.IsEmpty) wake();
    }
    private void Load(string url, Operation? operation)
    {
        if (url == "" || !requested.Add(url)) return;
        var root = assetRoot;
        var version = generation;
        _ = Task.Run(async () =>
        {
            await workers.WaitAsync();
            try
            {
                if (version != Volatile.Read(ref generation)) return;
                var path = Path.Combine(root, Path.GetFileName(url));
                RasterizedSvg image;
                if (path.EndsWith(".svg", StringComparison.OrdinalIgnoreCase)) { using var raster = new SvgRasterizer(); image = raster.Rasterize(path, 64); }
                else image = SvgRasterizer.Decode(await File.ReadAllBytesAsync(path));
                if (version == Volatile.Read(ref generation)) { ready.Enqueue((version, url, image)); wake(); }
            }
            catch (Exception e) { OverlayDiagnostics.Log("warn", "marker_asset_failed", e.Message, operation, url); }
            finally { workers.Release(); }
        });
    }
    private static uint Color(string hex, float opacity = 1)
    {
        if (!uint.TryParse(hex.TrimStart('#'), System.Globalization.NumberStyles.HexNumber, null, out var rgb)) rgb = 0xc4d35f;
        return ((uint)(opacity * 255) << 24) | ((rgb & 255) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 255);
    }
    internal void Draw(ImDrawListPtr draw, MapScene scene, TextureCache images, Operation? operation)
    {
        var map = scene.Map!; var categories = map.Categories.ToDictionary(c => c.Id); var hidden = scene.Preference.HiddenCategories.ToHashSet(); var tasks = scene.Preference.SelectedTasks.ToHashSet();
        bool InView(Vector2 p) => p.X >= -100 && p.Y >= -30 && p.X < scene.Width + 100 && p.Y < scene.Height + 30;
        void Icon(string url, Vector2 p, float opacity, string fallback = "")
        {
            if (images.Get(url) is { } texture) draw.AddImage(texture.NativePointer, p - new Vector2(12), p + new Vector2(12), Vector2.Zero, Vector2.One, Color("ffffff", opacity));
            else { Load(url, operation); if (fallback != "") draw.AddText(p, Color("ffffff", opacity), fallback); else draw.AddCircleFilled(p, 4, Color("c4d35f", opacity)); }
        }
        foreach (var m in map.Markers)
        {
            if (m.CategoryIds.All(hidden.Contains) || (m.TaskId != "" && scene.Preference.TaskFilterActive && !tasks.Contains(m.TaskId))) continue;
            var p = scene.Screen(m.Position); if (!InView(p)) continue;
            var active = m.FloorIds.Length == 0 || m.FloorIds.Contains(scene.Floor); var category = categories[m.CategoryId];
            if (category.Symbol == "label")
            {
                if (!active) continue;
                var size = (float)(20 * (m.LabelSize > 0 ? m.LabelSize / 100 : 1));
                var dimensions = ImGui.CalcTextSize(m.Name) * (size / ImGui.GetFontSize());
                var pos = p - dimensions / 2; var first = draw.VtxBuffer.Size;
                draw.AddText(ImGui.GetFont(), size, pos + Vector2.One, 0xff000000, m.Name);
                draw.AddText(ImGui.GetFont(), size, pos, Color("c7c5b3"), m.Name);
                var angle = (float)(m.LabelRotation * Math.PI / 180);
                for (var i = first; i < draw.VtxBuffer.Size; i++) {
                    var vertex = draw.VtxBuffer[i]; var offset = vertex.pos - p;
                    vertex.pos = p + new Vector2(offset.X * MathF.Cos(angle) - offset.Y * MathF.Sin(angle), offset.X * MathF.Sin(angle) + offset.Y * MathF.Cos(angle));
                }
                continue;
            }
            Icon(m.IconUrl != "" ? m.IconUrl : category.IconUrl, p, active ? 1 : 0.2f);
            if (category.Symbol is "exit" or "btr") draw.AddText(p + new Vector2(14, -8), Color(category.Color, active ? 1 : 0.2f), m.Name);
        }
        if (scene.Preference.ShowAnnotations) foreach (var a in scene.Annotations.Where(a => a.FloorId == scene.Floor))
        {
            if (a.Kind == "stroke") { for (int i = 1; i < a.Points.Length; i++) draw.AddLine(scene.Screen(a.Points[i - 1]), scene.Screen(a.Points[i]), Color(a.Color), (float)a.Width); continue; }
            if (a.Points.Length == 0) continue; var p = scene.Screen(a.Points[0]); if (!InView(p)) continue;
            if (a.ImageId != "") Icon(stickerUrls.GetValueOrDefault(a.ImageId, ""), p, 1, "?");
            else if (a.Emoji != "") draw.AddText(p, Color(a.Color), a.Emoji);
            else draw.AddCircleFilled(p, 6, Color(a.Color));
            if (a.Text != "") draw.AddText(p + new Vector2(10, 0), Color(a.Color), a.Text);
        }
        foreach (var player in scene.Players.Values.Where(p => p.MapId == map.Id))
        {
            var p = scene.Screen(player.Position); if (!InView(p)) continue;
            var angle = (float)(player.Heading * Math.PI / 180); var d = new Vector2(MathF.Sin(angle), -MathF.Cos(angle)); var side = new Vector2(-d.Y, d.X);
            draw.AddTriangleFilled(p + d * 13, p - d * 8 + side * 8, p - d * 8 - side * 8, Color(player.IsSelf ? "5fd3c4" : "ffffff", player.FloorId == scene.Floor ? 1 : 0.35f));
        }
    }
}
