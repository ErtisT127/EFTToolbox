using System.Numerics;
using System.Runtime.InteropServices;
using EFTToolbox.Contracts;

namespace EFTToolbox.Overlay;

/// <summary>
/// The recognition panel's own top-level window: always clickable (unlike the map overlay, which is
/// click-through outside its edit mode), moved by dragging it, resized from its edges, scrolled with
/// the wheel and closed from the corner. Its geometry is the contract's window fields, so whatever
/// the reader drags lands in the same settings the dashboard shows.
///
/// The panel's chrome strings come from the generated contract messages, whose language follows the user settings.
/// </summary>
internal sealed class RecognitionWindow : IDisposable
{
    // Eight logical pixels of border are enough to grab a window this size without stealing clicks
    // from the title strip.
    private const float ResizeRing = 8;
    /// <summary>Drag mode for the scrollbar, which moves the list instead of the window.</summary>
    private const int ScrollDrag = 10;
    /// <summary>Expands the code the pipeline reports into the sentence the panel shows; the
    /// dashboard's errors.* copy carries the wording, and a code it does not know still gets the
    /// generic failure instead of its raw name.</summary>
    private static string RecognitionError(string code) =>
        Messages.Has($"errors.recognition_{code}") ? Messages.Get($"errors.recognition_{code}") : Messages.Get("recognition.panel.failed");
    private readonly nint hwnd;
    private readonly OverlayRenderer renderer = new();
    private readonly RecognitionPanelAssets assets;
    private readonly Func<RecognitionSettings, Task> save;
    private RecognitionSettings settings = DefaultsValues.Recognition;
    private RecognitionResult? result;
    private bool loading;
    private bool placed;
    private bool visible;
    private bool initialized;
    private long expires;
    private float scroll;
    private int drag;
    private Native.CursorPoint dragStart;
    private Native.Rect dragBounds;
    private int saveQueued;
    private int saveDirty;

    internal RecognitionWindow(nint hwnd, Func<string, CancellationToken, Task<byte[]?>> fetch, Func<RecognitionSettings, Task> save, Action wake)
    {
        this.hwnd = hwnd;
        this.save = save;
        assets = new RecognitionPanelAssets(fetch, wake);
    }

    internal void Initialize(string? assetDirectory)
    {
        if (initialized) return;
        initialized = true;
        renderer.Initialize(hwnd);
        SetAssets(assetDirectory);
        // The swap chain has to exist before the first frame, even while the window is hidden.
        ApplyWindow();
    }

    internal bool Visible => visible;

    internal bool Loading => loading;
    internal bool HasPendingSave => Volatile.Read(ref saveDirty) != 0 || Volatile.Read(ref saveQueued) != 0;

    internal void SetAssets(string? assetDirectory)
    {
        if (assetDirectory is null) return;
        renderer.SetAssetDirectory(assetDirectory);
        renderer.Images.Clear();
        renderer.Texts.Clear();
        assets.SetAssets(assetDirectory);
    }

    internal void ApplySettings(RecognitionSettings value)
    {
        var previous = settings;
        settings = value;
        if (initialized && (previous.WindowWidth != value.WindowWidth || previous.WindowHeight != value.WindowHeight || previous.WindowLeft != value.WindowLeft || previous.WindowTop != value.WindowTop))
            ApplyWindow();
    }

    /// <summary>Raised the moment a run starts, so the reader sees the window before the OCR does its
    /// work instead of wondering whether the hotkey registered.</summary>
    internal void ShowLoading()
    {
        loading = true;
        result = null;
        scroll = 0;
        expires = 0;
        Show();
    }

    internal void ShowResult(RecognitionResult value)
    {
        loading = false;
        result = value;
        scroll = 0;
        expires = settings.AutoClose ? Environment.TickCount64 + Math.Max(1, settings.AutoCloseSeconds) * 1000L : long.MaxValue;
        Show();
    }

    /// <summary>The dashboard cleared the shared result; nothing is left to show.</summary>
    internal void Clear()
    {
        result = null;
        loading = false;
        expires = 0;
        Hide();
    }

    internal void Tick(long now)
    {
        // A window the reader is dragging or resizing stays put: hiding it mid-drag would strand the
        // mouse capture and leave the next show at whatever half-applied geometry there was.
        if (visible && drag == 0 && expires != 0 && now >= expires)
        {
            expires = 0;
            Hide();
        }
        if (visible) Render();
    }

