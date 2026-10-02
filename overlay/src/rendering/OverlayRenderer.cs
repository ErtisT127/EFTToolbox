using System.Diagnostics;
using System.Numerics;
using ImGuiNET;
using Vortice.D3DCompiler;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DirectComposition;
using Vortice.DXGI;
using Vortice.Mathematics;
using EFTToolbox.Contracts;

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
    internal unsafe void Render(MapScene scene, MarkerLayer markers, TileLayerRenderer tiles, bool circle, bool backdrop, int opacity, bool editing, Operation? operation = null, float markerOpacity = 1)
    {
        var renderStarted = Stopwatch.GetTimestamp();
        var draw = BeginFrame(opacity);
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
            markers.Draw(draw, scene, Images, Texts, operation, markerOpacity);
        }
        if (editing) DrawBorder(draw, circle);
        EndFrame(circle, renderStarted);
        OverlayDiagnostics.RecordSlowFrame("map", LastDrawMs, LastPresentMs, operation);
    }

    /// <summary>The recognition window draws nothing but its panel; it owns its own device, swap
    /// chain and ImGui context, so the frame plumbing is shared but the content is not.</summary>
    internal unsafe void RenderRecognition(RecognitionPanelView panel, int opacity)
    {
        var renderStarted = Stopwatch.GetTimestamp();
        var draw = BeginFrame(opacity);
        DrawRecognitionPanel(draw, panel);
        EndFrame(false, renderStarted);
        OverlayDiagnostics.RecordSlowFrame("recognition", LastDrawMs, LastPresentMs);
    }

    /// <summary>Opens a frame and sets the window's one and only alpha: the composition effect group
    /// scales everything the frame draws, so a percentage on a slider is the percentage on screen.</summary>
    private ImDrawListPtr BeginFrame(int opacity)
    {
        // Two windows share one thread, so each render re-binds the context its own draw lists
        // belong to before ImGui is touched.
        ImGui.SetCurrentContext(imgui);
        EnsureFonts();
        if (lastOpacity != opacity) { opacityEffect.SetOpacity(opacity / 100f).CheckError(); composition.Commit().CheckError(); lastOpacity = opacity; }
        var io = ImGui.GetIO();
        io.DisplaySize = new Vector2(width, height); io.DeltaTime = 1f / 60;
        ImGui.NewFrame();
        return ImGui.GetBackgroundDrawList();
    }

    private unsafe void EndFrame(bool circle, long renderStarted)
    {
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
        // z clips the circle; w is spare, since the effect group above already carries the alpha.
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
                var texture = command.TextureId == font.NativePointer ? font : Svg.Find(command.TextureId) ?? Tiles.Find(command.TextureId) ?? Images.Find(command.TextureId) ?? Texts.Find(command.TextureId);
                if (texture is null) continue;
                context.PSSetShaderResource(0, texture);
                context.DrawIndexed(command.ElemCount, command.IdxOffset, (int)command.VtxOffset);
            }
        }
        LastDrawMs = Stopwatch.GetElapsedTime(renderStarted).TotalMilliseconds;
        var presentStarted = Stopwatch.GetTimestamp();
        swapChain.Present(1, PresentFlags.None).CheckError();
        LastPresentMs = Stopwatch.GetElapsedTime(presentStarted).TotalMilliseconds;
    }

    /// <summary>The recognition panel: a title strip that also drags the window, then one scrollable
    /// column of rows (artwork, wrapped name, prices with their unit). Every measurement comes from
    /// <see cref="PanelMetrics"/>, so hit testing can never drift from the drawing.</summary>
    private void DrawRecognitionPanel(ImDrawListPtr draw, RecognitionPanelView panel)
    {
        var m = new PanelMetrics(panel.Scale);
        var size = new Vector2(width, height);
        var radius = m.Edge;
        // The window is exactly the panel, so the polish has to live inside its edges: a soft shadow
        // line, a two-tone body and a hairline border instead of one flat rectangle.
        draw.AddRectFilled(Vector2.Zero, size, PanelColor.Of(0x121614, 0xfa), radius);
        draw.AddRectFilled(new Vector2(1, 1), new Vector2(width - 1, m.TitleBottom), PanelColor.Of(0x1b211e), radius, ImDrawFlags.RoundCornersTop);
        // A plain panel border, the same colour every other surface uses.
        draw.AddRect(new Vector2(0.5f, 0.5f), new Vector2(width - 0.5f, height - 0.5f), PanelColor.Of(0x3b443e), radius, ImDrawFlags.None, 1);
        draw.AddRectFilled(new Vector2(1, m.TitleBottom - 1), new Vector2(width - 1, m.TitleBottom), PanelColor.Of(0x2a302d));
        var pad = m.Pad;
        var titleCenter = m.Edge + m.TitleHeight / 2;
        if (panel.Title.Texture != 0)
            AddPanelImage(draw, panel.Title.Texture, panel.Title.Size, new Vector2(pad, titleCenter - panel.Title.Size.Y / 2));
        var (closeMin, closeMax) = m.CloseButton(width);
        var center = (closeMin + closeMax) / 2;
        var cross = 4.5f * panel.Scale;
        draw.AddLine(center - new Vector2(cross, cross), center + new Vector2(cross, cross), PanelColor.Of(0xd4d8d5), 1.6f * panel.Scale);
        draw.AddLine(center + new Vector2(-cross, cross), center + new Vector2(cross, -cross), PanelColor.Of(0xd4d8d5), 1.6f * panel.Scale);
        var columns = m.Columns(width);
        var (rowsTop, rowsHeight) = m.RowsArea(height);
        // A run in progress, a failure or an empty result each take over the whole content area: the
        // title strip stays what it is, and the reader sees the state where the list would be.
        if (panel.Loading || panel.Message.Texture != 0)
        {
            if (rowsHeight > 0)
            {
                // The spinner and its line are one group, so the group is what sits in the middle of
                // the content area rather than each part separately.
                var spinner = 14 * panel.Scale;
                var gap = panel.Loading && panel.Message.Texture != 0 ? 6 * panel.Scale : 0;
                var groupHeight = (panel.Loading ? spinner + gap : 0) + panel.Message.Size.Y;
                var top = rowsTop + (rowsHeight - groupHeight) / 2;
                if (panel.Loading)
                {
                    DrawSpinner(draw, new Vector2(width / 2, top + spinner / 2), panel.SpinnerPhase, panel.Scale);
                    top += spinner + gap;
                }
                if (panel.Message.Texture != 0)
                    AddPanelImage(draw, panel.Message.Texture, panel.Message.Size, new Vector2(width / 2 - panel.Message.Size.X / 2, top));
            }
            return;
        }
        // The header names the columns once, so the rows stay pure data: no "flea" prefix, no icons
        // standing in for words.
        var headerTop = m.HeaderTop;
        DrawPanelText(draw, panel.HeaderName, columns.Name, headerTop + m.HeaderHeight / 2);
        DrawPanelText(draw, panel.HeaderTrader, columns.Trader + columns.TraderWidth / 2, headerTop + m.HeaderHeight / 2, centered: true);
        DrawPanelText(draw, panel.HeaderFlea, columns.Flea + columns.FleaWidth / 2, headerTop + m.HeaderHeight / 2, centered: true);
        draw.AddLine(new Vector2(pad, headerTop + m.HeaderHeight), new Vector2(width - pad, headerTop + m.HeaderHeight), PanelColor.Of(0x2a302d, 0xcc), 1);
        if (rowsHeight > 0)
        {
            draw.PushClipRect(new Vector2(pad, rowsTop), new Vector2(width - pad, rowsTop + rowsHeight), true);
            for (var index = 0; index < panel.Items.Count; index++)
            {
                // The list is a grid of whole pixels; a fractional scroll would put every row — its
                // plates, artwork and text — between two pixels.
                var rowTop = rowsTop + index * m.RowHeight - MathF.Round(panel.Scroll);
                if (rowTop + m.RowHeight < rowsTop || rowTop > rowsTop + rowsHeight) continue;
                var item = panel.Items[index];
                var box = m.Thumb;
                var boxTop = rowTop + (m.RowHeight - box) / 2;
                // The artwork sits on its own plate so bright and dark icons both read on the panel.
                draw.AddRectFilled(new Vector2(columns.Image, boxTop), new Vector2(columns.Image + box, boxTop + box), PanelColor.Of(0x0a0d0c, 0xb3), 4 * panel.Scale);
                draw.AddRect(new Vector2(columns.Image, boxTop), new Vector2(columns.Image + box, boxTop + box), PanelColor.Of(0x303834, 0xaa), 4 * panel.Scale, ImDrawFlags.None, 1);
                if (item.Image is { Texture: var texture, Size: var imageSize } && texture != 0)
                {
                    var scale = Math.Min((box - 8 * panel.Scale) / Math.Max(1, imageSize.X), (box - 8 * panel.Scale) / Math.Max(1, imageSize.Y));
                    var half = imageSize * scale / 2;
                    var imageCenter = new Vector2(columns.Image + box / 2, boxTop + box / 2);
                    draw.AddImage(texture, imageCenter - half, imageCenter + half);
                }
                // The name wraps inside its column and stops after two lines, so one long item name
                // cannot push the prices out of the row.
                if (item.Name.Texture != 0)
                {
                    var nameTop = rowTop + (m.RowHeight - item.Name.Size.Y) / 2;
                    AddPanelImage(draw, item.Name.Texture, item.Name.Size, new Vector2(columns.Name, nameTop));
                }
                // Trader: one centred unit per row — portrait, then the price in a fixed slot — so the
                // portraits form a column and the prices start at the same x.
                var slot = panel.TraderSlot > 0 ? panel.TraderSlot : m.PriceSlot;
                var unitLeft = m.TraderUnitLeft(columns.Trader, slot);
                var priceLeft = unitLeft + m.Avatar + m.AvatarGap;
                if (item.Trader.Texture != 0)
                {
                    DrawPanelText(draw, item.Trader, priceLeft, rowTop + m.RowHeight / 2);
                    if (item.Avatar is { Texture: var avatar, Size: var avatarSize } && avatar != 0)
                    {
                        var avatarSize2 = new Vector2(m.Avatar);
                        var avatarCenter = new Vector2(unitLeft + m.Avatar / 2, rowTop + m.RowHeight / 2);
                        draw.AddImage(avatar, avatarCenter - avatarSize2 / 2, avatarCenter + avatarSize2 / 2);
                    }
                }
                DrawPanelText(draw, item.Flea, columns.Flea + columns.FleaWidth / 2, rowTop + m.RowHeight / 2, centered: true);
                if (item.Flea.Texture == 0 && item.Trader.Texture != 0)
                {
                    // Nothing on the flea leg: the dash still has to sit where the numbers would.
                    draw.AddText(new Vector2(columns.Flea + columns.FleaWidth / 2 - 3, rowTop + m.RowHeight / 2 - 8), PanelColor.Of(0x6b746e), "-");
                }
                if (index < panel.Items.Count - 1)
                    draw.AddLine(new Vector2(pad, rowTop + m.RowHeight), new Vector2(width - pad, rowTop + m.RowHeight), PanelColor.Of(0x2a302d, 0x55), 1);
            }
            draw.PopClipRect();
            // A thumb for the scroll position whenever the rows do not all fit.
            var content = Math.Max(rowsHeight, panel.ContentHeight);
            if (content > rowsHeight + 1)
            {
                var trackX = m.ScrollbarLeft(width);
                var thumb = Math.Max(24f * panel.Scale, rowsHeight * rowsHeight / content);
                var offset = (rowsHeight - thumb) * Math.Clamp(panel.Scroll / (content - rowsHeight), 0, 1);
                draw.AddRectFilled(new Vector2(trackX, rowsTop + offset), new Vector2(trackX + 3 * panel.Scale, rowsTop + offset + thumb), PanelColor.Of(0xc8a24a, 0x77), 2);
            }
        }
    }

    private static void DrawPanelText(ImDrawListPtr draw, RecognitionText text, float edge, float centerY, bool centered = false)
    {
        if (text.Texture == 0) return;
        var x = centered ? edge - text.Size.X / 2 : edge;
        AddPanelImage(draw, text.Texture, text.Size, new Vector2(x, centerY - text.Size.Y / 2));
    }

    /// <summary>
    /// The sampler is linear, so a glyph quad that lands on a half pixel is smeared across two —
    /// and the price columns, centred on arithmetic that halves whatever width the widest number
    /// happens to have, land on one about half the time. Rounding the destination keeps the texture
    /// texel-for-texel with the screen; the dropped sub-pixel is invisible either way.
    /// </summary>
    private static void AddPanelImage(ImDrawListPtr draw, nint texture, Vector2 size, Vector2 topLeft)
    {
        var x = MathF.Round(topLeft.X);
        var y = MathF.Round(topLeft.Y);
        draw.AddImage(texture, new Vector2(x, y), new Vector2(x + size.X, y + size.Y));
    }

    private static void DrawSpinner(ImDrawListPtr draw, Vector2 center, float phase, float scale)
    {
        const int Segments = 8;
        for (var index = 0; index < Segments; index++)
        {
            var angle = phase + index * MathF.Tau / Segments;
            var alpha = (uint)(60 + 195 * index / (Segments - 1));
            var inner = center + new Vector2(MathF.Cos(angle), MathF.Sin(angle)) * (4 * scale);
            var outer = center + new Vector2(MathF.Cos(angle), MathF.Sin(angle)) * (7 * scale);
            draw.AddLine(inner, outer, PanelColor.Of(0xc8a24a, alpha), 1.6f * scale);
        }
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
