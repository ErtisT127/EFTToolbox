using System.Numerics;

namespace EFTToolbox.Overlay;

// Shared by hit testing (OverlayApplication) and drawing (OverlayRenderer): a handle has to be
// grabbable exactly where it is painted, so both sides read the same geometry.
internal static class OverlayGeometry
{
    internal const int Inset = 10;
    internal const float HandleHit = 12, CircleHandleHit = 14, RingWidth = 26, CircleRing = 16;

    internal static readonly int[] SquareHandles = [3, 4, 5, 6, 7, 8, 9, 10];
    internal static readonly int[] CircleHandles = [4, 6, 8, 10];

    internal static float Radius(int width, int height) => Math.Min(width, height) / 2f - Inset;

    internal static Vector2 Handle(int handle, int width, int height) => handle switch
    {
        3 => new(Inset, Inset),
        4 => new(width / 2f, Inset),
        5 => new(width - Inset, Inset),
        6 => new(width - Inset, height / 2f),
        7 => new(width - Inset, height - Inset),
        8 => new(width / 2f, height - Inset),
        9 => new(Inset, height - Inset),
        _ => new(Inset, height / 2f),
    };

    internal static Vector2 CircleHandle(int handle, int width, int height) => handle switch
    {
        4 => Center(width, height) + new Vector2(0, -Radius(width, height)),
        6 => Center(width, height) + new Vector2(Radius(width, height), 0),
        8 => Center(width, height) + new Vector2(0, Radius(width, height)),
        _ => Center(width, height) + new Vector2(-Radius(width, height), 0),
    };

    private static Vector2 Center(int width, int height) => new(width / 2f, height / 2f);
}