    private void Show()
    {
        if (!settings.AutoPush) { Hide(); return; }
        ApplyWindow();
        if (!visible) { Native.ShowWindow(hwnd, 8); visible = true; }
        OverlayDiagnostics.Log("info", "recognition_window", loading ? "loading" : "result");
    }

    private string loggedMetrics = "";

    /// <summary>One line per window setup and per change in how many rows have their artwork ready:
    /// enough to tell "it looks small" apart from "the textures never arrived".</summary>
    private void LogMetrics(RecognitionPanelView view)
    {
        var scale = Scale();
        var metrics = new PanelMetrics(scale);
        var ready = view.Items.Count(item => item.Name.Texture != 0);
        var key = $"{scale:F2}|{settings.WindowWidth}x{settings.WindowHeight}|{ready}/{view.Items.Count}";
        if (loggedMetrics == key) return;
        loggedMetrics = key;
        var columns = metrics.Columns(settings.WindowWidth);
        var first = view.Items.Count > 0 ? view.Items[0] : null;
        OverlayDiagnostics.Log("info", "recognition_panel_metrics",
            $"scale={scale:F2} dpi={Native.GetDpiForWindow(hwnd)} client={settings.WindowWidth}x{settings.WindowHeight} row={metrics.RowHeight:F0} name={columns.NameWidth:F0} trader={columns.TraderWidth:F0} flea={columns.FleaWidth:F0} namesReady={ready}/{view.Items.Count} nameWrap={metrics.NameWrapWidth(columns.NameWidth):F0} nameTexture={(first is null ? 0 : first.Name.Size.X):F0}x{(first is null ? 0 : first.Name.Size.Y):F0}");
    }

    private void Hide()
    {
        if (drag != 0)
        {
            Native.ReleaseCapture();
            drag = 0;
        }
        if (!visible) return;
        visible = false;
        Native.ShowWindow(hwnd, 0);
    }

    private void ApplyWindow()
    {
        var metrics = new PanelMetrics(Scale());
        // The contract's floor is a logical size; the columns add the DPI on top, so a scaled display
        // widens the window rather than squeezing the name column.
        var minimumWidth = Math.Max(320, (int)(Math.Ceiling(metrics.MinimumWidth() / 8) * 8));
        var width = Math.Clamp(settings.WindowWidth, minimumWidth, 900);
        var height = Math.Clamp(settings.WindowHeight, 200, 640);
        var (left, top) = Position(width, height);
        settings = settings with { WindowLeft = left, WindowTop = top, WindowWidth = width, WindowHeight = height };
        Native.SetWindowPos(hwnd, -1, left, top, width, height, 0x0010 | 0x0020);
        renderer.Resize(width, height);
    }

    private (int Left, int Top) Position(int width, int height)
    {
        // A saved 0,0 means "never placed": the first show picks the bottom-right of the monitor the
        // cursor is on, and everything after that is wherever the reader dragged it.
        if (!placed && settings.WindowLeft == 0 && settings.WindowTop == 0)
        {
            placed = true;
            Native.GetCursorPos(out var cursor);
            var area = Monitor(cursor.X, cursor.Y);
            return (area.Right - width - 16, area.Bottom - height - 16);
        }
        placed = true;
        var bounds = Monitor(settings.WindowLeft + width / 2, settings.WindowTop + height / 2);
        return (Math.Clamp(settings.WindowLeft, bounds.Left, Math.Max(bounds.Left, bounds.Right - width)),
            Math.Clamp(settings.WindowTop, bounds.Top, Math.Max(bounds.Top, bounds.Bottom - height)));
    }

    private static Native.Rect Monitor(int x, int y)
    {
        var probe = new Native.Rect { Left = x, Top = y, Right = x + 1, Bottom = y + 1 };
        var info = new Native.MonitorInfo { Size = (uint)Marshal.SizeOf<Native.MonitorInfo>() };
        // The full monitor, not its work area: the game runs borderless over the taskbar, so the panel
        // has to be allowed to sit there too.
        return Native.GetMonitorInfo(Native.MonitorFromRect(ref probe, 2), ref info)
            ? info.Monitor
            : new Native.Rect { Right = 1920, Bottom = 1080 };
    }

