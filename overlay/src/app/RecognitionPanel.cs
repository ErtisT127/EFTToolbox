using System.Collections.Concurrent;
using System.Numerics;
using OpenCvSharp;

namespace EFTToolbox.Overlay;

/// <summary>
/// Where the recognition panel puts its parts, in the window's own pixels. Everything is derived
/// from logical sizes times the window's DPI, so the boxes grow with the text instead of squeezing
/// it — which is what "the panel does not look right on a scaled display" comes down to. The window
/// and the renderer both measure with these numbers, so hit testing can never drift from the drawing.
/// </summary>
internal sealed record PanelMetrics(float Scale)
{
    internal float Pad => 10 * Scale;
    internal float TitleHeight => 30 * Scale;
    internal float HeaderHeight => 26 * Scale;
    internal float RowHeight => 52 * Scale;
    internal float RowGap => 4 * Scale;
    internal float Thumb => 36 * Scale;
    internal float Avatar => 16 * Scale;
    internal float CloseSize => 18 * Scale;
    internal float NameGap => 8 * Scale;
    internal float ColumnGap => 6 * Scale;
    // The price columns are sized for the monospaced face the numbers use: a ten-million price is
    // twelve glyphs, and every one of them is 0.6em wide where the condensed face was narrower.
    internal float TraderWidth => 144 * Scale;
    internal float FleaWidth => 124 * Scale;
    /// <summary>The price slot keeps one width for every row, so the portraits above each other line
    /// up while the prices read left-aligned inside their own column.</summary>
    internal float PriceSlot => 120 * Scale;
    internal float AvatarGap => 4 * Scale;
    internal float Edge => 8 * Scale;
    internal const int NameLines = 2;
    // Panel text sizes in logical pixels, which the rasterizer scales by the same factor.
    internal const float TitleSize = 16, HeaderSize = 13, NameSize = 15, PriceSize = 16;

    /// <summary>The title strip: its whole width moves the window, except the close corner.</summary>
    internal float TitleBottom => Edge + TitleHeight;

    internal float HeaderTop => TitleBottom + RowGap;

    internal (Vector2 Min, Vector2 Max) CloseButton(float width)
    {
        var center = new Vector2(width - Pad - CloseSize / 2, Edge + TitleHeight / 2);
        return (center - new Vector2(CloseSize / 2), center + new Vector2(CloseSize / 2));
    }

    internal bool InTitle(float y) => y >= Edge && y <= TitleBottom;

    internal (float Top, float Height) RowsArea(float height)
    {
        var top = HeaderTop + HeaderHeight;
        return (top, Math.Max(0, height - top - Pad));
    }

    /// <summary>The scrollbar lives in the panel's right padding strip; that strip is the one place the
    /// resize ring must not reach, or the reader cannot grab it.</summary>
    internal float ScrollbarLeft(float width) => width - Pad - 2 * Scale;

    /// <summary>
    /// The four columns every row and the header share: artwork, name, trader (with its portrait) and
    /// flea. The prices keep their width so a long name wraps instead of squeezing them.
    /// </summary>
    internal (float Image, float Name, float NameWidth, float Trader, float TraderWidth, float Flea, float FleaWidth) Columns(float width)
    {
        var image = Pad;
        var flea = width - Pad - FleaWidth;
        var trader = flea - ColumnGap - TraderWidth;
        var name = image + Thumb + NameGap;
        var nameWidth = Math.Max(60 * Scale, trader - ColumnGap - name);
        return (image, name, nameWidth, trader, TraderWidth, flea, FleaWidth);
    }

    /// <summary>Where the trader portrait starts: the portrait-plus-price unit is centred in its
    /// column, and because the slot has one width for the whole list the portrait keeps the same x on
    /// every row.</summary>
    internal float TraderUnitLeft(float trader, float slot) => trader + (TraderWidth - (Avatar + AvatarGap + slot)) / 2;

    /// <summary>The name's wrap width in the rasterizer's logical units.</summary>
    /// <summary>
    /// The wrap width is snapped to a coarse step: it is part of the text cache key, and a key that
    /// moves with every pixel of a resize would re-rasterize every name on every frame — which is how
    /// names ended up blank while the panel was being resized.
    /// </summary>
    internal float NameWrapWidth(float physical) => Math.Max(32, MathF.Floor(physical / Scale / 16) * 16);

