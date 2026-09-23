using System.Numerics;
using ImGuiNET;
using Vortice.D3DCompiler;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DirectComposition;
using Vortice.DXGI;
using Vortice.Mathematics;

namespace EFTToolbox.Overlay;


internal sealed class OverlayRenderer : IDisposable
{
    private ID3D11Device device = null!;
    private ID3D11DeviceContext context = null!;
    private IDXGISwapChain1 swapChain = null!;
    private IDCompositionDevice composition = null!;
    private IDCompositionTarget target = null!;
    private IDCompositionVisual visual = null!;
    private IDCompositionEffectGroup opacityEffect = null!;
    private ID3D11RenderTargetView? renderTarget;
    private ID3D11VertexShader vertexShader = null!;
    private ID3D11PixelShader pixelShader = null!;
    private ID3D11InputLayout layout = null!;
    private ID3D11BlendState blend = null!;
    private ID3D11RasterizerState rasterizer = null!;
    private ID3D11DepthStencilState depth = null!;
    private ID3D11Buffer vertices = null!;
    private ID3D11Buffer indices = null!;
    private nint imgui;
    private int width, height;
    private const int Capacity = 262144;
    private ID3D11SamplerState sampler = null!;
    private ID3D11Buffer parameters = null!;
    private ID3D11ShaderResourceView font = null!;
    private TextureCache fontTextures = null!;
    private string? assetDirectory;
    private bool fontsBuilt;
    private int lastOpacity = -1;
    internal TextureCache Texts { get; private set; } = null!;
    internal TextureCache Tiles { get; private set; } = null!;
    internal TextureCache Images { get; private set; } = null!;
    internal TextureCache Svg { get; private set; } = null!;

    internal unsafe void Initialize(nint hwnd)
    {
        D3D11.D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.BgraSupport,
            [FeatureLevel.Level_11_0], out device, out context).CheckError();
        using var dxgiDevice = device.QueryInterface<IDXGIDevice>();
        using var adapter = dxgiDevice.GetAdapter();
        using var factory = adapter.GetParent<IDXGIFactory2>();
        OverlayDiagnostics.Log("info", "gpu_selected", adapter.Description.Description);
        swapChain = factory.CreateSwapChainForComposition(device, new SwapChainDescription1
        {
            Width = 1,
            Height = 1,
            Format = Format.B8G8R8A8_UNorm,
            SampleDescription = new SampleDescription(1, 0),
            BufferUsage = Usage.RenderTargetOutput,
            BufferCount = 2,
            SwapEffect = SwapEffect.FlipSequential,
            Scaling = Scaling.Stretch,
            AlphaMode = AlphaMode.Premultiplied
        });
        composition = DComp.DCompositionCreateDevice<IDCompositionDevice>(dxgiDevice);
        composition.CreateTargetForHwnd(hwnd, true, out target).CheckError();
        composition.CreateVisual(out visual).CheckError();
        composition.CreateEffectGroup(out opacityEffect).CheckError();
        visual.SetEffect(opacityEffect).CheckError();
        visual.SetContent(swapChain).CheckError();
        target.SetRoot(visual).CheckError();
        composition.Commit().CheckError();