    internal nint? Message(uint message, nuint wParam, nint lParam)
    {
        if (!visible) return null;
        var m = new PanelMetrics(Scale());
        var x = (int)(short)((long)lParam & 65535);
        var y = (int)(short)(((long)lParam >> 16) & 65535);
        if (message == Native.WmNcHitTest)
        {
            Native.GetWindowRect(hwnd, out var rect);
            x -= rect.Left;
            y -= rect.Top;
            SetCursor(Zone(m, x, y));
            return 1;
        }
        // Windows asks for the cursor here as well, and whatever this handler leaves behind is what
        // the reader sees; setting it only from the hit test made the resize arrows unreliable.
        if (message == Native.WmSetCursor)
        {
            if (drag == 0)
            {
                Native.GetCursorPos(out var cursor);
                Native.GetWindowRect(hwnd, out var rect);
                SetCursor(Zone(m, cursor.X - rect.Left, cursor.Y - rect.Top));
            }
            return 1;
        }
        if (message == Native.WmLButtonDown)
        {
            var (min, max) = m.CloseButton(settings.WindowWidth);
            if (x >= min.X && x <= max.X && y >= min.Y && y <= max.Y) { Hide(); return 0; }
            var zone = Zone(m, x, y);
            // The scrollbar is a control, not a window edge: dragging it scrolls the list.
            if (Scrolls(m, x, y)) { drag = ScrollDrag; expires = 0; ScrollTo(m, y); Native.SetCapture(hwnd); return 0; }
            // Only the title strip moves the window and only the border ring resizes it; the row area
            // is left alone so a stray click on the list cannot drag the panel out of place.
            if (zone == 9 && !m.InTitle(y)) return 0;
            Native.GetWindowRect(hwnd, out dragBounds);
            if (!Native.GetCursorPos(out dragStart)) return 0;
            drag = zone;
            // Positioning the panel cancels this result's countdown for good: a reader who just moved
            // it is reading it. The next result starts a fresh one, so nothing carries over.
            expires = 0;
            Native.SetCapture(hwnd);
            return 0;
        }
        if (message == Native.WmMouseMove && drag != 0)
        {
            if (!Native.GetCursorPos(out var cursor)) return 0;
            if (drag == ScrollDrag) { ScrollTo(m, cursor.Y - settings.WindowTop); return 0; }
            var dx = cursor.X - dragStart.X;
            var dy = cursor.Y - dragStart.Y;
            var left = dragBounds.Left; var top = dragBounds.Top; var right = dragBounds.Right; var bottom = dragBounds.Bottom;
            if (drag == 9) { left += dx; top += dy; right += dx; bottom += dy; }
            else
            {
                if (drag is 1 or 4 or 5) left += dx;
                if (drag is 3 or 6 or 7) right += dx;
                if (drag is 1 or 2 or 3) top += dy;
                if (drag is 5 or 7 or 8) bottom += dy;
            }
            var minimumWidth = Math.Max(320, (int)(Math.Ceiling(m.MinimumWidth() / 8) * 8));
            var width = Math.Clamp(right - left, minimumWidth, 900);
            var height = Math.Clamp(bottom - top, 200, 640);
            // A move follows the pointer; a resize keeps the corner the reader is not holding, so a
            // size that has reached its limit stops there instead of sliding the window along.
            var anchorX = drag == 9 ? left : drag is 1 or 4 or 5 ? right - width : dragBounds.Left;
            var anchorY = drag == 9 ? top : drag is 1 or 2 or 3 ? bottom - height : dragBounds.Top;
            var area = Monitor(anchorX + width / 2, anchorY + height / 2);
            var newLeft = Math.Clamp(anchorX, area.Left, Math.Max(area.Left, area.Right - width));
            var newTop = Math.Clamp(anchorY, area.Top, Math.Max(area.Top, area.Bottom - height));
            settings = settings with { WindowLeft = newLeft, WindowTop = newTop, WindowWidth = width, WindowHeight = height };
            Native.SetWindowPos(hwnd, -1, newLeft, newTop, width, height, 0x0010 | 0x0020);
            renderer.Resize(width, height);
            return 0;
        }
        if (message == Native.WmLButtonUp && drag != 0)
        {
            Native.ReleaseCapture();
            var scrolled = drag == ScrollDrag;
            drag = 0;
            if (!scrolled) QueueSave();
            return 0;
        }
        if (message == Native.WmCaptureChanged) { drag = 0; return null; }
        if (message == Native.WmMouseWheel)
        {
            var (_, rowsHeight) = m.RowsArea(settings.WindowHeight);
            var max = Math.Max(0, (result?.Rows.Length ?? 0) * m.RowHeight - rowsHeight);
            scroll = Math.Clamp(scroll - (short)((long)wParam >> 16) / 120f * m.RowHeight, 0, max);
            return 0;
        }
        return null;
    }

