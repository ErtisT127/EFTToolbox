using System.Diagnostics;
using Vortice.Direct3D;
using Vortice.Direct3D11;

namespace EFTToolbox.Overlay;

internal static class SvgRuntimeBenchmark
{
    internal static void Run(string root, int resolution = 2048)
    {
        if (resolution is not (1024 or 2048 or 4096 or 8192)) throw new ArgumentOutOfRangeException(nameof(resolution));
        D3D11.D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.BgraSupport, [FeatureLevel.Level_11_0], out ID3D11Device device, out ID3D11DeviceContext context).CheckError();
        using (device) using (context) using (var textures = new TextureCache(device, 1, 512L << 20)) using (var rasterizer = new SvgRasterizer())
        {
            var assets = Path.Combine(root, "data", "upstream", "assets", "maps", "svg");
            foreach (var file in Directory.EnumerateFiles(assets, "*.svg").Where(p => new FileInfo(p).Length > 10000).Order())
            {
                var image = Task.Run(() => rasterizer.Rasterize(file, resolution)).GetAwaiter().GetResult();
                var timer = Stopwatch.StartNew(); textures.Put("map", image); timer.Stop();
                var parses = rasterizer.ParseCount; var rasters = rasterizer.RasterCount; var scene = new MapScene();
                for (int i = 0; i < 1000; i++) { scene.Center = new(i, i); scene.Zoom = i % 8; _ = scene.Screen(System.Numerics.Vector2.One); }
                if (parses != rasterizer.ParseCount || rasters != rasterizer.RasterCount) throw new InvalidOperationException("Viewport rerasterized SVG");
                using var process = Process.GetCurrentProcess(); process.Refresh();
                Console.WriteLine($"SVG {Path.GetFileName(file)} {image.Width}x{image.Height}: parse={image.ParseMs:F2}ms raster={image.RasterMs:F2}ms upload={timer.Elapsed.TotalMilliseconds:F2}ms peakWorkingSet={process.PeakWorkingSet64} textureBytes={textures.Bytes} panZoomRasters=0");
            }
        }
    }
}
