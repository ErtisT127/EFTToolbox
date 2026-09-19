using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using EFTToolbox.Contracts;
using Vortice.Direct3D;
using Vortice.Direct3D11;

namespace EFTToolbox.Overlay;

internal static class TileRuntimeSelfCheck
{
    internal static async Task Run()
    {
        var root=Directory.GetCurrentDirectory();
        foreach(var id in new[]{"factory","shoreline","streetsoftarkov"})
        {
            var map=OverlayStateClient.Read<MapData>(Path.Combine(root,"data","upstream","maps",id+".json"))!;
            foreach(var tile in map.Tiles)
            {
                var z=tile.MinZoom;var t=tile.Transform;var scale=Math.Pow(2,z)/tile.TileSize;
                var a=tile.Bounds[0];var b=tile.Bounds[1];
                var firstX=(int)Math.Floor(Math.Min((t[0]*a.X+t[1])*scale,(t[0]*b.X+t[1])*scale));
                var lastX=(int)Math.Ceiling(Math.Max((t[0]*a.X+t[1])*scale,(t[0]*b.X+t[1])*scale))-1;
                var firstY=(int)Math.Floor(Math.Min((t[2]*a.Y+t[3])*scale,(t[2]*b.Y+t[3])*scale));
                var lastY=(int)Math.Ceiling(Math.Max((t[2]*a.Y+t[3])*scale,(t[2]*b.Y+t[3])*scale))-1;
                var actual=TileLayerRenderer.Indices(tile,new((float)a.X,(float)a.Y),new((float)b.X,(float)b.Y),z).ToHashSet();
                var expected=new HashSet<(int,int)>();for(int y=firstY;y<=lastY;y++)for(int x=firstX;x<=lastX;x++)expected.Add((x,y));
                Check(actual.SetEquals(expected),$"{id}/{tile.Id} affine TMS matrix");
            }
        }
        var synthetic=new TileLayer{Id="negative",TileSize=256,MinZoom=0,MaxZoom=0,Transform=[1,0,1,0],Bounds=[new(){X=-512,Y=-256},new(){X=0,Y=256}]};
        Check(TileLayerRenderer.Indices(synthetic,new(-512,-256),new(0,256),0).ToHashSet().SetEquals(new[]{(-2,-1),(-1,-1),(-2,0),(-1,0)}),"negative/non-OSM indices");
        var factory=OverlayStateClient.Read<MapData>(Path.Combine(root,"data","upstream","maps","factory.json"))!;
        var layer=factory.Tiles[0];var url=layer.SourceUrl.Replace("{z}",layer.MinZoom.ToString()).Replace("{x}","0").Replace("{y}","0");
        var key=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url))).ToLowerInvariant();
        var bytes=await File.ReadAllBytesAsync(Path.Combine(root,"data","upstream","tiles",key[..2],key+".png"));
        var image=SvgRasterizer.Decode(bytes);Check(image.Width==layer.TileSize&&image.Height==layer.TileSize,"real PNG decode");
        bool rejected=false;try{SvgRasterizer.Decode([1,2,3]);}catch(InvalidDataException){rejected=true;}Check(rejected,"corrupt PNG rejection");
        D3D11.D3D11CreateDevice(null,DriverType.Hardware,DeviceCreationFlags.BgraSupport,[FeatureLevel.Level_11_0],out ID3D11Device device,out ID3D11DeviceContext context).CheckError();
        using(device)using(context)using(var cache=new TextureCache(device,1))
        {
            cache.Put("first",image);cache.Put("second",image);Check(!cache.Contains("first")&&cache.Contains("second"),"GPU LRU eviction");
            cache.Clear();Check(cache.Bytes==0,"GPU cache release accounting");
        }
        Console.WriteLine("Tile self-check passed: real affine/TMS matrices, negative indices, PNG decode/corruption, GPU LRU and release.");
    }
    private static void Check(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
}
