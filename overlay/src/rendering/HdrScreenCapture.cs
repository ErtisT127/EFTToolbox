using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Vortice.D3DCompiler;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;

namespace EFTToolbox.Overlay;

internal static class HdrScreenCapture
{
    private const int DxgiErrorWaitTimeout = unchecked((int)0x887A0027);
    private const int DxgiErrorAccessLost = unchecked((int)0x887A0026);
    private static readonly Format[] Formats = [Format.R16G16B16A16_Float, Format.B8G8R8A8_UNorm];

    internal static Bitmap? TryCapture(Rectangle rect)
    {
        try
        {
            using var output = FindOutput(rect);
            if (output is null || !IsHdr(output.Description.ColorSpace))
            {
                OverlayDiagnostics.Log("info", "recognition_capture_sdr", "Using GDI screen capture (SDR output or unavailable DXGI output)");
                return null;
            }

            var whiteLevel = GetSdrWhiteLevel(output.Description.DeviceName);
            for (var attempt = 0; attempt < 2; attempt++)
            {
                try
                {
                    var bitmap = Capture(output, rect, whiteLevel);
                    OverlayDiagnostics.Log("info", "recognition_capture_hdr", $"Captured with DXGI duplication; SDR white={whiteLevel} (1000ths of 80 nits)");
                    return bitmap;
                }
                catch (SharpGen.Runtime.SharpGenException error) when (error.HResult == DxgiErrorAccessLost && attempt == 0)
                {
                    OverlayDiagnostics.Log("warn", "recognition_capture_hdr_retry", "DXGI duplication access was lost; rebuilding capture session");
                }
            }
            OverlayDiagnostics.Log("warn", "recognition_capture_hdr_fallback", "DXGI duplication failed; using GDI screen capture");
        }
        catch (Exception error)
        {
            OverlayDiagnostics.Log("warn", "recognition_capture_hdr_fallback", $"{error.Message}; using GDI screen capture");
        }
        return null;
    }

    private static Bitmap Capture(OutputSelection output, Rectangle rect, uint whiteLevel)
    {
        D3D11.D3D11CreateDevice(output.Adapter, DriverType.Unknown, DeviceCreationFlags.BgraSupport,
            [FeatureLevel.Level_11_0], out ID3D11Device device, out ID3D11DeviceContext context).CheckError();
        using (device)
        using (context)
        using (var output5 = output.Output.QueryInterface<IDXGIOutput5>())
        using (var duplication = output5.DuplicateOutput1(device, 0, Formats))
        {
            IDXGIResource? resource = null;
            var acquired = false;
            try
            {
                for (var retry = 0; retry < 3; retry++)
                {
                    try
                    {
                        duplication.AcquireNextFrame(50, out _, out resource!);
                        acquired = true;
                        break;
                    }
                    catch (SharpGen.Runtime.SharpGenException error) when (error.HResult == DxgiErrorWaitTimeout && retry < 2) { }
                }
                if (!acquired) throw new TimeoutException("No desktop frame arrived within 150 ms");
                using (var desktop = resource!.QueryInterface<ID3D11Texture2D>())
                {
                    var source = desktop.Description;
                    if ((int)output.Description.Rotation != 1)
                        throw new NotSupportedException("Rotated desktop duplication outputs are not supported");
                    if (source.Format is not (Format.R16G16B16A16_Float or Format.B8G8R8A8_UNorm))
                        throw new NotSupportedException($"Unsupported desktop duplication format: {source.Format}");
                    var left = rect.Left - output.Description.DesktopCoordinates.Left;
                    var top = rect.Top - output.Description.DesktopCoordinates.Top;
                    if (left < 0 || top < 0 || left + rect.Width > source.Width || top + rect.Height > source.Height)
                        throw new ArgumentOutOfRangeException(nameof(rect), "Capture region is outside the duplication texture");
                    var cropDescription = new Texture2DDescription
                    {
                        Width = (uint)rect.Width, Height = (uint)rect.Height, MipLevels = 1, ArraySize = 1,
                        Format = source.Format, SampleDescription = new SampleDescription(1, 0),
                        Usage = ResourceUsage.Default, BindFlags = source.Format == Format.B8G8R8A8_UNorm ? BindFlags.None : BindFlags.ShaderResource
                    };
                    using var crop = device.CreateTexture2D(cropDescription);
                    context.CopySubresourceRegion(crop, 0, 0, 0, 0, desktop, 0,
                        new Box(left, top, 0, left + rect.Width, top + rect.Height, 1));
                    return source.Format == Format.B8G8R8A8_UNorm
                        ? ReadBitmap(device, context, crop, rect.Width, rect.Height)
                        : ConvertScRgb(device, context, crop, rect.Width, rect.Height, whiteLevel);
                }
            }
            finally
            {
                try { resource?.Dispose(); }
                finally { if (acquired) duplication.ReleaseFrame(); }
            }
        }
    }

