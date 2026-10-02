using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using EFTToolbox.Contracts;
using ExCSS;
using SkiaSharp;
using Svg.Skia;
using System.Numerics;

namespace EFTToolbox.Overlay;

internal sealed record RasterizedSvg(byte[] Pixels, int Width, int Height, int Stride, double ParseMs, double RasterMs) { internal double ReadMs { get; init; } internal Vector2 DisplaySize { get; init; } }
internal sealed record SvgRegion(float X, float Y, float Width, float Height, int PixelWidth, int PixelHeight)
{
    internal bool Contains(MapScene scene) {
        var a = scene.MapPoint(Vector2.Zero); var b = scene.MapPoint(new(scene.Width, scene.Height));
        return a.X >= X && a.Y >= Y && b.X <= X + Width && b.Y <= Y + Height;
    }
    internal static SvgRegion Around(MapScene scene) {
        var a = scene.MapPoint(new(-scene.Width * 0.25f, -scene.Height * 0.25f));
        var size = new Vector2(scene.Width * 1.5f, scene.Height * 1.5f) / scene.Scale;
        return new(a.X, a.Y, size.X, size.Y, (int)Math.Ceiling(scene.Width * 1.5f * scene.Dpi), (int)Math.Ceiling(scene.Height * 1.5f * scene.Dpi));
    }
}

