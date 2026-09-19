using Vortice.Direct3D11;
using Vortice.DXGI;

namespace EFTToolbox.Overlay;

internal sealed class TextureCache(ID3D11Device device, int capacity = 128) : IDisposable
{
    private readonly Dictionary<string, (ID3D11ShaderResourceView View, LinkedListNode<string> Node, long Bytes)> values = new();
    private readonly LinkedList<string> lru = new();
    internal long Bytes { get; private set; }
    internal int Capacity => capacity;
    internal ID3D11ShaderResourceView? Find(nint id) => values.Values.FirstOrDefault(v => v.View.NativePointer == id).View;
    internal bool Contains(string key) => values.ContainsKey(key);
    internal ID3D11ShaderResourceView? Get(string key)
    {
        if (!values.TryGetValue(key, out var entry)) return null;
        lru.Remove(entry.Node); lru.AddFirst(entry.Node); return entry.View;
    }
    internal unsafe ID3D11ShaderResourceView Put(string key, RasterizedSvg image)
    {
        Remove(key);
        fixed (byte* pixels = image.Pixels)
        {
            using var texture = device.CreateTexture2D(new Texture2DDescription { Width = (uint)image.Width, Height = (uint)image.Height, MipLevels = 1, ArraySize = 1, Format = Format.B8G8R8A8_UNorm, SampleDescription = new(1, 0), Usage = ResourceUsage.Immutable, BindFlags = BindFlags.ShaderResource }, new SubresourceData((nint)pixels, (uint)image.Stride));
            var view = device.CreateShaderResourceView(texture); var bytes = (long)image.Width * image.Height * 4;
            values[key] = (view, lru.AddFirst(key), bytes); Bytes += bytes;
            while (values.Count > capacity) Remove(lru.Last!.Value);
            return view;
        }
    }
    private void Remove(string key) { if (!values.Remove(key, out var entry)) return; lru.Remove(entry.Node); Bytes -= entry.Bytes; entry.View.Dispose(); }
    internal void Clear() { foreach (var key in values.Keys.ToArray()) Remove(key); }
    public void Dispose() => Clear();
}
