using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json;
using EFTToolbox.Contracts;

namespace EFTToolbox.Overlay;

internal sealed class OverlayStateClient : IDisposable
{
    private readonly HttpClient http;
    private readonly CancellationTokenSource stop = new();
    private readonly List<FileSystemWatcher> watchers = [];
    private readonly object watcherLock = new();
    private readonly SemaphoreSlim saves = new(1);
    private readonly Action wake;
    private readonly ConcurrentQueue<ServerEvent> events = new();
    private long fileChanged;
    private long resourcesChanged;
    private Task? worker;
    internal OverlayBootstrap? Bootstrap { get; private set; }
    internal bool Connected { get; private set; }
    internal OverlayStateClient(Uri address, Action wake)
    {
        if (!address.IsLoopback || address.Scheme != "http") throw new ArgumentException("Backend must be loopback HTTP");
        http = new HttpClient { BaseAddress = address, Timeout = TimeSpan.FromSeconds(10) };
        this.wake = wake;
    }
    internal void Start() => worker = Task.Run(RunAsync);
    internal bool TryRead(out ServerEvent? value) => events.TryDequeue(out value);
    internal bool ResourcesChanged => Interlocked.Exchange(ref resourcesChanged, 0) != 0;
    internal bool FilesChanged => Interlocked.Exchange(ref fileChanged, 0) != 0;
    internal async Task RefreshBootstrapAsync()
    {
        var b = await http.GetFromJsonAsync<OverlayBootstrap>("api/overlay/bootstrap", stop.Token) ?? throw new InvalidDataException("Empty bootstrap");
        foreach (var p in new[] { b.MapDirectory, b.AssetDirectory, b.TileDirectory, b.PreferencesFile, b.AnnotationsDirectory, b.OverlaySettingsFile, b.StickersFile })
            if (!Path.IsPathFullyQualified(p)) throw new InvalidDataException("Bootstrap path is not absolute");
        Bootstrap = b; Watch(b); Interlocked.Exchange(ref resourcesChanged, 1); wake();
    }
    /// <summary>The interface language lives in the aggregate user settings. A null result keeps
    /// the current one: the endpoint is unreachable exactly while the socket is down, and the next
    /// settings event retries.</summary>
    internal async Task<string?> GetLanguageAsync()
    {
        try
        {
            var settings = await http.GetFromJsonAsync<UserSettings>("api/user-settings", stop.Token);
            return string.IsNullOrEmpty(settings?.Language) ? null : settings.Language;
        }
        catch (Exception)
        {
            return null;
        }
    }
    private void Watch(OverlayBootstrap b)
    {
        lock (watcherLock)
        {
            if (stop.IsCancellationRequested) return;
            foreach (var w in watchers) w.Dispose(); watchers.Clear();
            foreach (var path in new[] { b.MapDirectory, b.AssetDirectory, b.AnnotationsDirectory, b.TileDirectory }.Distinct())
            {
                if (!Directory.Exists(path)) continue;
                var w = new FileSystemWatcher(path) { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName };
                void Changed(object? sender, FileSystemEventArgs e)
                {
                    if (path != b.AnnotationsDirectory) Interlocked.Exchange(ref resourcesChanged, 1);
                    Interlocked.Exchange(ref fileChanged, 1); wake();
                }
                w.Changed += Changed; w.Created += Changed; w.Deleted += Changed; w.Renamed += (s, e) => Changed(s, e);
                w.Error += (_, _) => { Interlocked.Exchange(ref fileChanged, 1); wake(); };
                w.EnableRaisingEvents = true; watchers.Add(w);
            }
        }
    }
    private async Task RunAsync()
    {
        var delay = 250;
        while (!stop.IsCancellationRequested)
        {
            try
            {
                var b = await http.GetFromJsonAsync<OverlayBootstrap>("api/overlay/bootstrap", stop.Token) ?? throw new InvalidDataException("Empty bootstrap");
                foreach (var p in new[] { b.MapDirectory, b.AssetDirectory, b.TileDirectory, b.PreferencesFile, b.AnnotationsDirectory, b.OverlaySettingsFile, b.StickersFile })
                    if (!Path.IsPathFullyQualified(p)) throw new InvalidDataException("Bootstrap path is not absolute");
                Bootstrap = b; Watch(b); OverlayDiagnostics.Connect(b.LogPipeName);
                using var socket = new ClientWebSocket();
                var ws = new UriBuilder(new Uri(http.BaseAddress!, b.WebsocketPath)) { Scheme = "ws", Query = "client=overlay" }.Uri;
                await socket.ConnectAsync(ws, stop.Token);
                OverlayDiagnostics.Log("info", "state_connected", "Backend WebSocket connected");
                Connected = true; delay = 250; wake();
                var buffer = new byte[65536];
                try
                {
                    while (!stop.IsCancellationRequested)
                    {
                        using var message = new MemoryStream();
                        using var heartbeat = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
                        heartbeat.CancelAfter(TimeSpan.FromSeconds(7));
                        WebSocketReceiveResult part;
                        do
                        {
                            part = await socket.ReceiveAsync(buffer, heartbeat.Token);
                            if (part.MessageType == WebSocketMessageType.Close) break;
                            if (message.Length + part.Count > 16 * 1024 * 1024) throw new InvalidDataException("WebSocket message too large");
                            message.Write(buffer, 0, part.Count);
                        } while (!part.EndOfMessage);
                        if (part.MessageType == WebSocketMessageType.Close) break;
                        var e = JsonSerializer.Deserialize<ServerEvent>(message.GetBuffer().AsSpan(0, (int)message.Length), OverlaySettingsStore.Json);
                        if (e is not null && e.Type != "heartbeat")
                        {
                            if (e.Type == "resources_changed")
                            {
                                try { await RefreshBootstrapAsync(); }
                                catch (Exception error) { OverlayDiagnostics.Log("warn", "bootstrap_refresh_failed", error.Message); }
                            }
                            events.Enqueue(e); wake();
                        }
                    }
                }
                finally
                {
                    if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                    {
                        using var close = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
                        try { await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "client shutting down", close.Token); } catch (Exception) { }
                    }
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
            catch (Exception error) { OverlayDiagnostics.Log("warn", "state_disconnected", error.Message); }
            finally { Connected = false; wake(); }
            try { await Task.Delay(delay, stop.Token); } catch (OperationCanceledException) { break; }
            delay = Math.Min(delay * 2, 5000);
        }
    }
    internal async Task<OverlaySettings> GetSettingsAsync() => await http.GetFromJsonAsync<OverlaySettings>("api/overlay-settings", stop.Token) ?? throw new InvalidDataException("Empty settings");
    // Tiles travel through the backend rather than off the disk: the pipeline only pre-downloads the
    // lowest zoom of each floor, and the server fetches the rest on demand — the same path the
    // dashboard's map uses, so both ends show the same imagery.
    internal async Task<byte[]> TileAsync(string url, CancellationToken token)
    {
        // Tiles are addressed relative to the backend. An absolute URL would be fetched from
        // whatever host the map data names, so only a path is allowed through.
        if (!url.StartsWith('/') || url.StartsWith("//")) throw new InvalidDataException("Tile url is not a backend path");
        using var response = await http.GetAsync(url, token);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound) throw new InvalidDataException("Tile is outside the layer bounds");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsByteArrayAsync(token);
    }
    internal async Task ReportAsync(OverlayView view)
    {
        try { using var response = await http.PutAsJsonAsync("api/overlay/state", view, stop.Token); response.EnsureSuccessStatusCode(); }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException) { OverlayDiagnostics.Log("warn", "state_report_failed", e.Message); }
    }
    internal async Task SaveAsync(OverlaySettings settings)
    {
        var entered = false;
        try
        {
            await saves.WaitAsync(stop.Token); entered = true;
            using var response = await http.PutAsJsonAsync("api/overlay-settings", settings, stop.Token); response.EnsureSuccessStatusCode();
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException) { OverlayDiagnostics.Log("error", "settings_save_failed", e.Message); }
        finally { if (entered) saves.Release(); }
    }
    internal async Task PostRecognitionResultAsync(RecognitionResult result)
    {
        try { using var response = await http.PostAsJsonAsync("api/recognition/result", result, OverlaySettingsStore.Json, stop.Token); response.EnsureSuccessStatusCode(); }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException) { OverlayDiagnostics.Log("warn", "recognition_result_failed", e.Message); }
    }
    /// <summary>A run starts by telling the backend, which clears the last result and puts both
    /// displays into their loading state before any pixel work happens.</summary>
    internal async Task PostRecognitionStartedAsync(string requestId, CancellationToken? token = null)
    {
        try { using var response = await http.PostAsJsonAsync("api/recognition/started", new RecognitionStart { RequestId = requestId }, OverlaySettingsStore.Json, token ?? stop.Token); response.EnsureSuccessStatusCode(); }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException) { OverlayDiagnostics.Log("warn", "recognition_started_failed", e.Message); }
    }
    /// <summary>The candidate shortlist per OCR text, resolved by the backend so the name and
    /// short-name rules stay in one place.</summary>
    internal async Task<RecognitionCandidates?> CandidatesAsync(string[] texts, CancellationToken token)
    {
        try
        {
            using var response = await http.PostAsJsonAsync("api/recognition/candidates", new RecognitionCandidateRequest { Texts = texts }, OverlaySettingsStore.Json, token);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadFromJsonAsync<RecognitionCandidates>(OverlaySettingsStore.Json, token);
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException) { OverlayDiagnostics.Log("warn", "recognition_candidates_failed", e.Message); return null; }
    }
    /// <summary>Item artwork for the icon check and the result table, fetched once per url.</summary>
    internal async Task<byte[]?> AssetAsync(string url, CancellationToken token)
    {
        if (!url.StartsWith('/') || url.StartsWith("//")) return null;
        try
        {
            using var response = await http.GetAsync(url, token);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadAsByteArrayAsync(token);
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException) { OverlayDiagnostics.Log("warn", "recognition_asset_failed", $"{url}: {e.Message}"); return null; }
    }
    internal async Task SaveRecognitionAsync(RecognitionSettings settings)
    {
        var entered = false;
        try
        {
            await saves.WaitAsync(stop.Token); entered = true;
            using var response = await http.PutAsJsonAsync("api/recognition-settings", settings, stop.Token); response.EnsureSuccessStatusCode();
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException) { OverlayDiagnostics.Log("error", "recognition_settings_save_failed", e.Message); }
        finally { if (entered) saves.Release(); }
    }
    internal static T? Read<T>(string path) => JsonSerializer.Deserialize<T>(File.ReadAllBytes(path), OverlaySettingsStore.Json);
    public void Dispose()
    {
        stop.Cancel();
        lock (watcherLock) { foreach (var w in watchers) w.Dispose(); watchers.Clear(); }
        try { worker?.Wait(1000); } catch (AggregateException) { }
        http.Dispose(); stop.Dispose();
    }
}
