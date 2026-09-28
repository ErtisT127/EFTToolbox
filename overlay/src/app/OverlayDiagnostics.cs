using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using EFTToolbox.Contracts;

namespace EFTToolbox.Overlay;

internal static class OverlayDiagnostics
{
    private static readonly Channel<OverlayLog> Queue = Channel.CreateBounded<OverlayLog>(256);
    private static readonly CancellationTokenSource Stop = new();
    private static readonly Task Worker = Task.Run(SendAsync);
    private static string pipe = "";
    private static long dropped;
    internal static void Connect(string name) => Volatile.Write(ref pipe, name);
    internal static void Log(string level, string kind, string message, Operation? operation = null, string resource = "")
    {
        var value = new OverlayLog { Time = DateTime.UtcNow.ToString("O"), Level = level, Component = "overlay", Event = kind, Message = message, OperationId = operation?.Id, Source = operation?.Source, MapId = operation?.MapId, FloorId = operation?.FloorId, Basemap = operation?.Basemap, Generation = operation?.Generation, Resolution = operation?.Resolution, Resource = resource, Timing = operation?.Timing };
        if (!Queue.Writer.TryWrite(value)) {
            Interlocked.Increment(ref dropped);
            if (level is "error" or "warn") { Queue.Reader.TryRead(out _); Queue.Writer.TryWrite(value); }
        }
    }
    private static async Task SendAsync()
    {
        OverlayLog? pending = null;
        while (!Stop.IsCancellationRequested)
        {
            try
            {
                var name = Volatile.Read(ref pipe);
                if (name.Length == 0) { await Task.Delay(250, Stop.Token); continue; }
                using var client = new NamedPipeClientStream(".", name, PipeDirection.Out, PipeOptions.Asynchronous);
                await client.ConnectAsync(1000, Stop.Token);
                using var writer = new StreamWriter(client, new UTF8Encoding(false)) { AutoFlush = true };
                while (!Stop.IsCancellationRequested && name == Volatile.Read(ref pipe))
                {
                    pending ??= await Queue.Reader.ReadAsync(Stop.Token);
                    await writer.WriteLineAsync(JsonSerializer.Serialize(pending).AsMemory(), Stop.Token); pending = null;
                    var lost = Interlocked.Exchange(ref dropped, 0);
                    if (lost > 0) Log("warn", "logs_dropped", $"Dropped {lost} records while logging was unavailable");
                }
            }
            catch (Exception e) when (e is IOException or TimeoutException or OperationCanceledException or ChannelClosedException)
            {
                if (pending?.Level is "warn" or "error") Console.Error.WriteLine(JsonSerializer.Serialize(pending));
                if (Stop.IsCancellationRequested || e is ChannelClosedException) break; try { await Task.Delay(500, Stop.Token); } catch (OperationCanceledException) { break; } }
        }
    }
    internal static void Shutdown()
    {
        Operation.FlushWarnings();
        Log("info", "stopped", "Native overlay stopped");
        Stop.Cancel();
        Queue.Writer.TryComplete();
        try { Worker.Wait(500); } catch (AggregateException) { }
    }
}

internal sealed class Operation(string source, string mapId, string floorId, string basemap, int generation, int resolution, string? id = null, long startedAt = 0)
{
    private static readonly Dictionary<string, (long Time, int Count, Operation? Worst)> LastWarning = new();
    internal long Started { get; } = startedAt == 0 ? Stopwatch.GetTimestamp() : startedAt;
    internal bool ResourceLoad { get; set; }
    private double slowest;
    internal string Id { get; } = id ?? Guid.NewGuid().ToString("N");
    internal string Source { get; } = source;
    internal string MapId { get; } = mapId;
    internal string FloorId { get; } = floorId;
    internal string Basemap { get; } = basemap;
    internal int Generation { get; } = generation;
    internal int Resolution { get; } = resolution;
    private readonly object timingGate = new();
    private OperationTiming timing = new();
    internal OperationTiming Timing { get { lock (timingGate) return timing; } }
    internal void UpdateTiming(Func<OperationTiming, OperationTiming> update) { lock (timingGate) timing = update(timing); }
    internal void Resource(string path, double queue, double read, double decode, double upload)
    {
        var total = queue + read + decode + upload;
        lock (timingGate)
        {
            timing = timing with { QueueMs = timing.QueueMs + queue, ReadMs = timing.ReadMs + read, RasterMs = timing.RasterMs + decode, UploadMs = timing.UploadMs + upload, Count = timing.Count + 1, Resource = total > slowest ? path : timing.Resource };
            slowest = Math.Max(slowest, total);
        }
    }
    internal void Complete(bool loading)
    {
        UpdateTiming(value => value with { TotalMs = Stopwatch.GetElapsedTime(Started).TotalMilliseconds });
        var snapshot = Timing;
        if (snapshot.TotalMs <= (loading ? 2000 : 100)) return;
        var key = $"{Source}:{MapId}"; var now = Environment.TickCount64;
        LastWarning.TryGetValue(key, out var previous);
        if (previous.Time != 0 && now - previous.Time < 30000) {
            LastWarning[key] = (previous.Time, previous.Count + 1, snapshot.TotalMs > (previous.Worst?.Timing.TotalMs ?? 0) ? this : previous.Worst);
            return;
        }
        if (previous.Count > 0 && previous.Worst is {} worst) Summary(worst, previous.Count);
        LastWarning[key] = (now, 0, this);
        OverlayDiagnostics.Log("warn", "slow_operation", $"{Source} took {snapshot.TotalMs:F1} ms", this, snapshot.Resource);
    }
    private static void Summary(Operation worst, int suppressed) => OverlayDiagnostics.Log("warn", "slow_operation_summary", $"{suppressed + 1} slow operations; worst={worst.Timing.TotalMs:F1} ms", worst, worst.Timing.Resource);
    internal static void FlushWarnings()
    {
        foreach (var entry in LastWarning.Values) if (entry.Count > 0 && entry.Worst is {} worst) Summary(worst, entry.Count);
        LastWarning.Clear();
    }
}