    private static Bitmap ConvertScRgb(ID3D11Device device, ID3D11DeviceContext context, ID3D11Texture2D source,
        int width, int height, uint whiteLevel)
    {
        using var view = device.CreateShaderResourceView(source);
        var targetDescription = new Texture2DDescription
        {
            Width = (uint)width, Height = (uint)height, MipLevels = 1, ArraySize = 1,
            Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Default, BindFlags = BindFlags.RenderTarget
        };
        using var target = device.CreateTexture2D(targetDescription);
        using var renderTarget = device.CreateRenderTargetView(target);
        using var staging = CreateStaging(device, width, height, Format.B8G8R8A8_UNorm);
        var shader = $$"""
            Texture2D image : register(t0);
            float4 VS(uint id : SV_VertexID) : SV_POSITION {
                float2 p = float2((id << 1) & 2, id & 2);
                return float4(p * float2(2, -2) + float2(-1, 1), 0, 1);
            }
            float4 PS(float4 position : SV_POSITION) : SV_TARGET {
                float3 linear = max(image.Load(int3(position.xy, 0)).rgb, 0) * (1000.0 / {{Math.Max(1, whiteLevel)}});
                linear = saturate(linear);
                float3 high = 1.055 * pow(linear, 1.0 / 2.4) - 0.055;
                float3 srgb = lerp(high, linear * 12.92, 1 - step(0.0031308, linear));
                return float4(srgb, 1);
            }
            """;
        var vertex = Compiler.Compile(shader, "VS", "hdr_capture", "vs_5_0");
        var pixel = Compiler.Compile(shader, "PS", "hdr_capture", "ps_5_0");
        using var vertexShader = device.CreateVertexShader(vertex.Span);
        using var pixelShader = device.CreatePixelShader(pixel.Span);
        context.OMSetRenderTargets(renderTarget);
        context.RSSetViewport(0, 0, width, height);
        context.IASetPrimitiveTopology(PrimitiveTopology.TriangleList);
        context.VSSetShader(vertexShader);
        context.PSSetShader(pixelShader);
        context.PSSetShaderResource(0, view);
        context.Draw(3, 0);
        context.PSSetShaderResource(0, null!);
        context.OMSetRenderTargets(Array.Empty<ID3D11RenderTargetView>());
        context.CopyResource(staging, target);
        return ReadMapped(context, staging, width, height);
    }

    private static Bitmap ReadBitmap(ID3D11Device device, ID3D11DeviceContext context, ID3D11Texture2D source, int width, int height)
    {
        using var staging = CreateStaging(device, width, height, Format.B8G8R8A8_UNorm);
        context.CopyResource(staging, source);
        return ReadMapped(context, staging, width, height);
    }

    private static ID3D11Texture2D CreateStaging(ID3D11Device device, int width, int height, Format format) => device.CreateTexture2D(new Texture2DDescription
    {
        Width = (uint)width, Height = (uint)height, MipLevels = 1, ArraySize = 1, Format = format,
        SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Staging,
        BindFlags = BindFlags.None, CPUAccessFlags = CpuAccessFlags.Read
    });

    private static unsafe Bitmap ReadMapped(ID3D11DeviceContext context, ID3D11Texture2D staging, int width, int height)
    {
        var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        var data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
        try
        {
            context.Map(staging, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None, out var mapped);
            try
            {
                for (var y = 0; y < height; y++)
                {
                    var source = (byte*)mapped.DataPointer + y * mapped.RowPitch;
                    var destination = (byte*)data.Scan0 + y * data.Stride;
                    for (var x = 0; x < width; x++)
                    {
                        destination[x * 3] = source[x * 4];
                        destination[x * 3 + 1] = source[x * 4 + 1];
                        destination[x * 3 + 2] = source[x * 4 + 2];
                    }
                }
            }
            finally { context.Unmap(staging, 0); }
        }
        catch
        {
            bitmap.UnlockBits(data);
            bitmap.Dispose();
            throw;
        }
        bitmap.UnlockBits(data);
        return bitmap;
    }

