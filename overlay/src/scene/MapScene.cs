using System.Numerics;
using EFTToolbox.Contracts;
using MapPoint = EFTToolbox.Contracts.MapPoint;

namespace EFTToolbox.Overlay;

internal sealed class MapScene
{
    internal MapData? Map { get; set; }
    internal MapPreference Preference { get; set; } = new();
    internal string Floor { get; set; } = "";
    internal string Basemap { get; set; } = "svg";
    internal Vector2 Center { get; set; }
    internal double Zoom { get; set; }
    internal int Width { get; set; } = 384;
    internal int Height { get; set; } = 384;
    internal float Dpi { get; set; } = 1;
    internal SvgRegion? SvgRegion { get; set; }
    internal Annotation[] Annotations { get; set; } = [];
    internal OwnerVisibility Owners { get; set; } = OwnerVisibility.ShowAll;
    internal Dictionary<string, PlayerState> Players { get; } = new();
    internal Vector2 Unit => Map?.Tiles.FirstOrDefault()?.Transform is { Length: 4 } a ? new((float)Math.Abs(a[0]), (float)Math.Abs(a[2])) : Vector2.One;
    internal Vector2 Scale => Unit * (float)Math.Pow(2, Zoom) * Dpi;
    internal Vector2 Screen(MapPoint p) => Screen(new Vector2((float)p.X, (float)p.Y));
    internal Vector2 Screen(Vector2 p) => (p - Center) * Scale + new Vector2(Width, Height) / 2;
    internal Vector2 MapPoint(Vector2 p) => (p - new Vector2(Width, Height) / 2) / Scale + Center;
    internal void ClampZoom()
    {
        if (Map is null) return;
        var b = Map.Projection.ViewBox; var unit = Unit * Dpi;
        var fit = Math.Log2(Math.Max(0.0001, Math.Min(Math.Max(1, Width - 48 * Dpi) / (b[2] * unit.X), Math.Max(1, Height - 48 * Dpi) / (b[3] * unit.Y)))) - 0.5;
        var min = Map.Tiles.Length > 0 ? Math.Min(Map.Tiles.Min(t => t.MinZoom), fit) : fit;
        var max = Map.Tiles.Length > 0 ? Map.Tiles.Max(t => t.MaxZoom) + 1 : 4;
        Zoom = Math.Clamp(Zoom, Math.Max(-10, min), Math.Min(12, max));
    }
    internal void Fit()
    {
        if (Map is null) return; var b = Map.Projection.ViewBox; Center = new((float)(b[0] + b[2] / 2), (float)(b[1] + b[3] / 2));
        Zoom = Math.Log2(Math.Max(0.0001, Math.Min(Math.Max(1, Width - 48 * Dpi) / (b[2] * Unit.X * Dpi), Math.Max(1, Height - 48 * Dpi) / (b[3] * Unit.Y * Dpi)))); ClampZoom();
    }
    internal Floor[] SelectableFloors() => Map?.Floors.Where(f => f.Id != Map.BaseFloor && (f.SvgGroups.Length > 0 || Basemap == "tiles" && Map.Tiles.Any(t => t.FloorId == f.Id))).ToArray() ?? [];
    internal void NormalizeFloor()
    {
        if (Map is null) return;
        if (Floor != Map.BaseFloor && !SelectableFloors().Any(f => f.Id == Floor)) Floor = Map.BaseFloor;
    }
}
