using System.Runtime.InteropServices;
using System.Text;
using EFTToolbox.Contracts;
using SkiaSharp;

namespace EFTToolbox.Overlay;

/// <summary><paramref name="Halo"/> is the map label treatment: a blurred dark copy under the glyphs
/// so they stay readable over artwork. Text on a flat panel turns it off, which is also what keeps it
/// crisp instead of softly smeared.</summary>
/// <summary><paramref name="LeftAlign"/> keeps wrapped lines on the same left edge; map labels centre
/// their lines because they are anchored by their middle.</summary>
internal sealed record MapText(string Text, string Role, float Size, float Width, string Color, float Dpi, int MaxLines = 0, bool Halo = true, bool LeftAlign = false);

// Owned by the marker workers; typefaces and layout never touch the render thread.
internal sealed class MapTextRasterizer : IDisposable
{
    private readonly Dictionary<string, (DateTime Stamp, SKTypeface Face)> faces = new();
    internal RasterizedSvg Rasterize(string root, MapText request)
    {
        lock (faces)
        {
            SKTypeface Face(string name)
            {
                var path = Path.Combine(root, "display", "fonts", name + ".ttf");
                var stamp = File.GetLastWriteTimeUtc(path);
                if (!faces.TryGetValue(path, out var cached) || cached.Stamp != stamp) {
                    var face = SKTypeface.FromFile(path) ?? throw new InvalidDataException($"Missing map font: {name}");
                    cached.Face?.Dispose(); faces[path] = cached = (stamp, face);
                }
                return cached.Face;
            }
            // Prices read as numbers, so they take the monospaced face the dashboard's tables use;
            // everything else keeps the condensed face the map is drawn with.
            var bold = request.Role is not ("annotation" or "price");
            var latinFace = request.Role switch
            {
                "named" => MapDisplay.NamedFont,
                "price" => MapDisplay.MonoFont,
                "annotation" => MapDisplay.AnnotationFont,
                _ => MapDisplay.LandmarkFont,
            };
            using var latin = new SKPaint { Typeface = Face(latinFace), TextSize = request.Size * request.Dpi, IsAntialias = true, Color = SKColor.Parse(request.Color) };
            using var cjk = new SKPaint { Typeface = Face(bold ? MapDisplay.CjkBoldFont : MapDisplay.CjkRegularFont), TextSize = latin.TextSize, IsAntialias = true, Color = latin.Color };
            using var latinFont = new SKFont(latin.Typeface, latin.TextSize);
            IEnumerable<(string Text, SKPaint Paint)> Runs(string text)
            {
                var buffer = new StringBuilder(); SKPaint? previous = null;
                foreach (var rune in text.EnumerateRunes())
                {
                    var paint = latinFont.ContainsGlyph(rune.Value) ? latin : cjk;
                    if (previous is not null && previous != paint) { yield return (buffer.ToString(), previous); buffer.Clear(); }
                    buffer.Append(rune); previous = paint;
                }
                if (previous is not null) yield return (buffer.ToString(), previous);
            }
            float Measure(string text) => Runs(text).Sum(run => run.Paint.MeasureText(run.Text));
            var lines = new List<string>();
            foreach (var paragraph in request.Text.Replace("\r", "").Split('\n'))
            {
                if (request.Width <= 0) { lines.Add(paragraph); continue; }
                var line = "";
                foreach (var rune in paragraph.EnumerateRunes())
                {
                    var next = line + rune;
                    if (line.Length > 0 && Measure(next) > request.Width * request.Dpi)
                    {
                        var space = line.LastIndexOf(' ');
                        if (space > 0) { lines.Add(line[..space]); line = line[(space + 1)..] + rune; }
                        else { lines.Add(line); line = rune.ToString(); }
                    }
                    else line = next;
                }
                lines.Add(line);
            }
            // A caller that only has room for a few lines gets them, with the last one ellipsized
            // rather than clipped mid-glyph.
            if (request.MaxLines > 0 && lines.Count > request.MaxLines)
            {
                lines = lines.Take(request.MaxLines).ToList();
                var limit = request.Width > 0 ? request.Width * request.Dpi : float.MaxValue;
                var last = lines[^1];
                while (last.Length > 1 && Measure(last + "…") > limit) last = last[..^1];
                lines[^1] = last + "…";
            }
            var pad = request.Halo ? 4 * request.Dpi : 1.5f * request.Dpi;
            var lineHeight = latin.TextSize * (bold ? MapDisplay.LabelLineHeight : MapDisplay.AnnotationLineHeight);
            var width = Math.Max(1, (int)Math.Ceiling(lines.Max(Measure) + 2 * pad));
            var height = Math.Max(1, (int)Math.Ceiling(lines.Count * lineHeight + 2 * pad));
            // Long unwrapped annotations keep their layout while fitting DX11's texture limits.
            var sampling = Math.Min(1, Math.Min(Math.Min(8192.0 / width, 8192.0 / height), Math.Sqrt((32L << 20) / ((double)width * height * 4))));
            using var bitmap = new SKBitmap(new SKImageInfo(Math.Max(1, (int)(width * sampling)), Math.Max(1, (int)(height * sampling)), SKColorType.Bgra8888, SKAlphaType.Premul));
            using var canvas = new SKCanvas(bitmap);
            canvas.Clear(SKColors.Transparent);
            canvas.Scale((float)sampling);
            var metrics = latin.FontMetrics;
            for (var i = 0; i < lines.Count; i++)
            {
                var x = request.LeftAlign ? pad : (width - Measure(lines[i])) / 2;
                var y = pad + i * lineHeight + (lineHeight - metrics.Ascent - metrics.Descent) / 2;
                foreach (var run in Runs(lines[i]))
                {
                    if (request.Halo)
                    {
                        using var shadow = run.Paint.Clone();
                        shadow.Color = SKColor.Parse(MapDisplay.Background);
                        shadow.MaskFilter = SKMaskFilter.CreateBlur(SKBlurStyle.Normal, 1.2f * request.Dpi);
                        canvas.DrawText(run.Text, x, y + request.Dpi, shadow);
                        if (bold)
                        {
                            using var stroke = run.Paint.Clone(); stroke.Color = shadow.Color; stroke.Style = SKPaintStyle.Stroke; stroke.StrokeWidth = MapDisplay.TextStroke * request.Dpi;
                            canvas.DrawText(run.Text, x, y, stroke);
                        }
                    }
                    canvas.DrawText(run.Text, x, y, run.Paint); x += run.Paint.MeasureText(run.Text);
                }
            }
            canvas.Flush();
            var bytes = new byte[bitmap.ByteCount]; Marshal.Copy(bitmap.GetPixels(), bytes, 0, bytes.Length);
            return new(bytes, bitmap.Width, bitmap.Height, bitmap.RowBytes, 0, 0) { DisplaySize = new(width, height) };
        }
    }
    public void Dispose() { lock (faces) { foreach (var face in faces.Values) face.Face.Dispose(); faces.Clear(); } }
}