    /// <summary>
    /// The narrowest window that still fits every column with a usable name width. On a scaled display
    /// this is wider than the contract's floor, so the default window grows with the DPI instead of
    /// squeezing the name into an ellipsis.
    /// </summary>
    internal float MinimumWidth() => Pad * 2 + Thumb + NameGap + 120 * Scale + ColumnGap * 2 + TraderWidth + FleaWidth;
}

/// <summary>
/// ImGui colours are 0xAABBGGRR, which is easy to write backwards by hand: every panel colour comes
/// from an ordinary #rrggbb value through here instead.
/// </summary>
internal static class PanelColor
{
    internal static uint Of(uint rgb, uint alpha = 0xff) =>
        (alpha << 24) | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
}

/// <summary>A rasterized string ready to draw; a zero texture means "still being rasterized".</summary>
internal sealed record RecognitionText(nint Texture, Vector2 Size);

internal sealed record RecognitionPanelItem(
    RecognitionText? Image,
    RecognitionText? Avatar,
    RecognitionText Name,
    RecognitionText Trader,
    RecognitionText Flea);

internal sealed record RecognitionPanelView(
    float Scale,
    /// <summary>The width the trader price is allowed, measured from the widest price in the list.</summary>
    float TraderSlot,
    bool Loading,
    float SpinnerPhase,
    RecognitionText Title,
    RecognitionText Message,
    RecognitionText HeaderName,
    RecognitionText HeaderTrader,
    RecognitionText HeaderFlea,
    IReadOnlyList<RecognitionPanelItem> Items,
    float Scroll,
    float ContentHeight);

/// <summary>
/// Rasterizes the panel's text with the bundled Skia fonts (the ImGui atlas has no CJK at all) and
/// downloads item artwork and trader portraits. Both run off the render thread and land in the
/// window's own caches, the same way map labels do; artwork is decoded near the size it is drawn at,
/// which is what keeps the small thumbnails sharp.
/// </summary>
internal sealed class RecognitionPanelAssets(Func<string, CancellationToken, Task<byte[]?>> fetch, Action wake) : IDisposable
{
    private const int ThumbPixels = 96;
    private const int AvatarPixels = 48;
    private readonly MapTextRasterizer rasterizer = new();
    private readonly ConcurrentQueue<(string Key, RasterizedSvg Image, bool Text)> ready = new();
    /// <summary>Keys whose rasterization or download is still running; the texture caches are the
    /// record of what is finished, so this only stops a key being queued twice.</summary>
    private readonly HashSet<string> requested = [];
    private readonly SemaphoreSlim workers = new(4);
    private readonly CancellationTokenSource stop = new();
    private readonly ConcurrentBag<Task> running = new();
    private volatile string assetRoot = "";
    private int generation;

    internal void SetAssets(string root)
    {
        if (assetRoot == root) return;
        assetRoot = root;
        Interlocked.Increment(ref generation);
        lock (requested) requested.Clear();
        ready.Clear();
    }

    internal string TextKey(string text, string role, float size, string color, float dpi, float width = 0, int maxLines = 0) =>
        $"{role}|{size:F1}|{dpi:F2}|{color}|{width:F0}|{maxLines}|{text}";

    internal void RequestText(string text, string role, float size, string color, float dpi, float width = 0, int maxLines = 0)
    {
        var root = assetRoot;
        if (root == "" || string.IsNullOrEmpty(text)) return;
        var key = TextKey(text, role, size, color, dpi, width, maxLines);
        if (!Track(key)) return;
        var version = Volatile.Read(ref generation);
        var task = Task.Run(async () =>
        {
            await workers.WaitAsync(stop.Token);
            try
            {
                if (version != Volatile.Read(ref generation)) return;
                // Panel text has no map label halo (on a flat panel the blur only made it look soft)
                // and wraps against its own left edge, so every line of a name starts together.
                var image = rasterizer.Rasterize(root, new MapText(text, role, size, width, color, dpi, maxLines, Halo: false, LeftAlign: true));
                if (version == Volatile.Read(ref generation)) { ready.Enqueue((key, image, true)); wake(); }
            }
            catch (Exception e)
            {
                if (version == Volatile.Read(ref generation))
                    lock (requested) { requested.Remove(key); }
                OverlayDiagnostics.Log("warn", "recognition_text_failed", e.Message);
            }
            finally { workers.Release(); }
        });
        running.Add(task);
    }