internal sealed class SvgRasterizer : IDisposable
{
    private SKSvg? svg;
    private string key = "";
    internal int ParseCount { get; private set; }
    internal int RasterCount { get; private set; }
    // One scene worker owns this instance; no render-thread callers.
    internal RasterizedSvg Rasterize(string path, int resolution, MapData? map = null, string floor = "", bool tiles = false, SvgRegion? region = null)
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
            InlineStyles(doc);
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
        var width = region?.PixelWidth ?? Math.Max(1, (int)Math.Round(bounds.Width * scale)); var height = region?.PixelHeight ?? Math.Max(1, (int)Math.Round(bounds.Height * scale));
        // Adaptive scenes stay within 64 MiB; fixed 8192 needs up to 256 MiB per texture.
        var sampling = Math.Min(1, Math.Min(8192.0 / Math.Max(width, height), Math.Sqrt(((region is null ? 256L : 64L) << 20) / ((double)width * height * 4))));
        width = Math.Max(1, (int)(width * sampling)); height = Math.Max(1, (int)(height * sampling));
        scale *= (float)sampling;
        using var bitmap = new SKBitmap(new SKImageInfo(width, height, SKColorType.Bgra8888, SKAlphaType.Premul));
        using (var canvas = new SKCanvas(bitmap))
        {
            canvas.Clear(SKColors.Transparent);
            if (region is not null && map is not null) {
                var b = map.Projection.ViewBox;
                canvas.Scale(width / region.Width * (float)b[2] / bounds.Width, height / region.Height * (float)b[3] / bounds.Height);
                canvas.Translate(-bounds.Left - (region.X - (float)b[0]) * bounds.Width / (float)b[2], -bounds.Top - (region.Y - (float)b[1]) * bounds.Height / (float)b[3]);
            } else { canvas.Scale(scale); canvas.Translate(-bounds.Left, -bounds.Top); }
            canvas.DrawPicture(picture);
            canvas.Flush();
        }
        var bytes = new byte[bitmap.ByteCount]; Marshal.Copy(bitmap.GetPixels(), bytes, 0, bytes.Length); RasterCount++;
        return new(bytes, width, height, bitmap.RowBytes, parse.Elapsed.TotalMilliseconds, timer.Elapsed.TotalMilliseconds) { ReadMs = read.Elapsed.TotalMilliseconds };
    }
    // The upstream maps carry their palette in an internal stylesheet (.cement, .building, .stairs,
    // .danger…) — a browser applies it, Svg.Skia does not, so those groups would rasterize unstyled
    // and the map loses its colours. The floor layering lives there too: every floor above the
    // ground is class="shadow", a CSS drop-shadow, and without it one floor stops reading as lying
    // over the one below. Copy each class rule onto the elements that use it: a presentation
    // attribute loses to any stylesheet rule, so this cannot override anything a renderer does
    // apply on its own.
    private static void InlineStyles(XDocument doc)
    {
        var rules = new List<(string Name, List<(string Property, string Value)> Declarations)>();
        var parser = new StylesheetParser(
            includeUnknownRules: true,
            includeUnknownDeclarations: true,
            tolerateInvalidSelectors: true,
            tolerateInvalidValues: true,
            tolerateInvalidConstraints: true,
            preserveComments: false,
            preserveDuplicateProperties: true);
        foreach (var style in doc.Descendants().Where(e => e.Name.LocalName == "style").ToArray())
        {
            var stylesheet = parser.Parse(style.Value);
            foreach (var rule in stylesheet.StyleRules)
            {
                if (rule.Selector is not ClassSelector selector) continue;
                var declarations = rule.Style.Declarations
                    .Select(declaration => (declaration.Name, declaration.Original))
                    .ToList();
                if (declarations.Count > 0) rules.Add((selector.Class, declarations));
            }
            style.Remove();
        }
        if (rules.Count == 0) return;
        var ns = doc.Root!.Name.Namespace;
        var filters = new Dictionary<string, string>();
        foreach (var value in rules.SelectMany(rule => rule.Declarations).Where(d => d.Property == "filter").Select(d => d.Value).Distinct())
        {
            var shadow = Regex.Match(value, @"^drop-shadow\(\s*([\d.-]+)(?:px)?\s+([\d.-]+)(?:px)?\s+([\d.]+)px\s+(#[0-9a-fA-F]+)\s*\)$");
            if (!shadow.Success) continue;
            var id = $"overlay-shadow-{filters.Count}"; filters[value] = $"url(#{id})";
            doc.Root.AddFirst(new XElement(ns + "defs", new XElement(ns + "filter", new XAttribute("id", id), new XAttribute("x", "-50%"), new XAttribute("y", "-50%"), new XAttribute("width", "200%"), new XAttribute("height", "200%"),
                new XElement(ns + "feGaussianBlur", new XAttribute("in", "SourceAlpha"), new XAttribute("stdDeviation", shadow.Groups[3].Value)),
                new XElement(ns + "feOffset", new XAttribute("dx", shadow.Groups[1].Value), new XAttribute("dy", shadow.Groups[2].Value), new XAttribute("result", "offset")),
                new XElement(ns + "feFlood", new XAttribute("flood-color", shadow.Groups[4].Value)),
                new XElement(ns + "feComposite", new XAttribute("in2", "offset"), new XAttribute("operator", "in")),
                new XElement(ns + "feMerge", new XElement(ns + "feMergeNode"), new XElement(ns + "feMergeNode", new XAttribute("in", "SourceGraphic"))))));
        }
        foreach (var element in doc.Descendants())
        {
            var classes = ((string?)element.Attribute("class") ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries);
            foreach (var rule in rules)
            {
                if (!classes.Contains(rule.Name)) continue;
                foreach (var (property, value) in rule.Declarations)
                {
                    if (property != "filter") element.SetAttributeValue(property, value);
                    else if (filters.TryGetValue(value, out var filter)) element.SetAttributeValue(property, filter);
                }
            }
        }
    }
    internal static RasterizedSvg Artwork(RasterizedSvg source, float box, float dpi, bool crop, bool rim = true)
    {
        using var bitmap = new SKBitmap(new SKImageInfo(source.Width, source.Height, SKColorType.Bgra8888, SKAlphaType.Premul));
        Marshal.Copy(source.Pixels, 0, bitmap.GetPixels(), source.Pixels.Length);
        var bounds = new SKRectI(0, 0, source.Width, source.Height);
        if (crop) {
            int left = source.Width, top = source.Height, right = -1, bottom = -1;
            for (var y = 0; y < source.Height; y++) for (var x = 0; x < source.Width; x++) if (source.Pixels[y * source.Stride + x * 4 + 3] != 0) {
                left = Math.Min(left, x); top = Math.Min(top, y); right = Math.Max(right, x); bottom = Math.Max(bottom, y);
            }
            if (right >= left) bounds = new(left, top, right + 1, bottom + 1);
        }
        var finalSize = Math.Max(1, (int)Math.Round((box + 2 * MapDisplay.IconPad) * dpi));
        dpi *= 2;
        var size = finalSize * 2;
        using var target = new SKBitmap(new SKImageInfo(size, size, SKColorType.Bgra8888, SKAlphaType.Premul));
        using var canvas = new SKCanvas(target); canvas.Clear(SKColors.Transparent);
        var ratio = box * dpi / Math.Max(bounds.Width, bounds.Height);
        var w = bounds.Width * ratio; var h = bounds.Height * ratio;
        using var paint = new SKPaint { IsAntialias = true, FilterQuality = SKFilterQuality.High };
        canvas.DrawBitmap(bitmap, bounds, new SKRect((size - w) / 2, (size - h) / 2, (size + w) / 2, (size + h) / 2), paint);
        if (crop && rim) {
            using var original = SKImage.FromBitmap(target);
            using var white = new SKPaint { ColorFilter = SKColorFilter.CreateBlendMode(SKColors.White, SKBlendMode.SrcIn), FilterQuality = SKFilterQuality.High, IsAntialias = true };
            canvas.Clear(SKColors.Transparent);
            foreach (var (x, y) in new[] { (1, 1), (-1, -1), (-1, 1), (1, -1) })
                canvas.DrawImage(original, x * MapDisplay.RimOffset * dpi, y * MapDisplay.RimOffset * dpi, white);
            canvas.DrawImage(original, 0, 0);
        }
        canvas.Flush();
        using var reduced = new SKBitmap(new SKImageInfo(finalSize, finalSize, SKColorType.Bgra8888, SKAlphaType.Premul));
        using (var output = new SKCanvas(reduced)) { output.Clear(SKColors.Transparent); output.DrawBitmap(target, new SKRect(0, 0, finalSize, finalSize), paint); output.Flush(); }
        var bytes = new byte[reduced.ByteCount]; Marshal.Copy(reduced.GetPixels(), bytes, 0, bytes.Length);
        return new(bytes, finalSize, finalSize, reduced.RowBytes, 0, 0);
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
