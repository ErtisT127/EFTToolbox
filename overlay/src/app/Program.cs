using System.Runtime.InteropServices;

namespace EFTToolbox.Overlay;

internal static class Program
{
    private static bool closing;
    private static OverlayApplication? application;
    private static readonly Native.WindowProc Procedure = WndProc;
    private static nint WndProc(nint hwnd, uint message, nuint wParam, nint lParam)
    {
        if (message is Native.WmClose or Native.WmDestroy) { closing = true; return 0; }
        if (application?.Message(message, wParam, lParam) is { } result) return result;
        if (message == Native.WmMouseActivate) return 3;
        return Native.DefWindowProc(hwnd, message, wParam, lParam);
    }
    private static int Main(string[] args)
    {
        if (args.Contains("--tile-self-check")) { TileRuntimeSelfCheck.Run().GetAwaiter().GetResult(); return 0; }
        if (args.Contains("--tile-preview")) { BruTilePreview.Run(Directory.GetCurrentDirectory()).GetAwaiter().GetResult(); return 0; }
        if (args.Contains("--svg-benchmark")) { var i = Array.IndexOf(args, "--resolution"); SvgRuntimeBenchmark.Run(Directory.GetCurrentDirectory(), i >= 0 ? int.Parse(args[i + 1]) : 2048); return 0; }
        var index = Array.IndexOf(args, "--backend");
        if (index < 0 || index + 1 >= args.Length || !Uri.TryCreate(args[index + 1], UriKind.Absolute, out var backendUri) || backendUri.Scheme is not ("http" or "https"))
        {
            Console.Error.WriteLine("Missing or invalid --backend URL.");
            return 1;
        }
        var backend = backendUri.ToString();
        nint hwnd = 0; ushort registered = 0; var instance = Native.GetModuleHandle(null);
        using var stop = new CancellationTokenSource();
        ConsoleCancelEventHandler cancel = (_, e) => { e.Cancel = true; stop.Cancel(); }; Console.CancelKeyPress += cancel;
        try
        {
            Native.Check(Native.SetProcessDpiAwarenessContext(-4));
            var wc = new Native.WindowClass { Size = (uint)Marshal.SizeOf<Native.WindowClass>(), Proc = Procedure, Instance = instance, Name = "EFTToolbox.Overlay.Native" };
            registered = Native.RegisterClassEx(ref wc); Native.Check(registered != 0);
            hwnd = Native.CreateWindowEx(Native.ExStyle, wc.Name, "EFTToolbox Overlay", 0x80000000, 24, 24, 384, 384, 0, 0, instance, 0); Native.Check(hwnd != 0);
            Native.Check(Native.SetLayeredWindowAttributes(hwnd, 0, 255, 2));
            using var app = new OverlayApplication(hwnd, new Uri(backend)); application = app;
            var inputClosed = args.Contains("--dev-stdin") ? WatchInputAsync() : null;
            OverlayDiagnostics.Log("info", "started", "Native overlay ready");
            while (!closing && !stop.IsCancellationRequested && !(inputClosed?.IsCompleted ?? false))
            {
                while (Native.PeekMessage(out var message, 0, 0, 0, 1)) { Native.TranslateMessage(ref message); Native.DispatchMessage(ref message); }
                if (closing) break; app.Tick(); Native.MsgWaitForMultipleObjectsEx(0, 0, app.WaitMilliseconds, 0x04FF, 0x0004);
            }
            application = null; return 0;
        }
        catch (Exception error) { Console.Error.WriteLine($"Overlay failed: {error}"); return 1; }
        finally { Console.CancelKeyPress -= cancel; if (hwnd != 0) Native.DestroyWindow(hwnd); if (registered != 0) Native.UnregisterClass("EFTToolbox.Overlay.Native", instance); }
    }
    private static async Task WatchInputAsync() { using var input = Console.OpenStandardInput(); await input.CopyToAsync(Stream.Null).ConfigureAwait(false); }
}
