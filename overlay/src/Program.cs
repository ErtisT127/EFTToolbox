using System.Diagnostics;
using System.Runtime.InteropServices;

namespace EFTToolbox.Overlay;

internal static class Program
{
    private static bool closing;
    private static bool resize = true;
    private static bool reposition;
    private static readonly Native.WindowProc Procedure = WndProc;

    private static nint WndProc(nint hwnd, uint message, nuint wParam, nint lParam)
    {
        switch (message)
        {
            case Native.WmClose:
            case Native.WmDestroy:
                closing = true;
                return 0;
            case Native.WmSize:
                resize = true;
                return 0;
            case Native.WmDpiChanged:
            case Native.WmDisplayChange:
                reposition = true;
                return 0;
            case Native.WmNcHitTest:
                return -1; // HTTRANSPARENT supplements WS_EX_LAYERED | WS_EX_TRANSPARENT.
            case Native.WmMouseActivate:
                return 3; // MA_NOACTIVATE
        }
        return Native.DefWindowProc(hwnd, message, wParam, lParam);
    }

    private static void FitPrimaryMonitor(nint hwnd)
    {
        var info = new Native.MonitorInfo { Size = (uint)Marshal.SizeOf<Native.MonitorInfo>() };
        Native.Check(Native.GetMonitorInfo(Native.MonitorFromPoint(0, 1), ref info));
        var bounds = info.Monitor;
        Native.Check(Native.SetWindowPos(hwnd, -1, bounds.Left, bounds.Top,
            bounds.Right - bounds.Left, bounds.Bottom - bounds.Top, 0x0010)); // SWP_NOACTIVATE
        resize = true;
    }

    private static int Main(string[] args)
    {
        if (args.Length > 1 || (args.Length == 1 && args[0] != "--dev-stdin"))
        {
            Console.Error.WriteLine("Usage: overlay.exe [--dev-stdin]");
            return 2;
        }
        nint hwnd = 0;
        ushort registered = 0;
        var instance = Native.GetModuleHandle(null);
        using var stop = new CancellationTokenSource();
        ConsoleCancelEventHandler cancel = (_, e) => { e.Cancel = true; stop.Cancel(); };
        Console.CancelKeyPress += cancel;
        try
        {
            Native.Check(Native.SetProcessDpiAwarenessContext(-4)); // PER_MONITOR_AWARE_V2
            var wc = new Native.WindowClass
            {
                Size = (uint)Marshal.SizeOf<Native.WindowClass>(),
                Proc = Procedure, Instance = instance, Name = "EFTToolbox.Overlay.Spike"
            };
            registered = Native.RegisterClassEx(ref wc);
            Native.Check(registered != 0);
            hwnd = Native.CreateWindowEx(Native.ExStyle, wc.Name, "EFTToolbox M1 Overlay",
                0x80000000, 0, 0, 1, 1, 0, 0, instance, 0); // WS_POPUP
            Native.Check(hwnd != 0);
            // Full global opacity; transparency comes from the composition surface's pixel alpha.
            Native.Check(Native.SetLayeredWindowAttributes(hwnd, 0, 255, 2));
            FitPrimaryMonitor(hwnd);
            using var renderer = new SpikeRenderer();
            renderer.Initialize(hwnd);
            Native.ShowWindow(hwnd, 4); // SW_SHOWNOACTIVATE
            var inputClosed = args.Length == 1 ? WatchInputAsync() : null;
            var clock = Stopwatch.StartNew();
            double nextFrame = 0;
            Console.WriteLine("Overlay ready: primary display, click-through, no activation. Close launcher stdin or Ctrl+C to stop.");
            while (!closing && !stop.IsCancellationRequested && !(inputClosed?.IsCompleted ?? false))
            {
                while (Native.PeekMessage(out var message, 0, 0, 0, 1))
                {
                    Native.TranslateMessage(ref message);
                    Native.DispatchMessage(ref message);
                }
                if (closing) break;
                if (reposition) { reposition = false; FitPrimaryMonitor(hwnd); }
                if (resize)
                {
                    resize = false;
                    Native.Check(Native.GetClientRect(hwnd, out var rect));
                    renderer.Resize(Math.Max(1, rect.Right), Math.Max(1, rect.Bottom));
                    Console.WriteLine($"Surface: {rect.Right}x{rect.Bottom}, DPI={Native.GetDpiForWindow(hwnd)}");
                }
                var now = clock.Elapsed.TotalSeconds;
                if (now < nextFrame)
                {
                    Native.MsgWaitForMultipleObjectsEx(0, 0,
                        (uint)Math.Ceiling((nextFrame - now) * 1000), 0x04FF, 0x0004);
                    continue;
                }
                renderer.Render(Native.GetDpiForWindow(hwnd) / 96f);
                nextFrame = now + 1.0 / 60;
            }
            if (inputClosed is not null && inputClosed.IsCompleted) inputClosed.GetAwaiter().GetResult();
            Console.WriteLine("Overlay stopped.");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"Overlay failed: {error}");
            return 1;
        }
        finally
        {
            Console.CancelKeyPress -= cancel;
            if (hwnd != 0) Native.DestroyWindow(hwnd);
            if (registered != 0) Native.UnregisterClass("EFTToolbox.Overlay.Spike", instance);
        }
    }

    private static async Task WatchInputAsync()
    {
        using var input = Console.OpenStandardInput();
        await input.CopyToAsync(Stream.Null).ConfigureAwait(false);
    }
}