        const string shader = """
            cbuffer Parameters : register(b0) { float4 settings; }
            Texture2D image : register(t0); SamplerState imageSampler : register(s0);
            struct Vertex { float2 position : POSITION; float2 uv : TEXCOORD0; float4 color : COLOR0; };
            struct Pixel { float4 position : SV_POSITION; float2 uv : TEXCOORD0; float4 color : COLOR0; };
            Pixel VS(Vertex input) { Pixel o; o.position=float4(input.position,0,1);o.uv=input.uv;o.color=input.color;return o; }
            float4 PS(Pixel input) : SV_TARGET {
                float2 p=(input.position.xy-settings.xy/2)/(settings.xy/2);
                if(settings.z>0 && dot(p,p)>1) discard;
                float4 tex=image.Sample(imageSampler,input.uv);
                return float4(tex.rgb*input.color.rgb*input.color.a,tex.a*input.color.a);
            }
            """;
        var vs = Compiler.Compile(shader, "VS", "overlay", "vs_5_0");
        var ps = Compiler.Compile(shader, "PS", "overlay", "ps_5_0");
        vertexShader = device.CreateVertexShader(vs.Span);
        pixelShader = device.CreatePixelShader(ps.Span);
        layout = device.CreateInputLayout([
            new InputElementDescription("POSITION", 0, Format.R32G32_Float, 0, 0),
            new InputElementDescription("TEXCOORD", 0, Format.R32G32_Float, 8, 0),
            new InputElementDescription("COLOR", 0, Format.R8G8B8A8_UNorm, 16, 0)
        ], vs.Span);
        // Shader emits premultiplied RGB; both RGB and alpha use ONE / INV_SRC_ALPHA.
        blend = device.CreateBlendState(BlendDescription.AlphaBlend);
        rasterizer = device.CreateRasterizerState(new RasterizerDescription
        {
            FillMode = FillMode.Solid,
            CullMode = CullMode.None,
            ScissorEnable = true,
            DepthClipEnable = true
        });
        depth = device.CreateDepthStencilState(DepthStencilDescription.None);
        vertices = device.CreateBuffer((uint)(Capacity * sizeof(ImDrawVert)), BindFlags.VertexBuffer,
            ResourceUsage.Dynamic, CpuAccessFlags.Write);
        indices = device.CreateBuffer(Capacity * sizeof(ushort), BindFlags.IndexBuffer,
            ResourceUsage.Dynamic, CpuAccessFlags.Write);
        fontTextures = new TextureCache(device, 1);
        Tiles = new TextureCache(device, 256, 64L << 20); Images = new TextureCache(device, 512, 32L << 20); Texts = new TextureCache(device, 1024, 32L << 20); Svg = new TextureCache(device, 1, 512L << 20);
        sampler = device.CreateSamplerState(SamplerDescription.LinearClamp);
        parameters = device.CreateBuffer(16, BindFlags.ConstantBuffer, ResourceUsage.Default);
        imgui = ImGui.CreateContext();
        var io = ImGui.GetIO();
        io.NativePtr->IniFilename = null;
        io.NativePtr->LogFilename = null;
        io.ConfigFlags |= ImGuiConfigFlags.NoMouse | ImGuiConfigFlags.NoKeyboard;
        // The atlas is built on the first frame, once the asset directory is known; see EnsureFonts.
    }

    /// <summary>Where the converted fonts live; the overlay receives it with the bootstrap.</summary>
    internal void SetAssetDirectory(string directory) => assetDirectory = directory;

    // ImGui only supplies solid geometry and its white atlas pixel. Map text uses bundled Skia fonts.
    private unsafe void EnsureFonts()
    {
        // The bootstrap carrying the asset directory arrives after the first frames; building the
        // atlas before that would load the fallback face and the flag below would keep it forever.
        if (fontsBuilt || assetDirectory is null) return;
        fontsBuilt = true;
        var io = ImGui.GetIO();
        io.Fonts.AddFontDefault();
        io.Fonts.GetTexDataAsRGBA32(out nint pixels, out int fw, out int fh);
        var fontBytes = new byte[fw * fh * 4]; System.Runtime.InteropServices.Marshal.Copy(pixels, fontBytes, 0, fontBytes.Length);
        for (int i = 0; i < fontBytes.Length; i += 4) fontBytes[i] = fontBytes[i + 1] = fontBytes[i + 2] = fontBytes[i + 3];
        font = fontTextures.Put("__font", new(fontBytes, fw, fh, fw * 4, 0, 0)); io.Fonts.SetTexID(font.NativePointer);
    }

    internal void Resize(int newWidth, int newHeight)
    {
        if (width == newWidth && height == newHeight) return;
        context.OMSetRenderTargets(Array.Empty<ID3D11RenderTargetView>());
        renderTarget?.Dispose();
        renderTarget = null;
        swapChain.ResizeBuffers(2, (uint)newWidth, (uint)newHeight, Format.Unknown, SwapChainFlags.None).CheckError();
        using var backBuffer = swapChain.GetBuffer<ID3D11Texture2D>(0);
        renderTarget = device.CreateRenderTargetView(backBuffer);
        width = newWidth;
        height = newHeight;
    }

    internal double LastDrawMs { get; private set; }
    internal double LastPresentMs { get; private set; }
    internal unsafe void Render(MapScene scene, MarkerLayer markers, TileLayerRenderer tiles, bool circle, bool backdrop, int opacity, bool editing, Operation? operation = null)
    {
        EnsureFonts();
        if (lastOpacity != opacity) { opacityEffect.SetOpacity(opacity / 100f).CheckError(); composition.Commit().CheckError(); lastOpacity = opacity; }
        var renderTimer = System.Diagnostics.Stopwatch.StartNew();
        var io = ImGui.GetIO();
        io.DisplaySize = new Vector2(width, height); io.DeltaTime = 1f / 60;
        ImGui.NewFrame();
        var draw = ImGui.GetBackgroundDrawList();
        if (scene.Map is not null)
        {
            // The dashboard draws the map on an opaque surface, and that is what makes the floor
            // below the active one read as depth rather than as transparency. Over a game those
            // same dim pixels just vanish, so the overlay can lay the same surface down first; the
            // circle shape clips it in the shader like everything else. Optional, because it also
            // hides the game behind the panel.
            if (backdrop) draw.AddRectFilled(Vector2.Zero, new Vector2(width, height), Backdrop);
            foreach (var tile in tiles.Visible)
                if (Tiles.Get(tile.Key) is { } texture) draw.AddImage(texture.NativePointer, scene.Screen(tile.A), scene.Screen(tile.B), Vector2.Zero, Vector2.One, ImGui.ColorConvertFloat4ToU32(new Vector4(1, 1, 1, tile.Opacity)));
            if (Svg.Get("map") is { } svg)
            {
                var b = scene.SvgRegion is { } region ? new double[] { region.X, region.Y, region.Width, region.Height } : scene.Map.Projection.ViewBox;
                draw.AddImage(svg.NativePointer, scene.Screen(new Vector2((float)b[0], (float)b[1])), scene.Screen(new Vector2((float)(b[0] + b[2]), (float)(b[1] + b[3]))));
            }
            markers.Draw(draw, scene, Images, Texts, operation);
        }
        if (editing) DrawBorder(draw, circle);
        ImGui.Render();

        context.OMSetRenderTargets(renderTarget!);
        context.ClearRenderTargetView(renderTarget!, new Color4(0, 0, 0, 0));
        context.OMSetBlendState(blend);
        context.OMSetDepthStencilState(depth);
        context.RSSetState(rasterizer);
        context.RSSetViewport(0, 0, width, height);
        context.IASetInputLayout(layout);
        context.IASetPrimitiveTopology(PrimitiveTopology.TriangleList);
        context.IASetVertexBuffer(0, vertices, (uint)sizeof(ImDrawVert));
        context.IASetIndexBuffer(indices, Format.R16_UInt, 0);
        context.VSSetShader(vertexShader);
        context.PSSetShader(pixelShader);
        // z clips the circle, w scales the whole panel's alpha.
        var values = new Vector4(width, height, circle ? 1 : 0, opacity / 100f); context.UpdateSubresource(values, parameters);
        context.PSSetConstantBuffer(0, parameters); context.PSSetSampler(0, sampler);
        var data = ImGui.GetDrawData();
        for (int i = 0; i < data.CmdListsCount; i++)
        {
            var list = data.CmdLists[i];
            if (list.VtxBuffer.Size > Capacity || list.IdxBuffer.Size > Capacity)
                throw new InvalidOperationException("Overlay geometry exceeds fixed buffer capacity.");
            var mapped = context.Map(vertices, 0, MapMode.WriteDiscard);
            try
            {
                var output = new Span<ImDrawVert>((void*)mapped.DataPointer, list.VtxBuffer.Size);
                new ReadOnlySpan<ImDrawVert>((void*)list.VtxBuffer.Data, list.VtxBuffer.Size).CopyTo(output);
                for (int v = 0; v < output.Length; v++)
                    output[v].pos = new Vector2(output[v].pos.X * 2 / width - 1, 1 - output[v].pos.Y * 2 / height);
            }
            finally { context.Unmap(vertices, 0); }
            mapped = context.Map(indices, 0, MapMode.WriteDiscard);
            try
            {
                new ReadOnlySpan<ushort>((void*)list.IdxBuffer.Data, list.IdxBuffer.Size)
                    .CopyTo(new Span<ushort>((void*)mapped.DataPointer, list.IdxBuffer.Size));
            }
            finally { context.Unmap(indices, 0); }
            for (int c = 0; c < list.CmdBuffer.Size; c++)
            {
                var command = list.CmdBuffer[c];
                var clip = command.ClipRect;
                context.RSSetScissorRect((int)clip.X, (int)clip.Y, (int)clip.Z, (int)clip.W);
                var texture = command.TextureId == font.NativePointer ? font : Svg.Find(command.TextureId) ?? Tiles.Find(command.TextureId) ?? Images.Find(command.TextureId) ?? Texts.Find(command.TextureId);
                if (texture is null) continue;
                context.PSSetShaderResource(0, texture);
                context.DrawIndexed(command.ElemCount, command.IdxOffset, (int)command.VtxOffset);
            }
        }
        LastDrawMs = renderTimer.Elapsed.TotalMilliseconds; renderTimer.Restart();
        swapChain.Present(1, PresentFlags.None).CheckError();
        LastPresentMs = renderTimer.Elapsed.TotalMilliseconds;
    }

    private const float DashPeriod = 16, DashThickness = 4, DashOutline = 7;
    // Opaque dashboard background; the composition effect controls the panel's transparency.
    private static readonly uint Backdrop = BackgroundColor();
    private static uint BackgroundColor() {
        var rgb = Convert.ToUInt32(EFTToolbox.Contracts.MapDisplay.Background[1..], 16);
        return 0xff000000 | ((rgb & 255) << 16) | (rgb & 0xff00) | (rgb >> 16);
    }

    private void DrawBorder(ImDrawListPtr draw, bool circle)
    {
        // A white dash over a black outline, so the border reads on any basemap. Both are opaque:
        // the overlay blends, and a half-transparent dash would tint with whatever is underneath.
        var center = new Vector2(width, height) / 2;
        var radius = OverlayGeometry.Radius(width, height);
        var x0 = OverlayGeometry.Inset; var y0 = OverlayGeometry.Inset;
        var x1 = width - OverlayGeometry.Inset; var y1 = height - OverlayGeometry.Inset;
        var top = x1 - x0; var side = y1 - y0;
        var length = circle ? MathF.Tau * radius : 2 * (top + side);
        Vector2 At(float distance)
        {
            if (circle) { var angle = distance / radius; return center + new Vector2(MathF.Cos(angle), MathF.Sin(angle)) * radius; }
            if (distance < top) return new(x0 + distance, y0); distance -= top;
            if (distance < side) return new(x1, y0 + distance); distance -= side;
            if (distance < top) return new(x1 - distance, y1); distance -= top;
            return new(x0, y1 - distance);
        }
        var steps = (int)(length / DashPeriod);
        for (int i = 0; i < steps; i++)
        {
            var a = At(length * i / steps); var b = At(length * (i + 1) / steps);
            if (i % 2 == 0) { draw.AddLine(a, b, 0xff000000, DashOutline); draw.AddLine(a, b, 0xffffffff, DashThickness); }
        }
        foreach (var handle in circle ? OverlayGeometry.CircleHandles : OverlayGeometry.SquareHandles)
        {
            var point = circle ? OverlayGeometry.CircleHandle(handle, width, height) : OverlayGeometry.Handle(handle, width, height);
            draw.AddRectFilled(point - new Vector2(7), point + new Vector2(7), 0xff000000, 3);
            draw.AddRect(point - new Vector2(5), point + new Vector2(5), 0xffffffff, 3, ImDrawFlags.None, 3);
        }
    }


    public void Dispose()
    {
        context?.ClearState();
        context?.Flush();
        if (imgui != 0) ImGui.DestroyContext(imgui);
        Svg?.Dispose(); Tiles?.Dispose(); Images?.Dispose(); Texts?.Dispose(); fontTextures?.Dispose(); sampler?.Dispose(); parameters?.Dispose();
        indices?.Dispose();
        vertices?.Dispose();
        depth?.Dispose();
        rasterizer?.Dispose();
        blend?.Dispose();
        layout?.Dispose();
        pixelShader?.Dispose();
        vertexShader?.Dispose();
        renderTarget?.Dispose();
        visual?.Dispose(); opacityEffect?.Dispose();
        target?.Dispose();
        composition?.Dispose();
        swapChain?.Dispose();
        context?.Dispose();
        device?.Dispose();
    }
}
