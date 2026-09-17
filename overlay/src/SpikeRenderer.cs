using System.Numerics;
using ImGuiNET;
using Vortice.D3DCompiler;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DirectComposition;
using Vortice.DXGI;
using Vortice.Mathematics;

namespace EFTToolbox.Overlay;

// Deliberately supports only the solid ImGui geometry used by this spike, not text or textures.
internal sealed class SpikeRenderer : IDisposable
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
    private const int Capacity = 1024;

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
            Width = 1, Height = 1, Format = Format.B8G8R8A8_UNorm,
            SampleDescription = new SampleDescription(1, 0), BufferUsage = Usage.RenderTargetOutput,
            BufferCount = 2, SwapEffect = SwapEffect.FlipSequential,
            Scaling = Scaling.Stretch, AlphaMode = AlphaMode.Premultiplied
        });
        composition = DComp.DCompositionCreateDevice<IDCompositionDevice>(dxgiDevice);
        composition.CreateTargetForHwnd(hwnd, true, out target).CheckError();
        composition.CreateVisual(out visual).CheckError();
        visual.SetContent(swapChain).CheckError();
        target.SetRoot(visual).CheckError();
        composition.Commit().CheckError();

        const string shader = """
            struct Vertex { float2 position : POSITION; float4 color : COLOR0; };
            struct Pixel { float4 position : SV_POSITION; float4 color : COLOR0; };
            Pixel VS(Vertex input) {
                Pixel output;
                output.position = float4(input.position, 0, 1);
                output.color = input.color;
                return output;
            }
            float4 PS(Pixel input) : SV_TARGET {
                return float4(input.color.rgb * input.color.a, input.color.a);
            }
            """;
        var vs = Compiler.Compile(shader, "VS", "spike", "vs_5_0");
        var ps = Compiler.Compile(shader, "PS", "spike", "ps_5_0");
        vertexShader = device.CreateVertexShader(vs.Span);
        pixelShader = device.CreatePixelShader(ps.Span);
        layout = device.CreateInputLayout([
            new InputElementDescription("POSITION", 0, Format.R32G32_Float, 0, 0),
            new InputElementDescription("COLOR", 0, Format.R8G8B8A8_UNorm, 16, 0)
        ], vs.Span);
        // Shader emits premultiplied RGB; both RGB and alpha use ONE / INV_SRC_ALPHA.
        blend = device.CreateBlendState(BlendDescription.AlphaBlend);
        rasterizer = device.CreateRasterizerState(new RasterizerDescription
        {
            FillMode = FillMode.Solid, CullMode = CullMode.None,
            ScissorEnable = true, DepthClipEnable = true
        });
        depth = device.CreateDepthStencilState(DepthStencilDescription.None);
        vertices = device.CreateBuffer((uint)(Capacity * sizeof(ImDrawVert)), BindFlags.VertexBuffer,
            ResourceUsage.Dynamic, CpuAccessFlags.Write);
        indices = device.CreateBuffer(Capacity * sizeof(ushort), BindFlags.IndexBuffer,
            ResourceUsage.Dynamic, CpuAccessFlags.Write);
        imgui = ImGui.CreateContext();
        var io = ImGui.GetIO();
        io.NativePtr->IniFilename = null;
        io.NativePtr->LogFilename = null;
        io.ConfigFlags |= ImGuiConfigFlags.NoMouse | ImGuiConfigFlags.NoKeyboard;
        io.Fonts.GetTexDataAsRGBA32(out nint _, out _, out _);
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

    internal unsafe void Render(float scale)
    {
        var io = ImGui.GetIO();
        io.DisplaySize = new Vector2(width, height);
        io.DeltaTime = 1f / 60;
        ImGui.NewFrame();
        ImGui.GetBackgroundDrawList().AddRectFilled(new Vector2(24 * scale),
            new Vector2(184 * scale), ImGui.ColorConvertFloat4ToU32(new Vector4(95 / 255f, 211 / 255f, 196 / 255f, 0.5f)));
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
        var data = ImGui.GetDrawData();
        for (int i = 0; i < data.CmdListsCount; i++)
        {
            var list = data.CmdLists[i];
            if (list.VtxBuffer.Size > Capacity || list.IdxBuffer.Size > Capacity)
                throw new InvalidOperationException("Spike geometry exceeds fixed buffer capacity.");
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
                context.DrawIndexed(command.ElemCount, command.IdxOffset, (int)command.VtxOffset);
            }
        }
        swapChain.Present(1, PresentFlags.None).CheckError();
    }

    public void Dispose()
    {
        context?.ClearState();
        context?.Flush();
        if (imgui != 0) ImGui.DestroyContext(imgui);
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
