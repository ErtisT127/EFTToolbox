using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Xml.Linq;
using EFTToolbox.Contracts;
using SkiaSharp;
using Svg.Skia;

namespace EFTToolbox.Overlay;

internal sealed record RasterizedSvg(byte[] Pixels, int Width, int Height, int Stride, double ParseMs, double RasterMs) { internal double ReadMs { get; init; } }

internal sealed class SvgRasterizer : IDisposable
{
    private SKSvg? svg;
    private string key = "";
    internal int ParseCount { get; private set; }
    internal int RasterCount { get; private set; }
    // One scene worker owns this instance; no render-thread callers.
    internal RasterizedSvg Rasterize(string path, int resolution, MapData? map = null, string floor = "", bool tiles = false)
    {
        var read = Stopwatch.StartNew();
        var source = File.ReadAllBytes(path);
        var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(source));
        read.Stop();
        var next = $"{path}:{digest}:{floor}:{tiles}:{map?.BaseFloor}:{System.Text.Json.JsonSerializer.Serialize(map?.Floors)}";
        var parse = Stopwatch.StartNew();
        if (next != key)
        {
            using var sourceStream = new MemoryStream(source);
            var doc = XDocument.Load(sourceStream);
            if (map is not null)
            {
                var active = map.Floors.First(f => f.Id == floor);
                var baseFloor = map.Floors.First(f => f.Id == map.BaseFloor);
                var groups = new HashSet<string>(map.Floors.SelectMany(f => f.SvgGroups));
                foreach (var child in doc.Root!.Elements().Where(e => e.Name.LocalName == "g").ToArray())
                {
                    var id = (string?)child.Attribute("id") ?? "";
                    var linked = (string?)child.Attribute("data-keep-with-group") ?? "";
                    if (!groups.Contains(id) && linked == "" && id == "") continue;
                    bool Belongs(string[] ids) => ids.Contains(id) || (linked != "" && ids.Contains(linked));
                    var selected = Belongs(active.SvgGroups); var background = !tiles && Belongs(baseFloor.SvgGroups);
                    if (!selected && !background) { child.Remove(); continue; }
                    child.SetAttributeValue("opacity", background && !selected ? "0.2" : "1");
                    if (selected) { child.Remove(); doc.Root.Add(child); }
                }
            }
            SKSvg? candidate = null;
            try {
                candidate = new SKSvg();
                using var input = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(doc.ToString()));
                candidate.Load(input);
                if (candidate.Picture is null) throw new InvalidDataException("SVG picture is empty");
                svg?.Dispose(); svg = candidate; candidate = null;
                key = next; ParseCount++;
            } finally { candidate?.Dispose(); }
        }
        parse.Stop();
        var timer = Stopwatch.StartNew(); var picture = svg!.Picture!; var bounds = picture.CullRect;
        if (bounds.Width <= 0 || bounds.Height <= 0) throw new InvalidDataException("Invalid SVG bounds");
        var scale = resolution / Math.Max(bounds.Width, bounds.Height);
        var width = Math.Max(1, (int)Math.Round(bounds.Width * scale)); var height = Math.Max(1, (int)Math.Round(bounds.Height * scale));
        using var bitmap = new SKBitmap(new SKImageInfo(width, height, SKColorType.Bgra8888, SKAlphaType.Premul));
        using (var canvas = new SKCanvas(bitmap)) { canvas.Clear(SKColors.Transparent); canvas.Scale(scale); canvas.Translate(-bounds.Left, -bounds.Top); canvas.DrawPicture(picture); canvas.Flush(); }
        var bytes = new byte[bitmap.ByteCount]; Marshal.Copy(bitmap.GetPixels(), bytes, 0, bytes.Length); RasterCount++;
        return new(bytes, width, height, bitmap.RowBytes, parse.Elapsed.TotalMilliseconds, timer.Elapsed.TotalMilliseconds) { ReadMs = read.Elapsed.TotalMilliseconds };
    }
    internal static RasterizedSvg Decode(byte[] data)
    {
        using var stream = new SKMemoryStream(data);
        using var codec = SKCodec.Create(stream) ?? throw new InvalidDataException("Invalid image");
        if (codec.Info.Width > 4096 || codec.Info.Height > 4096) throw new InvalidDataException("Image exceeds limit");
        using var bitmap = SKBitmap.Decode(codec) ?? throw new InvalidDataException("Invalid image");
        if (bitmap.Width > 4096 || bitmap.Height > 4096) throw new InvalidDataException("Image exceeds limit");
        using var converted = bitmap.Copy(SKColorType.Bgra8888);
        var bytes = new byte[converted.ByteCount]; Marshal.Copy(converted.GetPixels(), bytes, 0, bytes.Length);
        return new(bytes, converted.Width, converted.Height, converted.RowBytes, 0, 0);
    }
    public void Dispose() => svg?.Dispose();
}
