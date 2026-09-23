using System.Collections.Concurrent;
using System.Diagnostics;
using System.Numerics;
using System.Runtime.InteropServices;
using EFTToolbox.Contracts;
using MapPoint = EFTToolbox.Contracts.MapPoint;

namespace EFTToolbox.Overlay;

internal sealed class OverlayApplication : IDisposable
{
    private readonly nint hwnd;
    private readonly OverlayRenderer renderer = new();
    private readonly OverlayStateClient client;
    private readonly TileLayerRenderer tiles;
    private readonly MarkerLayer markers;
    private readonly MapScene scene = new();
    private readonly ConcurrentQueue<Action> completions = new();
    private readonly SemaphoreSlim svgWorker = new(1);
    private readonly SvgRasterizer rasterizer = new();
    private OverlaySettings settings = OverlaySettingsStore.Defaults;
    private Preferences preferences = new();
    private OverlayBootstrap? bootstrap;
    private CancellationTokenSource loading = new();
    private int generation;
    private int renderCount, hotkeyCount;
    private bool hotkeysActive;
    // Kept as one instance per change: OverlayView compares arrays by reference, and a fresh array
    // every report would make every report look like a change.
    private string[] hotkeyFailed = [];
    private int resourceDirty;
    private bool wasVisible;
    private bool dirty = true, editing, disposed;
    private Operation? operation;
    private bool loadingScene;
    private long nextFrame, lastFiles, lastReport;
    private bool resourceFilesChanged;
    private string error = "";
    private string resourceKey = "";
    private double observedSvgZoom = double.NaN;
    private float observedSvgDpi;
    private long svgQualityDue;
    private int drag;
    private Native.CursorPoint dragStart;
    private OverlaySettings dragSettings = OverlaySettingsStore.Defaults;
    private Vector2 dragCenter;
    private int dragSaveQueued;
    // Registration ids are 1-based positions in this table; the same names are what the dashboard
    // shows next to a field when RegisterHotKey is refused.
    private static readonly string[] HotkeyNames = ["toggleEdit", "toggleVisible", "zoomIn", "zoomOut", "floorUp", "floorDown", "toggleBasemap", "panUp", "panDown", "panLeft", "panRight"];
    private const long SuspendLimit = 120_000;
    private const double TapZoom = 0.32, zoomPerSecond = 1.2;
    private readonly uint[] hotkeyVirtualKey = new uint[HotkeyNames.Length + 1];
    private readonly uint[] hotkeyModifiers = new uint[HotkeyNames.Length + 1];
    // A held continuous shortcut (zoom, pan) is tracked here and integrated per frame instead of
    // relying on the OS repeating the hotkey.
    private readonly Dictionary<int, long> interactions = new();
    private long lastFrameAt;
    private long lastReloadHotkey;
    // A suspended overlay has no hot keys registered at all, so the timer is what brings them back
    // if the dashboard goes away mid-recording.
    private bool hotkeysSuspended;
    private long hotkeysSuspendedUntil;
    internal bool Editing => editing;
    internal OverlayApplication(nint hwnd, Uri backend)
    {
        this.hwnd = hwnd; client = new(backend, Wake); tiles = new(ResourceReady, client); markers = new(ResourceReady);
        renderer.Initialize(hwnd); ApplyWindow(); client.Start();
    }
    private void ResourceReady() { Interlocked.Exchange(ref resourceDirty, 1); Wake(); }
    private async Task SaveDragSettings()
    {
        if (Interlocked.Exchange(ref dragSaveQueued, 1) != 0) return;
        await Task.Delay(100);
        Interlocked.Exchange(ref dragSaveQueued, 0);
        if (drag >= 2) await client.SaveAsync(settings);
    }
    // Handle hit zones sit exactly on the painted handles; everything else on the border ring moves
    // the window, and the interior pans the map. The three zones never overlap.
    private int ResizeHandle(Vector2 p)
    {
        var w = settings.Width; var h = settings.Height;
        if (settings.Shape == "circle")
        {
            foreach (var handle in OverlayGeometry.CircleHandles)
                if (Vector2.Distance(p, OverlayGeometry.CircleHandle(handle, w, h)) <= OverlayGeometry.CircleHandleHit) return handle;
            return 0;
        }
        foreach (var handle in OverlayGeometry.SquareHandles)
        {
            var d = p - OverlayGeometry.Handle(handle, w, h);
            if (Math.Abs(d.X) <= OverlayGeometry.HandleHit && Math.Abs(d.Y) <= OverlayGeometry.HandleHit) return handle;
        }
        return 0;
    }
    private bool OnRing(Vector2 p)
    {
        var w = settings.Width; var h = settings.Height;
        if (settings.Shape == "circle") return Math.Abs(Vector2.Distance(p, new Vector2(w, h) / 2) - OverlayGeometry.Radius(w, h)) <= OverlayGeometry.CircleRing;
        var edge = Math.Min(Math.Min(p.X, p.Y), Math.Min(w - p.X, h - p.Y));
        return edge <= OverlayGeometry.RingWidth;
    }
    private void SetCursor(Vector2 p)
    {
        var handle = ResizeHandle(p);
        var cursor = handle is 3 or 7 ? Native.SizeNWSE : handle is 5 or 9 ? Native.SizeNESW : handle is 4 or 8 ? Native.SizeNS : handle is 6 or 10 ? Native.SizeWE : OnRing(p) ? Native.SizeAll : Native.Arrow;
        Native.SetCursor(Native.LoadCursor(0, cursor));
    }
    private void BeginDrag()
    {
        Native.GetCursorPos(out dragStart); dragSettings = settings; dragCenter = scene.Center;
    }
    private void Wake() => Native.PostMessage(hwnd, 0x8001, 0, 0);
    private void Begin(string source, string? id = null, bool resources = false)
    {
        if (operation is null) operation = new(source, scene.Map?.Id ?? "", scene.Floor, scene.Basemap, generation, settings.SvgResolution, id);
        else if (resources) operation = new(operation.Source, scene.Map?.Id ?? "", scene.Floor, scene.Basemap, generation, settings.SvgResolution, operation.Id, operation.Started) { Timing = operation.Timing, ResourceLoad = true };
        if (resources && operation is not null) operation.ResourceLoad = true;
        dirty = true;
    }
    private void ApplyWindow()
    {
        var rect = new Native.Rect { Left = settings.Left, Top = settings.Top, Right = settings.Left + settings.Width, Bottom = settings.Top + settings.Height };
        var info = new Native.MonitorInfo { Size = (uint)Marshal.SizeOf<Native.MonitorInfo>() };
        Native.Check(Native.GetMonitorInfo(Native.MonitorFromRect(ref rect, 2), ref info));
        settings = ClampWindow(settings, info.Monitor);
        var width = settings.Width; var height = settings.Height;
        Native.SetWindowLongPtr(hwnd, -20, (nint)(editing ? Native.ExStyle & ~0x20u : Native.ExStyle));
        Native.Check(Native.SetWindowPos(hwnd, -1, settings.Left, settings.Top, width, height, 0x0010 | 0x0020));
        Native.ShowWindow(hwnd, settings.Visible ? 4 : 0);
        if (!settings.Visible && wasVisible)
        {
            tiles.Clear(); markers.CancelPending(); loading.Cancel();
            if (loadingScene || error == "errors.overlay_resource_failed") resourceKey = "";
            loadingScene = false;
        }
        if (settings.Visible && !wasVisible) LoadResources();
        wasVisible = settings.Visible;
        scene.Width = width; scene.Height = height; scene.Dpi = Native.GetDpiForWindow(hwnd) / 96f; scene.ClampZoom(); renderer.Resize(width, height); dirty = true;
    }
    internal static OverlaySettings ClampWindow(OverlaySettings value, Native.Rect monitor)
    {
        var width = Math.Min(value.Width, monitor.Right - monitor.Left);
        var height = Math.Min(value.Height, monitor.Bottom - monitor.Top);
        if (value.Shape == "circle") width = height = Math.Min(width, height);
        else if (value.LockAspect)
        {
            var scale = Math.Min((double)width / value.Width, (double)height / value.Height);
            width = Math.Max(1, (int)Math.Floor(value.Width * scale));
            height = Math.Max(1, (int)Math.Floor(value.Height * scale));
        }
        return value with { Width = width, Height = height, Left = Math.Clamp(value.Left, monitor.Left, monitor.Right - width), Top = Math.Clamp(value.Top, monitor.Top, monitor.Bottom - height) };
    }
    private void Hotkeys()
    {
        for (int id = 1; id <= HotkeyNames.Length; id++) Native.UnregisterHotKey(hwnd, id);
        interactions.Clear();
        hotkeyCount = 0; var failed = new List<string>();
        var values = new[] { settings.Hotkeys.ToggleEdit, settings.Hotkeys.ToggleVisible, settings.Hotkeys.ZoomIn, settings.Hotkeys.ZoomOut, settings.Hotkeys.FloorUp, settings.Hotkeys.FloorDown, settings.Hotkeys.ToggleBasemap, settings.Hotkeys.PanUp, settings.Hotkeys.PanDown, settings.Hotkeys.PanLeft, settings.Hotkeys.PanRight };
        hotkeysActive = values.Any(value => !string.IsNullOrWhiteSpace(value));
        if (!hotkeysActive) return;
        for (int index = 0; index < values.Length; index++)
        {
            var id = index + 1; var value = values[index]; hotkeyVirtualKey[id] = 0; hotkeyModifiers[id] = 0;
            if (string.IsNullOrWhiteSpace(value)) continue;
            var parts = value.Split('+'); uint modifiers = 0x4000;
            foreach (var part in parts[..^1]) modifiers |= part switch { "Alt" => 1u, "Ctrl" => 2u, "Shift" => 4u, "Win" => 8u, _ => 0 };
            var key = parts[^1]; uint vk = key.Length == 1 ? key[0] : key.StartsWith('F') && int.TryParse(key[1..], out var f) ? (uint)(111 + f) : key switch { "Space" => 32u, "Insert" => 45u, "Delete" => 46u, "Home" => 36u, "End" => 35u, "PageUp" => 33u, "PageDown" => 34u, "Up" => 0x26u, "Down" => 0x28u, "Left" => 0x25u, "Right" => 0x27u, "Backquote" => 0xC0u, "Minus" => 0xBDu, "Equal" => 0xBBu, "BracketLeft" => 0xDBu, "BracketRight" => 0xDDu, "Backslash" => 0xDCu, "Semicolon" => 0xBAu, "Quote" => 0xDEu, "Comma" => 0xBCu, "Period" => 0xBEu, "Slash" => 0xBFu, _ => 0 };
            // The dashboard reports this next to the offending field, so name it instead of the
            // generic error channel.
            if (vk == 0 || !Native.RegisterHotKey(hwnd, id, modifiers, vk)) { failed.Add(HotkeyNames[index]); OverlayDiagnostics.Log("error", "hotkey_failed", $"Hotkey unavailable: {HotkeyNames[index]}={value}"); }
            else { hotkeyVirtualKey[id] = vk; hotkeyModifiers[id] = modifiers & ~0x4000u; hotkeyCount++; }
        }
        hotkeyFailed = [.. failed];
    }
    // Zoom and pan keep moving while the key is held; everything else fires once per press.
    private static bool Continuous(int id) => id is 3 or 4 or 8 or 9 or 10 or 11;
    // The dashboard suspends these while it records a shortcut: a registered hot key is swallowed
    // before the browser sees it, so Alt+Up could never be recorded while the overlay owned it.
    private void SuspendHotkeys(bool suspended)
    {
        hotkeysSuspended = suspended;
        hotkeysSuspendedUntil = Environment.TickCount64 + SuspendLimit;
        if (suspended)
        {
            for (int id = 1; id <= HotkeyNames.Length; id++) Native.UnregisterHotKey(hwnd, id);
            // Registration state stays as reported: the dashboard would otherwise paint every field
            // as broken for as long as the recorder is open.
            interactions.Clear();
        }
        else Hotkeys();
    }
    private static bool ModifierDown(uint modifiers)
    {
        if ((modifiers & 1u) != 0 && Native.GetAsyncKeyState(Native.VkMenu) >= 0) return false;
        if ((modifiers & 2u) != 0 && Native.GetAsyncKeyState(Native.VkControl) >= 0) return false;
        if ((modifiers & 4u) != 0 && Native.GetAsyncKeyState(Native.VkShift) >= 0) return false;
        if ((modifiers & 8u) != 0 && Native.GetAsyncKeyState(Native.VkLWin) >= 0 && Native.GetAsyncKeyState(Native.VkRWin) >= 0) return false;
        return true;
    }
    private void RunHotkey(int id)
    {
        switch (id)
        {
            case 1: editing = !editing; if (editing) settings = settings with { Visible = true }; ApplyWindow(); _ = client.SaveAsync(settings); break;
            case 2: settings = settings with { Visible = !settings.Visible }; if (!settings.Visible) editing = false; ApplyWindow(); _ = client.SaveAsync(settings); break;
            case 5: ShiftFloor(1); break;
            case 6: ShiftFloor(-1); break;
            case 7: ToggleBasemap(); break;
        }
        Begin("hotkey");
    }
    // Floor and basemap both re-rasterize the whole map, so they never run on the per-frame path.
    private bool ReloadCooldown()
    {
        var now = Environment.TickCount64;
        if (now - lastReloadHotkey < 250) return false;
        lastReloadHotkey = now; return true;
    }
    private void ShiftFloor(int delta)
    {
        var map = scene.Map; if (map is null || map.Floors.Length == 0 || !ReloadCooldown()) return;
        var available = scene.SelectableFloors().Select(f => f.Id).ToHashSet();
        var floors = map.Floors.Where(f => f.Id == map.BaseFloor || available.Contains(f.Id)).ToArray();
        if (floors.Length == 0) return;
        var index = Array.FindIndex(floors, f => f.Id == scene.Floor);
        var next = index < 0 ? (delta > 0 ? 0 : floors.Length - 1) : Math.Clamp(index + delta, 0, floors.Length - 1);
        if (next == index) return;
        scene.Floor = floors[next].Id; scene.ClampZoom(); LoadResources();
        OverlayDiagnostics.Log("info", "hotkey_floor", $"Floor {scene.Floor}");
    }
    private void ToggleBasemap()
    {
        var map = scene.Map; if (map is null || map.SvgUrl == "" || map.Tiles.Length == 0 || !ReloadCooldown()) return;
        scene.Basemap = scene.Basemap == "tiles" ? "svg" : "tiles";
        scene.ClampZoom(); LoadResources();
    }
    // Map coordinates run y-down, like the SVG they came from, so "up" is -y.
    private static Vector2 Direction(int id) => id switch
    {
        8 => new(0, -1),
        9 => new(0, 1),
        10 => new(-1, 0),
        _ => new(1, 0),
    };
    // Zoom is only rounded when it is reported; quantising the live value made a held key advance
    // in visible 0.1 jumps instead of sliding.
    private void ZoomBy(int id, double delta)
    {
        scene.Zoom += (id == 3 ? delta : -delta);
        scene.ClampZoom();
    }
    private void AdvanceInteraction(long now)
    {
        var seconds = Math.Min(0.05, Math.Max(0, now - lastFrameAt) / 1000.0);
        lastFrameAt = now;
        if (!hotkeysActive || !settings.Visible || hotkeysSuspended) { interactions.Clear(); return; }
        var direction = Vector2.Zero;
        var panAcceleration = 0f;
        double zoom = 0;
        foreach (var (id, started) in interactions.ToArray())
        {
            if (Native.GetAsyncKeyState((int)hotkeyVirtualKey[id]) >= 0 || !ModifierDown(hotkeyModifiers[id]) || now - started > 30000) { interactions.Remove(id); continue; }
            var acceleration = Math.Clamp((now - started) / 100f, 0, 1);
            if (id is 3 or 4) zoom += (id == 3 ? 1 : -1) * zoomPerSecond * seconds * acceleration;
            else { direction += Direction(id); panAcceleration = Math.Max(panAcceleration, acceleration); }
        }
        if (direction.LengthSquared() > 1) direction = Vector2.Normalize(direction);
        if (direction == Vector2.Zero && zoom == 0) return;
        scene.Center += direction * panAcceleration * (float)(700 * seconds) * scene.Dpi / scene.Scale;
        scene.Zoom += zoom; scene.ClampZoom(); Begin("hotkey");
    }
    private void ApplySettings(OverlaySettings value)
    {
        var old = settings; settings = OverlaySettingsStore.Clamp(value); error = "";
        if (!settings.Visible) editing = false;
        // While the dashboard records a shortcut nothing may be registered, and the resume that
        // follows re-reads the settings anyway.
        if (old.Hotkeys != settings.Hotkeys && !hotkeysSuspended) Hotkeys();
        ApplyWindow(); Begin("settings");
        if (settings.Left != value.Left || settings.Top != value.Top || settings.Width != value.Width || settings.Height != value.Height) _ = client.SaveAsync(settings);
        if (old.SvgResolution != settings.SvgResolution || old.SvgQualityMode != settings.SvgQualityMode) LoadResources();
    }
    private void Select(Preferences next, bool force = false)
    {
        var maps = next.Maps is null ? [] : (MapPreference[])next.Maps.Clone();
        for (var i = 0; i < maps.Length; i++)
        {
            var mapPreference = maps[i];
            maps[i] = mapPreference with
            {
                HiddenCategories = mapPreference.HiddenCategories ?? [],
                CollapsedGroups = mapPreference.CollapsedGroups ?? [],
                SelectedTasks = mapPreference.SelectedTasks ?? [],
                Center = mapPreference.Center ?? [],
            };
        }
        next = next with { Maps = maps, StickerUsage = next.StickerUsage ?? [] };
        var selectionChanged = preferences.SelectedMap != next.SelectedMap;
        var p = next.Maps.FirstOrDefault(p => p.MapId == next.SelectedMap); preferences = next;
        if (p is null) return;
        if (scene.Map?.Id != next.SelectedMap) { if (scene.Map is null || selectionChanged || force) LoadMap(next.SelectedMap, p); return; }
        var old = scene.Preference; scene.Preference = p;
        if (force || old.FloorId != p.FloorId || old.Basemap != p.Basemap)
        {
            scene.Floor = p.FloorId; scene.Basemap = p.Basemap; scene.NormalizeFloor();
        }
        if (force || !old.Center.SequenceEqual(p.Center)) if (p.Center.Length == 2) scene.Center = new((float)p.Center[1], (float)-p.Center[0]);
        if (force || old.Zoom != p.Zoom) scene.Zoom = p.Zoom;
        scene.ClampZoom(); Begin("dashboard"); LoadResources();
    }
    private void LoadMap(string id, MapPreference? preference = null, bool follow = false, bool preserveView = false)
    {
        var keepView = preserveView && scene.Map?.Id == id;
        var previousView = (scene.Center, scene.Zoom, scene.Floor, scene.Basemap);
        if (bootstrap is null) return; loading.Cancel(); loading.Dispose(); loading = new(); var token = loading.Token; var version = ++generation;
        tiles.Clear(); renderer.Tiles.Clear(); renderer.Svg.Clear(); scene.SvgRegion = null; resourceKey = ""; scene.Map = null; loadingScene = true; Begin("map", resources: true);
        var b = bootstrap;
        _ = Task.Run(() =>
        {
            try
            {
                var map = OverlayStateClient.Read<MapData>(Path.Combine(b.MapDirectory, id + ".json")) ?? throw new InvalidDataException("Empty map");
                if (map.Projection is null || map.Projection.Bounds is null || map.Projection.ViewBox is null ||
                    map.Floors is null || map.Categories is null || map.Markers is null || map.Tasks is null ||
                    map.Warnings is null || map.Clock is null || map.Clock.Phases is null ||
                    map.Clock.Offsets is null || map.Clock.Fixed is null || map.Tiles is null ||
                    map.Projection.Bounds.Length != 2 || map.Projection.ViewBox.Length != 4 ||
                    map.Floors.Any(f => f is null || f.SvgGroups is null) ||
                    map.Markers.Any(m => m is null || m.CategoryIds is null || m.FloorIds is null || m.Outline is null) ||
                    map.Tiles.Any(t => t is null || t.Transform is null || t.Bounds is null))
                    throw new InvalidDataException("Invalid map collections");
                var annotations = ReadAnnotations(b, id);
                token.ThrowIfCancellationRequested();
                completions.Enqueue(() =>
                {
                    if (version != generation) return;
                    scene.Map = map; scene.Preference = preference ?? preferences.Maps.FirstOrDefault(p => p.MapId == id) ?? new MapPreference { MapId = id, FloorId = map.DefaultFloor, Basemap = map.SvgUrl != "" ? "svg" : "tiles", ShowAnnotations = true };
                    scene.Floor = scene.Preference.FloorId; scene.Basemap = scene.Preference.Basemap; scene.Annotations = annotations;
                    if (keepView)
                    {
                        scene.Center = previousView.Center; scene.Zoom = previousView.Zoom;
                        if (map.Floors.Any(f => f.Id == previousView.Floor)) scene.Floor = previousView.Floor;
                        scene.Basemap = previousView.Basemap; scene.ClampZoom();
                    }
                    else if (scene.Preference.Center.Length == 2) { scene.Center = new((float)scene.Preference.Center[1], (float)-scene.Preference.Center[0]); scene.Zoom = scene.Preference.Zoom; scene.ClampZoom(); } else scene.Fit();
                    loadingScene = false; LoadResources(); if (follow) FollowSelf();
                }); Wake();
            }
            catch (OperationCanceledException) { }
            catch (Exception e) { completions.Enqueue(() => { if (version == generation) { loadingScene = false; error = "errors.overlay_resource_failed"; } }); OverlayDiagnostics.Log("error", "map_load_failed", e.Message, operation, id); Wake(); }
        });
    }
    private static Annotation[] ReadAnnotations(OverlayBootstrap b, string id)
    {
        var path = Path.Combine(b.AnnotationsDirectory, id + ".annotations.json");
        return File.Exists(path) ? OverlayStateClient.Read<Annotations>(path)?.Items ?? [] : [];
    }
    private void LoadResources(bool force = false, bool viewOnly = false)
    {
        if (scene.Map is null || bootstrap is null || !settings.Visible) return;
        scene.NormalizeFloor();
        if (viewOnly && loadingScene) return;
        var map = scene.Map; var floor = scene.Floor; var raster = scene.Basemap == "tiles";
        var key = $"{map.Id}:{floor}:{raster}:{settings.SvgQualityMode}:{settings.SvgResolution}";
        if (!force && key == resourceKey) return;
        var keep = resourceKey.StartsWith($"{map.Id}:{floor}:{raster}:", StringComparison.Ordinal);
        resourceKey = key; var version = ++generation; loading.Cancel(); loading.Dispose(); loading = new(); var token = loading.Token;
        if (!viewOnly) { tiles.Clear(); renderer.Tiles.Clear(); }
        if (!keep) { renderer.Svg.Clear(); scene.SvgRegion = null; }
        Begin("resources", resources: true);
        if (map.SvgUrl == "" || (raster && map.Tiles.Any(t => t.FloorId == floor))) { loadingScene = false; return; }
        var region = settings.SvgQualityMode == "auto" ? SvgRegion.Around(scene) : null;
        observedSvgZoom = scene.Zoom; observedSvgDpi = scene.Dpi; svgQualityDue = 0;
        loadingScene = true; var path = Path.Combine(bootstrap.AssetDirectory, Path.GetFileName(map.SvgUrl)); var resolution = settings.SvgResolution; var op = operation; var queued = Stopwatch.GetTimestamp();
        _ = Task.Run(async () =>
        {
            var entered = false;
            try
            {
                await svgWorker.WaitAsync(token); entered = true; var queueMs = Stopwatch.GetElapsedTime(queued).TotalMilliseconds; var image = rasterizer.Rasterize(path, resolution, map, floor, raster, region); token.ThrowIfCancellationRequested();
                completions.Enqueue(() =>
                {
                    if (version != generation) return;
                    var timer = Stopwatch.StartNew(); renderer.Svg.Put("map", image); scene.SvgRegion = region;
                    if (op is not null) op.Timing = op.Timing with { QueueMs = queueMs, ReadMs = image.ReadMs, ParseMs = image.ParseMs, RasterMs = image.RasterMs, UploadMs = timer.Elapsed.TotalMilliseconds, Resource = path };
                    loadingScene = false; dirty = true;
                    if (error == "errors.overlay_resource_failed") error = "";
                }); Wake();
            }
            catch (OperationCanceledException) { }
            catch (Exception e) { completions.Enqueue(() => { if (version == generation) { loadingScene = false; error = "errors.overlay_resource_failed"; dirty = true; } }); OverlayDiagnostics.Log("error", "svg_load_failed", e.Message, op, path); Wake(); }
            finally { if (entered) svgWorker.Release(); }
        });
    }
    private void UpdateSvgView(long now)
    {
        if (!settings.Visible || settings.SvgQualityMode != "auto" || scene.Map is not { } map || map.SvgUrl == "" || scene.Basemap == "tiles" && map.Tiles.Any(t => t.FloorId == scene.Floor)) { svgQualityDue = 0; return; }
        if (observedSvgZoom != scene.Zoom || observedSvgDpi != scene.Dpi)
        {
            observedSvgZoom = scene.Zoom; observedSvgDpi = scene.Dpi; svgQualityDue = now + 150;
        }
        var outside = scene.SvgRegion is { } region && !region.Contains(scene);
        if (!loadingScene && (outside || svgQualityDue != 0 && now >= svgQualityDue)) LoadResources(true, viewOnly: true);
    }
    private void FollowSelf()
    {
        var player = scene.Players.Values.FirstOrDefault(p => p.IsSelf); if (player is null) return;
        if (settings.FollowCenter && player.MapId != scene.Map?.Id) { LoadMap(player.MapId, follow: true); return; }
        if (player.MapId != scene.Map?.Id) return;
        if (settings.FollowCenter) scene.Center = new((float)player.MapPosition.X, (float)player.MapPosition.Y);
        if (settings.FollowFloor && player.Resolution.FloorId is { } floor) scene.Floor = floor;
        if (settings.FollowZoom) scene.Zoom = settings.PerMapZoom ? settings.MapZooms.FirstOrDefault(z => z.MapId == player.MapId)?.Zoom ?? settings.TargetZoom : settings.TargetZoom;
        scene.ClampZoom(); LoadResources();
    }
    private void Event(ServerEvent e)
    {
        if (e.Type == "overlay_status") return;
        var nextPreference = e.Preferences?.Maps.FirstOrDefault(p => p.MapId == e.Preferences.SelectedMap);
        var replacesResources = e.Preferences is { } next && next.SelectedMap != preferences.SelectedMap
            || nextPreference is { } view && (view.FloorId != scene.Preference.FloorId || view.Basemap != scene.Preference.Basemap)
            || e.OverlaySettings is { } options && options.SvgResolution != settings.SvgResolution
            || e.OverlayCommand?.FloorId is { } floor && floor != scene.Floor
            || e.Player is { IsSelf: true } self && (settings.FollowCenter && self.MapId != scene.Map?.Id || settings.FollowFloor && self.Resolution.FloorId != scene.Floor);
        if (replacesResources) operation = null;
        Begin(e.Type, e.OperationId);
        if (e.OverlaySettings is { } s) ApplySettings(s);
        if (e.Preferences is { } p) Select(p);
        if (e.Type == "snapshot")
        {
            lastView = null;
            var previousSelf = scene.Players.Values.FirstOrDefault(p => p.IsSelf);
            scene.Players.Clear(); foreach (var player in e.Players ?? []) scene.Players[player.PlayerId] = player;
            if (scene.Players.Values.FirstOrDefault(p => p.IsSelf) is { } snapshotSelf && PositionChanged(previousSelf, snapshotSelf)) FollowSelf();
        }
        if (e.Player is { } value)
        {
            scene.Players.TryGetValue(value.PlayerId, out var old);
            var changed = PositionChanged(old, value);
            scene.Players[value.PlayerId] = value; if (changed && value.IsSelf) FollowSelf();
        }
        if (e.Type == "player_remove" && e.PlayerId is { } id) scene.Players.Remove(id);
        if (e.Type == "annotations_changed" && e.MapId == scene.Map?.Id && bootstrap is { } b)
        {
            var mapId = e.MapId; _ = Task.Run(() => { try { var a = ReadAnnotations(b, mapId!); completions.Enqueue(() => { if (scene.Map?.Id == mapId) { scene.Annotations = a; dirty = true; } }); Wake(); } catch (Exception ex) { OverlayDiagnostics.Log("warn", "annotations_failed", ex.Message); } });
        }
        if (e.OverlayCommand is { } command)
        {
            if (command.Kind == "edit") { editing = command.Enabled ?? false; if (editing) settings = settings with { Visible = true }; else if (!settings.Visible) editing = false; ApplyWindow(); _ = client.SaveAsync(settings); }
            if (command.Kind == "visible") { settings = settings with { Visible = command.Enabled ?? false }; ApplyWindow(); _ = client.SaveAsync(settings); }
            if (command.Kind == "hotkeys") SuspendHotkeys(!(command.Enabled ?? true));
            if (command.Kind == "view") { if (command.Center is { } c) scene.Center = new((float)c.X, (float)c.Y); if (command.Zoom is { } z) scene.Zoom = z; if (command.FloorId is { } f) scene.Floor = f; scene.ClampZoom(); LoadResources(); }
        }
    }
    private static bool PositionChanged(PlayerState? previous, PlayerState current) => previous is null
        || previous.PlayerId != current.PlayerId || previous.IsSelf != current.IsSelf
        || previous.MapPosition != current.MapPosition || previous.WorldPosition != current.WorldPosition || previous.MapId != current.MapId || previous.Resolution.FloorId != current.Resolution.FloorId;
    internal void Tick()
    {
        if (Interlocked.Exchange(ref resourceDirty, 0) != 0) dirty = true;
        if (client.Bootstrap is { } b && b != bootstrap)
        {
            var previous = bootstrap;
            bootstrap = b; markers.SetAssets(b.AssetDirectory); renderer.SetAssetDirectory(b.AssetDirectory); renderer.Images.Clear(); renderer.Texts.Clear();
            dirty = true;
            // Tells the tile layer which tiles are already on disk; it asks the backend for the rest.
            _ = Task.Run(() => { try { tiles.SetManifest(b.TileManifestFile); } catch (Exception e) { OverlayDiagnostics.Log("warn", "tile_manifest_failed", e.Message); } Wake(); });
            if (previous is not null && scene.Map is { } map) LoadMap(map.Id, scene.Preference, preserveView: true);
        }
        while (client.TryRead(out var e)) if (e is not null) Event(e);
        while (completions.TryDequeue(out var complete)) { complete(); dirty = true; }
        var now = Environment.TickCount64;
        if (hotkeysSuspended && now - hotkeysSuspendedUntil >= 0) SuspendHotkeys(false);
        // A held zoom/pan shortcut keeps the loop at frame rate until the key comes back up.
        AdvanceInteraction(now);
        if (interactions.Count != 0) dirty = true;
        if (client.FilesChanged) { lastFiles = now; resourceFilesChanged |= client.ResourcesChanged; }
        if (lastFiles != 0 && now - lastFiles >= 150)
        {
            lastFiles = 0; var b2 = bootstrap; var reloadResources = resourceFilesChanged; resourceFilesChanged = false;
            if (b2 is not null)
            {
                var currentId = scene.Map?.Id;
                _ = Task.Run(async () =>
                {
                    try
                    {
                        var p = File.Exists(b2.PreferencesFile) ? OverlayStateClient.Read<Preferences>(b2.PreferencesFile) : null;
                        var saved = await client.GetSettingsAsync();
                        var annotations = currentId is null ? [] : ReadAnnotations(b2, currentId);
                        if (reloadResources) tiles.SetManifest(b2.TileManifestFile);
                        completions.Enqueue(() =>
                        {
                            if (bootstrap != b2) return;
                            if (p is not null) Select(p);
                            if (System.Text.Json.JsonSerializer.Serialize(saved) != System.Text.Json.JsonSerializer.Serialize(settings)) ApplySettings(saved);
                            if (scene.Map?.Id == currentId) scene.Annotations = annotations;
                            if (reloadResources)
                            {
                                markers.SetAssets(b2.AssetDirectory); renderer.Images.Clear(); renderer.Texts.Clear();
                                if (scene.Map is { } map) LoadMap(map.Id, scene.Preference, preserveView: true);
                            }
                        }); Wake();
                    }
                    catch (Exception ex) { OverlayDiagnostics.Log("warn", "file_reload_failed", ex.Message); }
                });
            }
        }
        UpdateSvgView(now);
        // Nothing can be drawn before the bootstrap arrives 鈥?and nothing may be: the font atlas is
        // only built once the asset directory is known, and ImGui cannot render an empty one.
        if (dirty && settings.Visible && bootstrap is not null && now >= nextFrame)
        {
            markers.Upload(renderer.Images, renderer.Texts); tiles.Upload(renderer.Tiles);
            if (bootstrap is { } b3) tiles.Update(scene, b3.TileDirectory, renderer.Tiles, operation);
            var timer = Stopwatch.StartNew(); renderer.Render(scene, markers, tiles, settings.Shape == "circle", settings.Backdrop, settings.Opacity ?? 100, editing, operation); renderCount++;
            if (operation is { } op) { op.Timing = op.Timing with { DrawMs = renderer.LastDrawMs, PresentMs = renderer.LastPresentMs }; if (!loadingScene && !tiles.Loading) { op.Complete(op.ResourceLoad); operation = null; } }
            dirty = false; nextFrame = now + 17;
        }
        if (!settings.Visible) operation = null;
        if (now - lastReport > 250)
        {
            // Report at the precision the contract declares; the dashboard renders these directly.
            var coordinate = MapPointLimits.X.Precision;
            var view = new OverlayView { MapId = scene.Map?.Id ?? "", Basemap = scene.Basemap, FloorId = scene.Floor, Center = new MapPoint { X = Math.Round(scene.Center.X, coordinate), Y = Math.Round(scene.Center.Y, coordinate) }, Zoom = Math.Round(scene.Zoom, OverlayViewLimits.Zoom.Precision), Editing = editing, Visible = settings.Visible, Connected = client.Connected, Error = error, RenderCount = renderCount, SvgParseCount = rasterizer.ParseCount, SvgRasterCount = rasterizer.RasterCount, TextureBytes = (int)(renderer.Svg.Bytes + renderer.Tiles.Bytes + renderer.Images.Bytes + renderer.Texts.Bytes), HotkeyCount = hotkeyCount, HotkeyFailed = hotkeyFailed };
            if (view != lastView) { lastView = view; _ = client.ReportAsync(view); }
            lastReport = now;
        }
    }
    private OverlayView? lastView;
    internal uint WaitMilliseconds => settings.Visible && (dirty || interactions.Count != 0)
        ? (uint)Math.Clamp(nextFrame - Environment.TickCount64, 0, 17)
        : lastFiles != 0 || svgQualityDue != 0 ? 16u : 250u;
    internal nint? Message(uint message, nuint wParam, nint lParam)
    {
        if (message == 0x8001) return 0;
        if (message is Native.WmDpiChanged or Native.WmDisplayChange)
        {
            if (drag != 0) { Native.ReleaseCapture(); drag = 0; }
            ApplyWindow(); _ = client.SaveAsync(settings); return 0;
        }
        if (message == Native.WmCaptureChanged) { drag = 0; return null; }
        if (message == 0x0312)
        {
            var id = (int)wParam;
            if (id < 1 || id > HotkeyNames.Length) return 0;
            if (Continuous(id))
            {
                if (!settings.Visible || interactions.ContainsKey(id)) return 0;
                var now = Environment.TickCount64;
                if (interactions.Count == 0) lastFrameAt = now;
                interactions[id] = now;
                if (id is 3 or 4) ZoomBy(id, TapZoom);
                dirty = true;
                Begin("hotkey");
            }
            else RunHotkey(id);
            return 0;
        }
        if (message == Native.WmNcHitTest)
        {
            if (!editing) return -1;
            if (settings.Shape == "circle") { var x = (short)((long)lParam & 65535) - settings.Left - settings.Width / 2f; var y = (short)(((long)lParam >> 16) & 65535) - settings.Top - settings.Height / 2f; if (x * x + y * y > Math.Pow(settings.Width / 2f, 2)) return -1; }
            SetCursor(new Vector2((short)((long)lParam & 65535) - settings.Left, (short)(((long)lParam >> 16) & 65535) - settings.Top)); return 1;
        }
        if (!editing) return null;
        if (message == Native.WmContextMenu) return 0;
        var local = new Vector2((short)((long)lParam & 65535), (short)(((long)lParam >> 16) & 65535));
        if (message is Native.WmLButtonDown or Native.WmRButtonDown)
        {
            BeginDrag();
            var handle = ResizeHandle(local);
            // Right button always moves the window; with the left button only the border ring does,
            // so the interior stays free for panning the map.
            drag = message == Native.WmRButtonDown ? 2 : handle != 0 ? handle : OnRing(local) ? 2 : 1;
            Native.SetCapture(hwnd); return 0;
        }
        if (message == Native.WmMouseMove && drag != 0)
        {
            Native.GetCursorPos(out var cursor); var delta = new Vector2(cursor.X - dragStart.X, cursor.Y - dragStart.Y);
            if (drag == 1) scene.Center = dragCenter - delta / scene.Scale;
            if (drag == 2) { settings = dragSettings with { Left = dragSettings.Left + (int)delta.X, Top = dragSettings.Top + (int)delta.Y }; ApplyWindow(); }
            if (drag >= 3)
            {
                var width0 = dragSettings.Width; var height0 = dragSettings.Height;
                var width = drag is 3 or 9 or 10 ? width0 - (int)delta.X : width0 + (int)delta.X;
                var height = drag is 3 or 4 or 5 ? height0 - (int)delta.Y : height0 + (int)delta.Y;
                var size = OverlaySettingsLimits.Width;
                int finalWidth, finalHeight;
                if (settings.LockAspect || settings.Shape == "circle")
                {
                    // Scale from the axis being dragged, so an edge handle changes the size it points along.
                    var factor = drag is 6 or 10 ? (double)width / width0 : drag is 4 or 8 ? (double)height / height0
                        : Math.Abs(delta.X) >= Math.Abs(delta.Y) ? (double)width / width0 : (double)height / height0;
                    factor = Math.Clamp(factor, Math.Max(size.Min / width0, size.Min / height0), Math.Min(size.Max / width0, size.Max / height0));
                    finalWidth = (int)Math.Round(width0 * factor); finalHeight = (int)Math.Round(height0 * factor);
                }
                else { finalWidth = (int)Math.Clamp(width, size.Min, size.Max); finalHeight = (int)Math.Clamp(height, size.Min, size.Max); }
                // The opposite edge stays put even when the requested size was clamped.
                settings = settings with
                {
                    Width = finalWidth,
                    Height = finalHeight,
                    Left = drag is 3 or 9 or 10 ? dragSettings.Left + (width0 - finalWidth) : dragSettings.Left,
                    Top = drag is 3 or 4 or 5 ? dragSettings.Top + (height0 - finalHeight) : dragSettings.Top,
                };
                ApplyWindow();
            }
            if (drag >= 2) _ = SaveDragSettings();
            Begin("drag"); return 0;
        }
        if ((message is Native.WmLButtonUp or Native.WmRButtonUp) && drag != 0) { Native.ReleaseCapture(); if (drag >= 2) _ = client.SaveAsync(settings); drag = 0; return 0; }
        if (message == Native.WmMouseWheel) { var amount = (short)((long)wParam >> 16); var step = OverlayViewLimits.Zoom.Step; scene.Zoom = Math.Round((scene.Zoom + amount / 1200.0) / step) * step; scene.ClampZoom(); Begin("zoom"); return 0; }
        return null;
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true; loading.Cancel(); for (int id = 1; id <= HotkeyNames.Length; id++) Native.UnregisterHotKey(hwnd, id);
        client.Dispose(); tiles.Dispose(); markers.Dispose();
        if (svgWorker.Wait(1000)) { rasterizer.Dispose(); svgWorker.Release(); }
        renderer.Dispose(); OverlayDiagnostics.Shutdown();
    }
}
