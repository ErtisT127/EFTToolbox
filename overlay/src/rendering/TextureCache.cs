using System.Numerics;
using Vortice.Direct3D11;
using Vortice.DXGI;

namespace EFTToolbox.Overlay;

internal sealed class TextureCache(ID3D11Device device, int capacity = 128, long byteBudget = 64L << 20) : IDisposable
{
    private readonly Dictionary<string, (ID3D11ShaderResourceView View, LinkedListNode<string> Node, long Bytes, int Width, int Height)> values = new();
    private readonly LinkedList<string> lru = new();
    internal long Bytes { get; private set; }
    internal int Capacity => capacity;
    internal ID3D11ShaderResourceView? Find(nint id) => values.Values.FirstOrDefault(v => v.View.NativePointer == id).View;
    internal bool Contains(string key) => values.ContainsKey(key);
    /// <summary>The pixel size of a cached texture, for anything that has to keep its aspect ratio.</summary>
    internal Vector2 Size(string key) => values.TryGetValue(key, out var entry) ? new(entry.Width, entry.Height) : Vector2.Zero;
    internal ID3D11ShaderResourceView? Get(string key)
    {
        if (!values.TryGetValue(key, out var entry)) return null;
        lru.Remove(entry.Node); lru.AddFirst(entry.Node); return entry.View;
    }
    internal unsafe ID3D11ShaderResourceView Put(string key, RasterizedSvg image)
    {
        var required = (long)image.Width * image.Height * 4;
        if (required > byteBudget) throw new InvalidDataException("Texture exceeds cache byte budget");
        while (values.Count > 0 && Bytes + required > byteBudget) Remove(lru.Last!.Value);
        fixed (byte* pixels = image.Pixels)
        {
            using var texture = device.CreateTexture2D(new Texture2DDescription { Width = (uint)image.Width, Height = (uint)image.Height, MipLevels = 1, ArraySize = 1, Format = Format.B8G8R8A8_UNorm, SampleDescription = new(1, 0), Usage = ResourceUsage.Immutable, BindFlags = BindFlags.ShaderResource }, new SubresourceData((nint)pixels, (uint)image.Stride));
            var view = device.CreateShaderResourceView(texture); var bytes = (long)image.Width * image.Height * 4;
            Remove(key);
            values[key] = (view, lru.AddFirst(key), bytes, image.DisplaySize.X > 0 ? (int)image.DisplaySize.X : image.Width, image.DisplaySize.Y > 0 ? (int)image.DisplaySize.Y : image.Height); Bytes += bytes;
            while (values.Count > capacity || Bytes > byteBudget) Remove(lru.Last!.Value);
            return view;
        }
    }
    private void Remove(string key) { if (!values.Remove(key, out var entry)) return; lru.Remove(entry.Node); Bytes -= entry.Bytes; entry.View.Dispose(); }
    internal void Clear() { foreach (var key in values.Keys.ToArray()) Remove(key); }
    public void Dispose() => Clear();
}
