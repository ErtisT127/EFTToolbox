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
                foreach (var p in new[] { b.MapDirectory, b.AssetDirectory, b.TileDirectory, b.PreferencesFile, b.AnnotationsDirectory, b.OverlaySettingsFile })
                    if (!Path.IsPathFullyQualified(p)) throw new InvalidDataException("Bootstrap path is not absolute");
                Bootstrap = b; Watch(b); OverlayDiagnostics.Connect(b.LogPipeName);
                using var socket = new ClientWebSocket();
                var ws = new UriBuilder(new Uri(http.BaseAddress!, b.WebsocketPath)) { Scheme = "ws", Query = "client=overlay" }.Uri;
                await socket.ConnectAsync(ws, stop.Token);
                OverlayDiagnostics.Log("info", "state_connected", "Backend WebSocket connected");
                Connected = true; delay = 250; wake();
                var buffer = new byte[65536];
                while (!stop.IsCancellationRequested)
                {
                    using var message = new MemoryStream();
                    using var heartbeat = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
                    heartbeat.CancelAfter(TimeSpan.FromSeconds(7));
                    WebSocketReceiveResult part;
                    do
                    {
                        part = await socket.ReceiveAsync(buffer, heartbeat.Token);
                        if (part.MessageType == WebSocketMessageType.Close) throw new IOException("WebSocket closed");
                        if (message.Length + part.Count > 16 * 1024 * 1024) throw new InvalidDataException("WebSocket message too large");
                        message.Write(buffer, 0, part.Count);
                    } while (!part.EndOfMessage);
                    var e = JsonSerializer.Deserialize<ServerEvent>(message.GetBuffer().AsSpan(0, (int)message.Length), OverlaySettingsStore.Json);
                    if (e is not null && e.Type != "heartbeat") { events.Enqueue(e); wake(); }
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
    internal async Task ReportAsync(OverlayView view)
    {
        try { using var response = await http.PutAsJsonAsync("api/overlay/state", view, stop.Token); response.EnsureSuccessStatusCode(); }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException) { OverlayDiagnostics.Log("warn", "state_report_failed", e.Message); }
    }
    internal async Task SaveAsync(OverlaySettings settings)
    {
        var entered = false;
        try {
            await saves.WaitAsync(stop.Token); entered = true;
            using var response = await http.PutAsJsonAsync("api/overlay-settings", settings, stop.Token); response.EnsureSuccessStatusCode();
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException) { OverlayDiagnostics.Log("error", "settings_save_failed", e.Message); }
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