    /// <summary>1..8 are the resize zones clockwise from the top-left corner; 9 is the interior.</summary>
    private int Zone(PanelMetrics m, int x, int y)
    {
        var width = settings.WindowWidth; var height = settings.WindowHeight;
        var ring = ResizeRing * m.Scale;
        // The scrollbar strip is never a resize edge, so the reader can always grab it.
        var left = x <= ring; var right = x >= width - ring && !Scrolls(m, x, y);
        var top = y <= ring; var bottom = y >= height - ring;
        return (left, right, top, bottom) switch
        {
            (true, _, true, _) => 1,
            (_, true, true, _) => 3,
            (_, true, _, true) => 7,
            (true, _, _, true) => 5,
            (true, _, _, _) => 4,
            (_, true, _, _) => 6,
            (_, _, true, _) => 2,
            (_, _, _, true) => 8,
            _ => 9,
        };
    }

    /// <summary>True while the point is on the scrollbar strip of the scrolling row area.</summary>
    private bool Scrolls(PanelMetrics m, float x, float y)
    {
        if (!Scrollable(m)) return false;
        var (rowsTop, rowsHeight) = m.RowsArea(settings.WindowHeight);
        return x >= m.ScrollbarLeft(settings.WindowWidth) && y >= rowsTop && y <= rowsTop + rowsHeight;
    }

    private bool Scrollable(PanelMetrics m)
    {
        var (_, rowsHeight) = m.RowsArea(settings.WindowHeight);
        return (result?.Rows.Length ?? 0) * m.RowHeight > rowsHeight + 1;
    }

    /// <summary>Centres the scrollbar on the pointer: a drag on the thumb scrolls, a click on the track
    /// jumps, which is the behaviour a scrollbar is expected to have.</summary>
    private void ScrollTo(PanelMetrics m, float y)
    {
        var (rowsTop, rowsHeight) = m.RowsArea(settings.WindowHeight);
        if (!Scrollable(m)) { scroll = 0; return; }
        var content = (result?.Rows.Length ?? 0) * m.RowHeight;
        var travel = Math.Max(1, rowsHeight - Math.Max(24f * m.Scale, rowsHeight * rowsHeight / content));
        var offset = (y - rowsTop - Math.Max(24f * m.Scale, rowsHeight * rowsHeight / content) / 2) / travel;
        scroll = Math.Clamp(offset * (content - rowsHeight), 0, Math.Max(0, content - rowsHeight));
    }

    private void SetCursor(int zone) => Native.SetCursor(Native.LoadCursor(0, zone switch
    {
        1 or 7 => Native.SizeNWSE,
        3 or 5 => Native.SizeNESW,
        4 or 6 => Native.SizeWE,
        2 or 8 => Native.SizeNS,
        _ => Native.Arrow,
    }));

    private void QueueSave()
    {
        Interlocked.Exchange(ref saveDirty, 1);
        if (Interlocked.Exchange(ref saveQueued, 1) != 0) return;
        _ = SaveAsync();
    }

    private async Task SaveAsync()
    {
        try
        {
            do
            {
                Interlocked.Exchange(ref saveDirty, 0);
                await Task.Delay(100);
                await save(settings);
            } while (Volatile.Read(ref saveDirty) != 0);
        }
        catch (Exception e) { OverlayDiagnostics.Log("warn", "recognition_geometry_save_failed", e.Message); }
        finally
        {
            Interlocked.Exchange(ref saveQueued, 0);
            if (Volatile.Read(ref saveDirty) != 0) QueueSave();
        }
    }

    private void Render()
    {
        if (!initialized) return;
        assets.Upload(renderer.Texts, renderer.Images);
        var view = BuildView(renderer);
        LogMetrics(view);
        renderer.RenderRecognition(view, settings.Opacity);
    }

    /// <summary>The window's DPI factor: the panel's boxes and its text both scale with it.</summary>
    private float Scale()
    {
        var dpi = Native.GetDpiForWindow(hwnd) / 96f;
        return dpi <= 0 ? 1 : dpi;
    }

