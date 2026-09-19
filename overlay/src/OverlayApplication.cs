using System.Collections.Concurrent;
using System.Diagnostics;
using System.Numerics;
using System.Runtime.InteropServices;
using EFTToolbox.Contracts;
using Point = EFTToolbox.Contracts.Point;

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
    private int resourceDirty;
    private bool wasVisible;
    private bool dirty = true, editing, disposed;
    private Operation? operation;
    private bool loadingScene;
    private long nextFrame, lastFiles, lastReport;
    private bool resourceFilesChanged;
    private string error = "";
    private string resourceKey = "";
    private int drag;
    private Native.CursorPoint dragStart;
    private OverlaySettings dragSettings = OverlaySettingsStore.Defaults;
    private Vector2 dragCenter;
    internal bool Editing => editing;
    internal OverlayApplication(nint hwnd, Uri backend)
    {
        this.hwnd = hwnd; client = new(backend, Wake); tiles = new(ResourceReady); markers = new(ResourceReady);
        renderer.Initialize(hwnd); ApplyWindow(); client.Start();
    }
    private void ResourceReady() { Interlocked.Exchange(ref resourceDirty, 1); Wake(); }
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
        if (!settings.Visible && wasVisible) {
            tiles.Clear(); markers.CancelPending(); loading.Cancel();
            if (loadingScene || error == "errors.overlay_resource_failed") resourceKey = "";
            loadingScene = false;
        }
        if (settings.Visible && !wasVisible) LoadResources();
        wasVisible = settings.Visible;
        scene.Width = width; scene.Height = height; scene.ClampZoom(); renderer.Resize(width, height); dirty = true;
    }
    internal static OverlaySettings ClampWindow(OverlaySettings value, Native.Rect monitor)
    {
        var width = Math.Min(value.Width, monitor.Right - monitor.Left);
        var height = Math.Min(value.Height, monitor.Bottom - monitor.Top);
        if (value.Shape == "circle") width = height = Math.Min(width, height);
        else if (value.LockAspect) {
            var scale = Math.Min((double)width / value.Width, (double)height / value.Height);
            width = Math.Max(1, (int)Math.Floor(value.Width * scale));
            height = Math.Max(1, (int)Math.Floor(value.Height * scale));
        }
        return value with { Width = width, Height = height, Left = Math.Clamp(value.Left, monitor.Left, monitor.Right - width), Top = Math.Clamp(value.Top, monitor.Top, monitor.Bottom - height) };
    }
    private void Hotkeys()
    {
        for (int id = 1; id <= 2; id++) Native.UnregisterHotKey(hwnd, id);
        hotkeyCount = 0;
        int index = 0;
        foreach (var value in new[] { settings.Hotkeys.ToggleEdit, settings.Hotkeys.ToggleVisible })
        {
            index++; if (string.IsNullOrWhiteSpace(value)) continue;
            var parts = value.Split('+'); uint modifiers = 0x4000;
            foreach (var part in parts[..^1]) modifiers |= part switch { "Alt" => 1u, "Ctrl" => 2u, "Shift" => 4u, "Win" => 8u, _ => 0 };
            var key = parts[^1]; uint vk = key.Length == 1 ? key[0] : key.StartsWith('F') && int.TryParse(key[1..], out var f) ? (uint)(111 + f) : key switch { "Space" => 32u, "Insert" => 45u, "Delete" => 46u, "Home" => 36u, "End" => 35u, "PageUp" => 33u, "PageDown" => 34u, _ => 0 };
            if (vk == 0 || !Native.RegisterHotKey(hwnd, index, modifiers, vk)) { error = "errors.overlay_hotkey_unavailable"; OverlayDiagnostics.Log("error", "hotkey_failed", $"Hotkey unavailable: {value}"); }
            else hotkeyCount++;
        }
    }
    private void ApplySettings(OverlaySettings value)
    {
        var old = settings; settings = OverlaySettingsStore.Clamp(value); error = "";
        if (old.Hotkeys != settings.Hotkeys) Hotkeys();
        ApplyWindow(); Begin("settings");
        if (settings.Left != value.Left || settings.Top != value.Top || settings.Width != value.Width || settings.Height != value.Height) _ = client.SaveAsync(settings);
        if (old.SvgResolution != settings.SvgResolution) LoadResources();
    }
    private void Select(Preferences next, bool force = false)
    {
        var selectionChanged = preferences.SelectedMap != next.SelectedMap;
        var p = next.Maps.FirstOrDefault(p => p.MapId == next.SelectedMap); preferences = next;
        if (p is null) return;
        if (scene.Map?.Id != next.SelectedMap) { if (scene.Map is null || selectionChanged || force) LoadMap(next.SelectedMap, p); return; }
        var old = scene.Preference; scene.Preference = p;
        if (force || old.FloorId != p.FloorId) scene.Floor = p.FloorId;
        if (force || old.Basemap != p.Basemap) scene.Basemap = p.Basemap;
        if (force || !old.Center.SequenceEqual(p.Center)) if (p.Center.Length == 2) scene.Center = new((float)p.Center[1], (float)-p.Center[0]);
        if (force || old.Zoom != p.Zoom) scene.Zoom = p.Zoom;
        scene.ClampZoom(); Begin("dashboard"); LoadResources();
    }
    private void LoadMap(string id, MapPreference? preference = null, bool follow = false, bool preserveView = false)
    {
        var keepView = preserveView && scene.Map?.Id == id;
        var previousView = (scene.Center, scene.Zoom, scene.Floor, scene.Basemap);
        if (bootstrap is null) return; loading.Cancel(); loading.Dispose(); loading = new(); var token = loading.Token; var version = ++generation;
        tiles.Clear(); renderer.Tiles.Clear(); renderer.Svg.Clear(); resourceKey = ""; scene.Map = null; loadingScene = true; Begin("map", resources: true);
        var b = bootstrap;
        _ = Task.Run(() =>
        {
            try
            {
                var map = OverlayStateClient.Read<MapData>(Path.Combine(b.MapDirectory, id + ".json")) ?? throw new InvalidDataException("Empty map");
                var annotations = ReadAnnotations(b, id);
                token.ThrowIfCancellationRequested();
                completions.Enqueue(() =>
                {
                    if (version != generation) return;
                    scene.Map = map; scene.Preference = preference ?? preferences.Maps.FirstOrDefault(p => p.MapId == id) ?? new MapPreference { MapId = id, FloorId = map.DefaultFloor, Basemap = map.SvgUrl != "" ? "svg" : "tiles", ShowAnnotations = true };
                    scene.Floor = scene.Preference.FloorId; scene.Basemap = scene.Preference.Basemap; scene.Annotations = annotations;
                    if (keepView) {
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
    private void LoadResources(bool force = false)
    {
        if (scene.Map is null || bootstrap is null || !settings.Visible) return;
        var map = scene.Map; var floor = scene.Floor; var raster = scene.Basemap == "tiles";
        var key = $"{map.Id}:{floor}:{raster}:{settings.SvgResolution}";
        if (!force && key == resourceKey) return;
        var keep = resourceKey.StartsWith($"{map.Id}:{floor}:{raster}:", StringComparison.Ordinal);
        resourceKey = key; var version = ++generation; loading.Cancel(); loading.Dispose(); loading = new(); var token = loading.Token;
        tiles.Clear(); renderer.Tiles.Clear(); if (!keep) renderer.Svg.Clear();
        Begin("resources", resources: true);
        if (map.SvgUrl == "" || (raster && map.Tiles.Any(t => t.FloorId == floor))) { loadingScene = false; return; }
        loadingScene = true; var path = Path.Combine(bootstrap.AssetDirectory, Path.GetFileName(map.SvgUrl)); var resolution = settings.SvgResolution; var op = operation; var queued = Stopwatch.GetTimestamp();
        _ = Task.Run(async () =>
        {
            var entered = false;
            try
            {
                await svgWorker.WaitAsync(token); entered = true; var queueMs = Stopwatch.GetElapsedTime(queued).TotalMilliseconds; var image = rasterizer.Rasterize(path, resolution, map, floor, raster); token.ThrowIfCancellationRequested();
                completions.Enqueue(() =>
                {
                    if (version != generation) return;
                    var timer = Stopwatch.StartNew(); renderer.Svg.Put("map", image);
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
    private void FollowSelf()
    {
        var player = scene.Players.Values.FirstOrDefault(p => p.IsSelf); if (player is null) return;
        if (settings.FollowCenter && player.MapId != scene.Map?.Id) { LoadMap(player.MapId, follow: true); return; }
        if (player.MapId != scene.Map?.Id) return;
        if (settings.FollowCenter) scene.Center = new((float)player.Position.X, (float)player.Position.Y);
        if (settings.FollowFloor) scene.Floor = player.FloorId;
        if (settings.FollowZoom) scene.Zoom = settings.PerMapZoom ? settings.MapZooms.FirstOrDefault(z => z.MapId == player.MapId)?.Zoom ?? settings.TargetZoom : settings.TargetZoom;
        scene.ClampZoom(); LoadResources();
    }
    private void Event(ServerEvent e)
    {
        if (e.Type == "overlay_status") return;
        var nextPreference = e.Preferences?.Maps.FirstOrDefault(p => p.MapId == e.Preferences.SelectedMap);
        var replacesResources = e.Preferences is {} next && next.SelectedMap != preferences.SelectedMap
            || nextPreference is {} view && (view.FloorId != scene.Preference.FloorId || view.Basemap != scene.Preference.Basemap)
            || e.OverlaySettings is {} options && options.SvgResolution != settings.SvgResolution
            || e.OverlayCommand?.FloorId is {} floor && floor != scene.Floor
            || e.Player is { IsSelf: true } self && (settings.FollowCenter && self.MapId != scene.Map?.Id || settings.FollowFloor && self.FloorId != scene.Floor);
        if (replacesResources) operation = null;
        Begin(e.Type, e.OperationId);
        if (e.OverlaySettings is { } s) ApplySettings(s);
        if (e.Preferences is { } p) Select(p);
        if (e.Type == "snapshot")
        {
            lastView = null;
            var previousSelf = scene.Players.Values.FirstOrDefault(p => p.IsSelf);
            scene.Players.Clear(); foreach (var player in e.Players ?? []) scene.Players[player.PlayerId] = player;
            if (scene.Players.Values.FirstOrDefault(p => p.IsSelf) is {} snapshotSelf && PositionChanged(previousSelf, snapshotSelf)) FollowSelf();
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
            if (command.Kind == "edit") { editing = command.Enabled ?? false; if (editing) settings = settings with { Visible = true }; ApplyWindow(); }
            if (command.Kind == "visible") { settings = settings with { Visible = command.Enabled ?? false }; ApplyWindow(); _ = client.SaveAsync(settings); }
            if (command.Kind == "view") { if (command.Center is { } c) scene.Center = new((float)c.X, (float)c.Y); if (command.Zoom is { } z) scene.Zoom = z; if (command.FloorId is { } f) scene.Floor = f; scene.ClampZoom(); LoadResources(); }
        }
    }
    private static bool PositionChanged(PlayerState? previous, PlayerState current) => previous is null
        || previous.PlayerId != current.PlayerId || previous.IsSelf != current.IsSelf
        || previous.Position != current.Position || previous.MapId != current.MapId || previous.FloorId != current.FloorId;
    internal void Tick()
    {
        if (Interlocked.Exchange(ref resourceDirty, 0) != 0) dirty = true;
        if (client.Bootstrap is { } b && b != bootstrap)
        {
            var previous = bootstrap;
            bootstrap = b; markers.SetAssets(b.AssetDirectory); renderer.Images.Clear();
            _ = Task.Run(() => { try { tiles.SetManifest(b.TileManifestFile); } catch (Exception e) { OverlayDiagnostics.Log("warn", "tile_manifest_failed", e.Message); } Wake(); });
            if (previous is not null && scene.Map is {} map) LoadMap(map.Id, scene.Preference, preserveView: true);
        }
        while (client.TryRead(out var e)) if (e is not null) Event(e);
        while (completions.TryDequeue(out var complete)) { complete(); dirty = true; }
        var now = Environment.TickCount64;
        if (client.FilesChanged) { lastFiles = now; resourceFilesChanged |= client.ResourcesChanged; }
        if (lastFiles != 0 && now - lastFiles >= 150)
        {
            lastFiles = 0; var b2 = bootstrap; var reloadResources = resourceFilesChanged; resourceFilesChanged = false;
            if (b2 is not null) {
                var currentId = scene.Map?.Id;
                _ = Task.Run(async () => {
                    try {
                        var p = File.Exists(b2.PreferencesFile) ? OverlayStateClient.Read<Preferences>(b2.PreferencesFile) : null;
                        var saved = await client.GetSettingsAsync();
                        var annotations = currentId is null ? [] : ReadAnnotations(b2, currentId);
                        if (reloadResources) tiles.SetManifest(b2.TileManifestFile);
                        completions.Enqueue(() => {
                            if (bootstrap != b2) return;
                            if (p is not null) Select(p);
                            if (System.Text.Json.JsonSerializer.Serialize(saved) != System.Text.Json.JsonSerializer.Serialize(settings)) ApplySettings(saved);
                            if (scene.Map?.Id == currentId) scene.Annotations = annotations;
                            if (reloadResources) {
                                markers.SetAssets(b2.AssetDirectory); renderer.Images.Clear();
                                if (scene.Map is {} map) LoadMap(map.Id, scene.Preference, preserveView: true);
                            }
                        }); Wake();
                    } catch (Exception ex) { OverlayDiagnostics.Log("warn", "file_reload_failed", ex.Message); }
                });
            }
        }
        if (dirty && settings.Visible && now >= nextFrame)
        {
            markers.Upload(renderer.Images); tiles.Upload(renderer.Tiles);
            if (bootstrap is { } b3) tiles.Update(scene, b3.TileDirectory, renderer.Tiles, operation);
            var timer = Stopwatch.StartNew(); renderer.Render(scene, markers, tiles, settings.Shape == "circle", editing, operation); renderCount++;
            if (operation is { } op) { op.Timing = op.Timing with { DrawMs = renderer.LastDrawMs, PresentMs = renderer.LastPresentMs }; if (!loadingScene && !tiles.Loading) { op.Complete(op.ResourceLoad); operation = null; } }
            dirty = false; nextFrame = now + 17;
        }
        if (!settings.Visible) operation = null;
        if (now - lastReport > 250)
        {
            var view = new OverlayView { MapId = scene.Map?.Id ?? "", FloorId = scene.Floor, Center = new Point { X = scene.Center.X, Y = scene.Center.Y }, Zoom = scene.Zoom, Editing = editing, Visible = settings.Visible, Connected = client.Connected, Error = error, RenderCount = renderCount, SvgParseCount = rasterizer.ParseCount, SvgRasterCount = rasterizer.RasterCount, TextureBytes = (int)(renderer.Svg.Bytes + renderer.Tiles.Bytes + renderer.Images.Bytes), HotkeyCount = hotkeyCount };
            if (view != lastView) { lastView = view; _ = client.ReportAsync(view); }
            lastReport = now;
        }
    }
    private OverlayView? lastView;
    internal uint WaitMilliseconds => (dirty && settings.Visible) || lastFiles != 0 ? 16u : 250u;
    internal nint? Message(uint message, nuint wParam, nint lParam)
    {
        if (message == 0x8001) return 0;
        if (message is Native.WmDpiChanged or Native.WmDisplayChange) { ApplyWindow(); _ = client.SaveAsync(settings); return 0; }
        if (message == 0x0312) { if (wParam == 1) { editing = !editing; ApplyWindow(); } else { settings = settings with { Visible = !settings.Visible }; ApplyWindow(); _ = client.SaveAsync(settings); } Begin("hotkey"); return 0; }
        if (message == Native.WmNcHitTest)
        {
            if (!editing) return -1;
            if (settings.Shape == "circle") { var x = (short)((long)lParam & 65535) - settings.Left - settings.Width / 2f; var y = (short)(((long)lParam >> 16) & 65535) - settings.Top - settings.Height / 2f; if (x * x + y * y > Math.Pow(settings.Width / 2f, 2)) return -1; }
            return 1;
        }
        if (!editing) return null;
        var local = new Vector2((short)((long)lParam & 65535), (short)(((long)lParam >> 16) & 65535));
        if (message == 0x0201)
        {
            Native.GetCursorPos(out dragStart); dragSettings = settings; dragCenter = scene.Center;
            var edge = Math.Min(Math.Min(local.X, local.Y), Math.Min(settings.Width - local.X, settings.Height - local.Y));
            drag = local.X > settings.Width - 20 && local.Y > settings.Height - 20 ? 3 : edge < 12 ? 2 : 1;
            if (settings.Shape == "circle" && Vector2.Distance(local, new(settings.Width / 2f, settings.Height / 2f)) > settings.Width / 2f - 15) drag = local.X > settings.Width - 24 ? 3 : 2;
            Native.SetCapture(hwnd); return 0;
        }
        if (message == 0x0200 && drag != 0)
        {
            Native.GetCursorPos(out var cursor); var delta = new Vector2(cursor.X - dragStart.X, cursor.Y - dragStart.Y);
            if (drag == 1) scene.Center = dragCenter - delta / scene.Scale;
            if (drag == 2) { settings = dragSettings with { Left = dragSettings.Left + (int)delta.X, Top = dragSettings.Top + (int)delta.Y }; ApplyWindow(); }
            if (drag == 3) {
                var width = Math.Clamp(dragSettings.Width + (int)delta.X, 160, 2048);
                var height = Math.Clamp(dragSettings.Height + (int)delta.Y, 160, 2048);
                if (settings.LockAspect || settings.Shape == "circle") {
                    var factor = Math.Clamp((double)width / dragSettings.Width, Math.Max(160.0 / dragSettings.Width, 160.0 / dragSettings.Height), Math.Min(2048.0 / dragSettings.Width, 2048.0 / dragSettings.Height));
                    width = (int)Math.Round(dragSettings.Width * factor); height = (int)Math.Round(dragSettings.Height * factor);
                }
                settings = settings with { Width = width, Height = height }; ApplyWindow();
            }
            Begin("drag"); return 0;
        }
        if (message == 0x0202 && drag != 0) { Native.ReleaseCapture(); if (drag >= 2) _ = client.SaveAsync(settings); drag = 0; return 0; }
        if (message == 0x020a) { var amount = (short)((long)wParam >> 16); scene.Zoom += amount / 1200.0; scene.ClampZoom(); Begin("zoom"); return 0; }
        return null;
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true; loading.Cancel(); for (int id = 1; id <= 2; id++) Native.UnregisterHotKey(hwnd, id);
        client.Dispose(); tiles.Dispose();
        if (svgWorker.Wait(1000)) { rasterizer.Dispose(); svgWorker.Release(); }
        renderer.Dispose(); OverlayDiagnostics.Shutdown();
    }
}
