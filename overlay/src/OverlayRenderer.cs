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
        Console.WriteLine($"GPU: {adapter.Description.Description}");
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
        Tiles = new TextureCache(device); Images = new TextureCache(device, 512); Svg = new TextureCache(device, 1);
        sampler = device.CreateSamplerState(SamplerDescription.LinearClamp);
        parameters = device.CreateBuffer(16, BindFlags.ConstantBuffer, ResourceUsage.Default);
        imgui = ImGui.CreateContext();
        var io = ImGui.GetIO();
        io.NativePtr->IniFilename = null;
        io.NativePtr->LogFilename = null;
        io.ConfigFlags |= ImGuiConfigFlags.NoMouse | ImGuiConfigFlags.NoKeyboard;
        var fontPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Fonts), "msyh.ttc");
        if (File.Exists(fontPath)) io.Fonts.AddFontFromFileTTF(fontPath, 16, null, io.Fonts.GetGlyphRangesChineseSimplifiedCommon());
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
    internal unsafe void Render(MapScene scene, MarkerLayer markers, TileLayerRenderer tiles, bool circle, bool editing, Operation? operation = null)
    {
        var renderTimer = System.Diagnostics.Stopwatch.StartNew();
        var io = ImGui.GetIO();
        io.DisplaySize = new Vector2(width, height); io.DeltaTime = 1f / 60;
        ImGui.NewFrame();
        var draw = ImGui.GetBackgroundDrawList();
        if (scene.Map is not null)
        {
            foreach (var tile in tiles.Visible)
                if (Tiles.Get(tile.Key) is { } texture) draw.AddImage(texture.NativePointer, scene.Screen(tile.A), scene.Screen(tile.B), Vector2.Zero, Vector2.One, ImGui.ColorConvertFloat4ToU32(new Vector4(1, 1, 1, tile.Opacity)));
            if (Svg.Get("map") is { } svg)
            {
                var b = scene.Map.Projection.ViewBox;
                draw.AddImage(svg.NativePointer, scene.Screen(new Vector2((float)b[0], (float)b[1])), scene.Screen(new Vector2((float)(b[0] + b[2]), (float)(b[1] + b[3]))));
            }
            markers.Draw(draw, scene, Images, operation);
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
        var values = new Vector4(width, height, circle ? 1 : 0, 0); context.UpdateSubresource(values, parameters);
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
                var texture = command.TextureId == font.NativePointer ? font : Svg.Find(command.TextureId) ?? Tiles.Find(command.TextureId) ?? Images.Find(command.TextureId);
                if (texture is null) continue;
                context.PSSetShaderResource(0, texture);
                context.DrawIndexed(command.ElemCount, command.IdxOffset, (int)command.VtxOffset);
            }
        }
        LastDrawMs = renderTimer.Elapsed.TotalMilliseconds; renderTimer.Restart();
        swapChain.Present(1, PresentFlags.None).CheckError();
        LastPresentMs = renderTimer.Elapsed.TotalMilliseconds;
    }

    private void DrawBorder(ImDrawListPtr draw, bool circle)
    {
        var center = new Vector2(width, height) / 2; var radius = Math.Min(width, height) / 2f - 5;
        Vector2 At(float t)
        {
            if (circle) return center + new Vector2(MathF.Cos(t * MathF.Tau), MathF.Sin(t * MathF.Tau)) * radius;
            var perimeter = 2 * (width + height - 20); var d = t * perimeter;
            if (d < width - 10) return new(5 + d, 5); d -= width - 10;
            if (d < height - 10) return new(width - 5, 5 + d); d -= height - 10;
            if (d < width - 10) return new(width - 5 - d, height - 5); d -= width - 10; return new(5, height - 5 - d);
        }
        var steps = (int)((circle ? MathF.Tau * radius : 2 * (width + height)) / 4);
        for (int i = 0; i < steps; i++)
        {
            var a = At((float)i / steps); var b = At((float)(i + 1) / steps);
            draw.AddLine(a, b, 0xff000000, 6); draw.AddLine(a, b, 0xffffffff, 4);
            if (i % 5 < 3) draw.AddLine(a, b, 0xff4aa2c8, 2);
        }
        var handle = At(circle ? 0 : 0.5f);
        draw.AddRectFilled(handle - new Vector2(5), handle + new Vector2(5), 0xff000000);
        draw.AddRect(handle - new Vector2(4), handle + new Vector2(4), 0xff4aa2c8, 0, ImDrawFlags.None, 2);
    }

    public void Dispose()
    {
        context?.ClearState();
        context?.Flush();
        if (imgui != 0) ImGui.DestroyContext(imgui);
        Svg?.Dispose(); Tiles?.Dispose(); Images?.Dispose(); fontTextures?.Dispose(); sampler?.Dispose(); parameters?.Dispose();
        indices?.Dispose();
        vertices?.Dispose();
        depth?.Dispose();
        rasterizer?.Dispose();
        blend?.Dispose();
        layout?.Dispose();
        pixelShader?.Dispose();
        vertexShader?.Dispose();
        renderTarget?.Dispose();
        visual?.Dispose();
        target?.Dispose();
        composition?.Dispose();
        swapChain?.Dispose();
        context?.Dispose();
        device?.Dispose();
    }
}