    private RecognitionPanelView BuildView(OverlayRenderer target)
    {
        var scale = Scale();
        var metrics = new PanelMetrics(scale);
        var rows = result?.Rows ?? [];
        var failed = result is { Error.Length: > 0 };
        // The title strip is just the window's name: the state belongs in the content area, where the
        // list would otherwise be.
        var title = Messages.Get("recognition.panel.title");
        var message = loading
            ? Messages.Get("recognition.panel.loading")
            : failed
                ? RecognitionError(result!.Error)
                : rows.Length == 0
                    ? Messages.Get("recognition.panel.empty")
                    : "";
        // Prices stay neutral: the header says which market each column is, so colour would only add
        // noise. The two legs differ by their trader portrait, not by hue.
        const string NameColor = "#e1e7e3";
        const string PriceColor = "#d7ded9";
        const string HeaderColor = "#8f9992";
        const string TitleColor = "#e1e7e3";
        var messageColor = failed ? "#c4554b" : loading ? "#c8a24a" : "#c9d2cb";
        var columns = metrics.Columns(settings.WindowWidth);
        // The rasterizer works in logical pixels and multiplies by the DPI itself.
        var nameWrap = metrics.NameWrapWidth(columns.NameWidth);
        var nameHeader = Messages.Get("recognition.panel.name");
        var traderHeader = Messages.Get("recognition.panel.trader");
        var fleaHeader = Messages.Get("recognition.panel.flea");
        var items = new List<RecognitionPanelItem>(rows.Length);
        var traderSlot = 0f;
        foreach (var row in rows)
        {
            // Prices carry their currency; which market they belong to is the header's job.
            var trader = row.TraderPrice is null ? "" : $"{row.TraderPrice.Value:N0} ₽";
            var flea = row.FleaPrice is null ? "" : $"{row.FleaPrice.Value:N0} ₽";
            var traderText = trader.Length == 0 ? new RecognitionText(0, Vector2.Zero) : Text(target, trader, scale, "price", PanelMetrics.PriceSize, PriceColor);
            var fleaText = flea.Length == 0 ? new RecognitionText(0, Vector2.Zero) : Text(target, flea, scale, "price", PanelMetrics.PriceSize, PriceColor);
            items.Add(new RecognitionPanelItem(
                Image(target, row.Image, avatar: false, pixels: (int)(2 * metrics.Thumb)),
                row.Trader is { Image.Length: > 0 } portrait ? Image(target, portrait.Image, avatar: true, pixels: (int)(2 * metrics.Avatar)) : null,
                Text(target, row.Name, scale, "annotation", PanelMetrics.NameSize, NameColor, nameWrap, PanelMetrics.NameLines),
                traderText,
                fleaText));
            if (traderText.Texture != 0) traderSlot = Math.Max(traderSlot, traderText.Size.X);
        }
        return new RecognitionPanelView(
            scale,
            traderSlot > 0 ? traderSlot : metrics.PriceSlot,
            loading,
            Environment.TickCount64 / 250f,
            Text(target, title, scale, "named", PanelMetrics.TitleSize, TitleColor),
            Text(target, message, scale, "named", PanelMetrics.NameSize, messageColor),
            Text(target, nameHeader, scale, "named", PanelMetrics.HeaderSize, HeaderColor),
            Text(target, traderHeader, scale, "named", PanelMetrics.HeaderSize, HeaderColor),
            Text(target, fleaHeader, scale, "named", PanelMetrics.HeaderSize, HeaderColor),
            items,
            scroll,
            rows.Length * metrics.RowHeight);
    }

    private RecognitionText Text(OverlayRenderer target, string text, float dpi, string role, float size, string color, float width = 0, int maxLines = 0)
    {
        if (text.Length == 0) return new RecognitionText(0, Vector2.Zero);
        var key = assets.TextKey(text, role, size, color, dpi, width, maxLines);
        var texture = target.Texts.Get(key);
        if (texture is not null) return new RecognitionText(texture.NativePointer, target.Texts.Size(key));
        // The cache is the record of what exists, so a miss is what asks for the rasterization.
        assets.RequestText(text, role, size, color, dpi, width, maxLines);
        return new RecognitionText(0, Vector2.Zero);
    }

    private RecognitionText Image(OverlayRenderer target, string url, bool avatar, int pixels)
    {
        if (url.Length == 0) return new RecognitionText(0, Vector2.Zero);
        var key = assets.ImageKey(url, pixels);
        var texture = target.Images.Get(key);
        if (texture is not null) return new RecognitionText(texture.NativePointer, target.Images.Size(key));
        assets.RequestImage(url, avatar, pixels);
        return new RecognitionText(0, Vector2.Zero);
    }

    public void Dispose()
    {
        assets.Dispose();
        renderer.Dispose();
    }
}