    private static uint GetSdrWhiteLevel(string deviceName)
    {
        const uint activePaths = 2;
        var fallback = 1000u;
        try
        {
            if (Native.GetDisplayConfigBufferSizes(activePaths, out var pathCount, out var modeCount) != 0) throw new InvalidOperationException("GetDisplayConfigBufferSizes failed");
            var paths = new Native.DisplayConfigPathInfo[pathCount];
            var modes = Marshal.AllocHGlobal(checked((int)modeCount * 64));
            try
            {
                if (Native.QueryDisplayConfig(activePaths, ref pathCount, paths, ref modeCount, modes, 0) != 0) throw new InvalidOperationException("QueryDisplayConfig failed");
                foreach (var path in paths.AsSpan(0, (int)pathCount))
                {
                    var name = new Native.DisplayConfigSourceDeviceName
                    {
                        Header = new Native.DisplayConfigDeviceInfoHeader { Type = 1, Size = (uint)Marshal.SizeOf<Native.DisplayConfigSourceDeviceName>(), AdapterId = path.SourceInfo.AdapterId, Id = path.SourceInfo.Id },
                        ViewGdiDeviceName = string.Empty
                    };
                    if (Native.DisplayConfigGetDeviceInfo(ref name) != 0 || !string.Equals(name.ViewGdiDeviceName, deviceName, StringComparison.OrdinalIgnoreCase)) continue;
                    var white = new Native.DisplayConfigSdrWhiteLevel
                    {
                        Header = new Native.DisplayConfigDeviceInfoHeader { Type = 11, Size = (uint)Marshal.SizeOf<Native.DisplayConfigSdrWhiteLevel>(), AdapterId = path.TargetInfo.AdapterId, Id = path.TargetInfo.Id }
                    };
                    if (Native.DisplayConfigGetDeviceInfo(ref white) == 0 && white.SdrWhiteLevel != 0)
                    {
                        OverlayDiagnostics.Log("info", "recognition_sdr_white_level", $"{deviceName}: {white.SdrWhiteLevel} (1000ths of 80 nits)");
                        return white.SdrWhiteLevel;
                    }
                    throw new InvalidOperationException("DisplayConfigGetDeviceInfo(SDR white level) failed");
                }
                throw new InvalidOperationException($"No active display path matched {deviceName}");
            }
            finally { Marshal.FreeHGlobal(modes); }
        }
        catch (Exception error)
        {
            OverlayDiagnostics.Log("warn", "recognition_sdr_white_level_fallback", $"{error.Message}; using standard 80 nits");
            return fallback;
        }
    }

    private static bool IsHdr(ColorSpaceType colorSpace) => (int)colorSpace is 1 or 12 or 13 or 21;

    private static OutputSelection? FindOutput(Rectangle rect)
    {
        using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
        OutputSelection? best = null;
        long bestArea = 0;
        for (uint adapterIndex = 0; ; adapterIndex++)
        {
            if (factory.EnumAdapters1(adapterIndex, out var adapter).Failure) { adapter?.Dispose(); break; }
            using (adapter)
            {
                for (uint outputIndex = 0; ; outputIndex++)
                {
                    if (adapter.EnumOutputs(outputIndex, out var output).Failure) { output?.Dispose(); break; }
                    using (output)
                    using (var output6 = output.QueryInterface<IDXGIOutput6>())
                    {
                        var description = output6.Description1;
                        var bounds = description.DesktopCoordinates;
                        var left = Math.Max(rect.Left, bounds.Left); var top = Math.Max(rect.Top, bounds.Top);
                        var right = Math.Min(rect.Right, bounds.Right); var bottom = Math.Min(rect.Bottom, bounds.Bottom);
                        var area = Math.Max(0, right - left) * (long)Math.Max(0, bottom - top);
                        if (area <= bestArea) continue;
                        best?.Dispose();
                        best = new OutputSelection(adapter.QueryInterface<IDXGIAdapter1>(), output.QueryInterface<IDXGIOutput>(), description);
                        bestArea = area;
                    }
                }
            }
        }
        return best;
    }

    private sealed class OutputSelection(IDXGIAdapter1 adapter, IDXGIOutput output, OutputDescription1 description) : IDisposable
    {
        internal IDXGIAdapter1 Adapter { get; } = adapter;
        internal IDXGIOutput Output { get; } = output;
        internal OutputDescription1 Description { get; } = description;
        public void Dispose() { Output.Dispose(); Adapter.Dispose(); }
    }
}
