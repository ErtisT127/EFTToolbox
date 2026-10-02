using OpenCvSharp;
using PaddleOCRSharp;
using EFTToolbox.Contracts;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace EFTToolbox.Overlay;

/// <summary>One text block the OCR is confident about, in the coordinates of the (possibly
/// enlarged) capture the icon check runs on.</summary>
internal sealed record OcrBlock(string Text, float Score, double X, double Y, double Width, double Height);

internal sealed class RecognitionEngine : IDisposable
{
    private readonly record struct WarmupProfile(bool Enabled, int Width, int Height, int Upscale);
    private PaddleOCREngine? ocr;
    private readonly object warmupGate = new();
    private CancellationTokenSource? warmupStop;
    private Task? warmupTask;
    private WarmupProfile? warmupProfile;
    private static readonly object NativeConsoleLock = new();
    private const int StdOutputHandle = -11, StdErrorHandle = -12, GenericWrite = 0x40000000, OpenExisting = 3;
    private static readonly nint InvalidHandle = new(-1);

    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetStdHandle(int handle, nint value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateFile(string name, int access, int share, nint security, int creation, int flags, nint template);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);

    internal void ConfigureWarmup(RecognitionSettings settings)
    {
        lock (warmupGate)
        {
            var profile = new WarmupProfile(
                settings.OcrWarmup,
                settings.CaptureWidth,
                settings.CaptureHeight,
                Math.Clamp(settings.OcrUpscale, 1, 3));
            if (warmupProfile == profile) return;
            warmupProfile = profile;
            var previousTask = warmupTask;
            var previousStop = warmupStop;
            previousStop?.Cancel();
            if (previousStop is not null)
            {
                _ = DisposeAfter(previousTask, previousStop);
            }
            if (!settings.OcrWarmup)
            {
                warmupStop = null;
                return;
            }
            warmupStop = new CancellationTokenSource();
            var token = warmupStop.Token;
            warmupTask = Task.Run(() => WarmupAfter(previousTask, token, settings), token);
        }
    }

    private static async Task DisposeAfter(Task? task, CancellationTokenSource stop)
    {
        try { if (task is not null) await task.ConfigureAwait(false); }
        catch (OperationCanceledException) { }
        finally { stop.Dispose(); }
    }