    internal string ImageKey(string url, int pixels) => $"{url}#{pixels}";

    internal void RequestImage(string url, bool avatar, int pixels)
    {
        if (string.IsNullOrEmpty(url)) return;
        var key = ImageKey(url, pixels);
        if (!Track(key)) return;
        var version = Volatile.Read(ref generation);
        var task = Task.Run(async () =>
        {
            await workers.WaitAsync(stop.Token);
            var queued = false;
            try
            {
                if (version != Volatile.Read(ref generation)) return;
                var bytes = await fetch(url, stop.Token);
                if (bytes is null) return;
                var image = Decode(bytes, Math.Max(AvatarPixels, pixels));
                if (image is null) return;
                if (version != Volatile.Read(ref generation)) return;
                ready.Enqueue((key, image, false));
                queued = true;
                wake();
            }
            catch (Exception e)
            {
                OverlayDiagnostics.Log("warn", "recognition_image_failed", $"{url}: {e.Message}");
            }
            finally
            {
                if (!queued && version == Volatile.Read(ref generation))
                    lock (requested) { requested.Remove(key); }
                workers.Release();
            }
        });
        running.Add(task);
    }

    private bool Track(string key)
    {
        lock (requested)
        {
            return requested.Add(key);
        }
    }

    /// <summary>Moves finished work into the window's caches, bounded per frame like the marker layer.</summary>
    internal void Upload(TextureCache texts, TextureCache images)
    {
        var timer = System.Diagnostics.Stopwatch.StartNew();
        while (timer.Elapsed.TotalMilliseconds < 4 && ready.TryDequeue(out var item))
        {
            try
            {
                (item.Text ? texts : images).Put(item.Key, item.Image);
            }
            catch (Exception e) { OverlayDiagnostics.Log("warn", "recognition_upload_failed", e.Message); }
            finally { lock (requested) { requested.Remove(item.Key); } }
        }
        if (!ready.IsEmpty) wake();
    }

    /// <summary>
    /// Item art arrives as BGRA with straight alpha; the overlay shader expects premultiplied. It is
    /// also reduced to roughly twice its drawn size with a box filter first: the GPU's linear filter
    /// alone would alias the fine detail of an icon drawn at forty pixels.
    /// </summary>
    private static RasterizedSvg? Decode(byte[] bytes, int maxSide)
    {
        using var source = Cv2.ImDecode(bytes, ImreadModes.Unchanged);
        if (source.Empty()) return null;
        using var bgra = new Mat();
        if (source.Channels() == 4) source.CopyTo(bgra);
        else if (source.Channels() == 3) Cv2.CvtColor(source, bgra, ColorConversionCodes.BGR2BGRA);
        else Cv2.CvtColor(source, bgra, ColorConversionCodes.GRAY2BGRA);
        using var scaled = new Mat();
        if (Math.Max(bgra.Width, bgra.Height) > maxSide)
        {
            var factor = (double)maxSide / Math.Max(bgra.Width, bgra.Height);
            Cv2.Resize(bgra, scaled, new Size((int)Math.Round(bgra.Width * factor), (int)Math.Round(bgra.Height * factor)), 0, 0, InterpolationFlags.Area);
        }
        else bgra.CopyTo(scaled);
        var stride = (int)scaled.Step();
        var pixels = new byte[stride * scaled.Rows];
        System.Runtime.InteropServices.Marshal.Copy(scaled.Data, pixels, 0, pixels.Length);
        for (var offset = 0; offset + 3 < pixels.Length; offset += 4)
        {
            var alpha = pixels[offset + 3];
            if (alpha == 255) continue;
            pixels[offset] = (byte)(pixels[offset] * alpha / 255);
            pixels[offset + 1] = (byte)(pixels[offset + 1] * alpha / 255);
            pixels[offset + 2] = (byte)(pixels[offset + 2] * alpha / 255);
        }
        return new RasterizedSvg(pixels, scaled.Cols, scaled.Rows, stride, 0, 0);
    }

    public void Dispose()
    {
        stop.Cancel();
        try { Task.WaitAll(running.ToArray(), 1000); } catch (AggregateException) { }
        rasterizer.Dispose();
        workers.Dispose();
        stop.Dispose();
    }
}