    private async Task WarmupAfter(Task? previousTask, CancellationToken token, RecognitionSettings settings)
    {
        if (previousTask is not null)
        {
            try { await previousTask.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }
        token.ThrowIfCancellationRequested();
        Warmup(token, settings);
    }

    private void Warmup(CancellationToken token, RecognitionSettings settings)
    {
        var elapsed = Stopwatch.StartNew();
        var upscale = Math.Clamp(settings.OcrUpscale, 1, 3);
        OverlayDiagnostics.Log("info", "ocr_warmup_started",
            $"width={settings.CaptureWidth} height={settings.CaptureHeight} upscale={upscale}");
        try
        {
            token.ThrowIfCancellationRequested();
            using var source = new Mat(settings.CaptureHeight, settings.CaptureWidth, MatType.CV_8UC3, Scalar.Black);
            using var image = new Mat();
            if (upscale > 1) Cv2.Resize(source, image, new Size(source.Width * upscale, source.Height * upscale), 0, 0, InterpolationFlags.Cubic);
            else source.CopyTo(image);
            Cv2.ImEncode(".png", image, out var encoded);
            token.ThrowIfCancellationRequested();
            _ = Detect(encoded, warmup: true);
            OverlayDiagnostics.Log("info", "ocr_warmup_completed", $"elapsedMs={elapsed.ElapsedMilliseconds}");
        }
        catch (OperationCanceledException)
        {
            OverlayDiagnostics.Log("info", "ocr_warmup_cancelled", $"elapsedMs={elapsed.ElapsedMilliseconds}");
        }
        catch (Exception exception)
        {
            OverlayDiagnostics.Log("warn", "ocr_warmup_failed", $"elapsedMs={elapsed.ElapsedMilliseconds} error={exception.Message}");
        }
    }

    /// <summary>Decodes a capture, enlarges it for the OCR and returns every text block above the
    /// confidence bar. The caller owns <paramref name="image"/>, the picture the icon check measures
    /// against, and disposes it when the run ends.</summary>
    internal IReadOnlyList<OcrBlock> Scan(byte[] imageBytes, RecognitionSettings settings, CancellationToken token, out Mat? image, out string error)
    {
        var elapsed = Stopwatch.StartNew();
        image = null;
        try
        {
            using var decoded = Cv2.ImDecode(imageBytes, ImreadModes.Color);
            if (decoded.Empty()) { error = "image_invalid"; return []; }
            var upscale = Math.Clamp(settings.OcrUpscale, 1, 3);
            var capture = new Mat();
            if (upscale > 1) Cv2.Resize(decoded, capture, new Size(decoded.Width * upscale, decoded.Height * upscale), 0, 0, InterpolationFlags.Cubic);
            else decoded.CopyTo(capture);
            if (token.IsCancellationRequested) { capture.Dispose(); error = "cancelled"; return []; }
            // One input path for the engine: the enlarged image travels back through an encoder.
            Cv2.ImEncode(".png", capture, out var encoded);
            var result = Detect(encoded, warmup: false);
            var uniqueBlocks = new Dictionary<string, OcrBlock>(StringComparer.Ordinal);
            foreach (var block in result?.TextBlocks ?? [])
            {
                if (block.Score < settings.OcrConfidence) continue;
                var text = block.Text.Trim();
                var points = block.BoxPoints;
                if (text.Length == 0 || points is null || points.Count == 0) continue;
                var minX = points.Min(point => (double)point.X);
                var minY = points.Min(point => (double)point.Y);
                var maxX = points.Max(point => (double)point.X);
                var maxY = points.Max(point => (double)point.Y);
                var value = new OcrBlock(text, block.Score, minX, minY, Math.Max(1, maxX - minX), Math.Max(1, maxY - minY));
                var key = string.Concat(text.Where(char.IsLetterOrDigit)).ToUpperInvariant();
                if (!uniqueBlocks.TryGetValue(key, out var previous) || value.Score > previous.Score)
                    uniqueBlocks[key] = value;
            }
            var blocks = uniqueBlocks.Values.ToList();
            image = capture;
            error = blocks.Count == 0 ? "ocr_empty" : "";
            OverlayDiagnostics.Log("info", "ocr_scan_completed",
                $"width={capture.Width} height={capture.Height} upscale={upscale} blocks={blocks.Count} elapsedMs={elapsed.ElapsedMilliseconds}");
            return blocks;
        }
        catch (Exception exception)
        {
            image?.Dispose();
            image = null;
            // The dashboard translates stable short codes; the exception text itself only goes to
            // the log file.
            OverlayDiagnostics.Log("warn", "ocr_failed", exception.Message);
            error = "ocr_failed";
            return [];
        }
    }

    private OCRResult? Detect(byte[] bytes, bool warmup)
    {
        // The engine writes to the process console, which an overlay has no use for; hiding it keeps
        // the launcher's terminal clean without dropping the text itself.
        var waiting = Stopwatch.StartNew();
        lock (NativeConsoleLock)
        {
            var lockWait = waiting.ElapsedMilliseconds;
            var output = GetStdHandle(StdOutputHandle);
            var error = GetStdHandle(StdErrorHandle);
            var nul = CreateFile("NUL", GenericWrite, 3, 0, OpenExisting, 0, 0);
            try
            {
                if (nul != InvalidHandle)
                {
                    Console.Out.Flush(); Console.Error.Flush();
                    SetStdHandle(StdOutputHandle, nul); SetStdHandle(StdErrorHandle, nul);
                }
                var initialization = Stopwatch.StartNew();
                var initialized = ocr is null;
                ocr ??= new PaddleOCREngine();
                var initializeMs = initialized ? initialization.ElapsedMilliseconds : 0;
                var detection = Stopwatch.StartNew();
                var result = ocr.DetectText(bytes);
                OverlayDiagnostics.Log("info", "ocr_detect_timing",
                    $"warmup={warmup} lockWaitMs={lockWait} engineInitMs={initializeMs} detectMs={detection.ElapsedMilliseconds} bytes={bytes.Length}");
                return result;
            }
            finally
            {
                if (nul != InvalidHandle)
                {
                    SetStdHandle(StdOutputHandle, output); SetStdHandle(StdErrorHandle, error); CloseHandle(nul);
                }
            }
        }
    }

    /// <summary>
    /// The best correlation between one item's artwork and the cell above an OCR label. The game's
    /// grid puts the icon directly above the label, so the label gives both the position and the
    /// size to try: the artwork is scaled across the configured fraction of the label's width and
    /// matched with its own alpha as the mask.
    /// </summary>
    internal double MatchIcon(Mat image, OcrBlock block, byte[] iconBytes, RecognitionSettings settings, CancellationToken token)
    {
        if (image.Empty()) return 0;
        using var icon = Cv2.ImDecode(iconBytes, ImreadModes.Unchanged);
        if (icon.Empty()) return 0;
        using var artwork = new Mat();
        using var mask = new Mat();
        if (icon.Channels() == 4)
        {
            Cv2.CvtColor(icon, artwork, ColorConversionCodes.BGRA2BGR);
            Cv2.ExtractChannel(icon, mask, 3);
        }
        else if (icon.Channels() == 3) icon.CopyTo(artwork);
        else Cv2.CvtColor(icon, artwork, ColorConversionCodes.GRAY2BGR);
        var hasMask = !mask.Empty();
        var ratio = Math.Clamp(settings.IconWindowRatio, 0.8, 2.0);
        var minScale = Math.Clamp(settings.TemplateMinScale, 0.4, 1.6);
        var maxScale = Math.Max(minScale, Math.Clamp(settings.TemplateMaxScale, 0.8, 2.4));
        var windowSide = Math.Max(24, block.Width * ratio);
        var centerX = block.X + block.Width / 2;
        var centerY = block.Y - windowSide * 0.35;
        var left = (int)Math.Clamp(centerX - windowSide / 2, 0, Math.Max(0, image.Width - windowSide));
        var top = (int)Math.Clamp(centerY - windowSide / 2, 0, Math.Max(0, image.Height - windowSide));
        var width = (int)Math.Min(windowSide, image.Width - left);
        var height = (int)Math.Min(windowSide, image.Height - top);
        if (width < 12 || height < 12) return 0;
        using var window = new Mat(image, new Rect(left, top, width, height));
        var best = 0.0;
        const int Steps = 6;
        for (var step = 0; step <= Steps; step++)
        {
            if (token.IsCancellationRequested) break;
            var scale = minScale + (maxScale - minScale) * step / Steps;
            var target = block.Width * scale;
            var factor = target / Math.Max(artwork.Width, artwork.Height);
            var templateWidth = Math.Max(6, (int)Math.Round(artwork.Width * factor));
            var templateHeight = Math.Max(6, (int)Math.Round(artwork.Height * factor));
            if (templateWidth >= width || templateHeight >= height) continue;
            using var template = new Mat();
            Cv2.Resize(artwork, template, new Size(templateWidth, templateHeight), 0, 0, InterpolationFlags.Linear);
            using var result = new Mat();
            if (hasMask)
            {
                using var scaledMask = new Mat();
                Cv2.Resize(mask, scaledMask, new Size(templateWidth, templateHeight), 0, 0, InterpolationFlags.Nearest);
                // Squared difference is the one normalized mode OpenCV masks, and unlike the
                // correlation modes it does not reward an empty patch: a flat background differs from
                // the artwork everywhere the mask is set.
                Cv2.MatchTemplate(window, template, result, TemplateMatchModes.SqDiffNormed, scaledMask);
                Cv2.MinMaxLoc(result, out double minimum, out double _);
                if (!double.IsNaN(minimum) && 1 - minimum > best) best = 1 - minimum;
            }
            else
            {
                Cv2.MatchTemplate(window, template, result, TemplateMatchModes.CCoeffNormed);
                Cv2.MinMaxLoc(result, out double _, out double maximum);
                if (!double.IsNaN(maximum) && maximum > best) best = maximum;
            }
        }
        return Math.Clamp(best, 0, 1);
    }

    public void Dispose()
    {
        CancellationTokenSource? stop;
        Task? task;
        lock (warmupGate)
        {
            stop = warmupStop;
            stop?.Cancel();
            task = warmupTask;
            warmupStop = null;
            warmupTask = null;
        }
        try { task?.GetAwaiter().GetResult(); }
        catch (OperationCanceledException) { }
        stop?.Dispose();
        lock (NativeConsoleLock) ocr?.Dispose();
    }
}
