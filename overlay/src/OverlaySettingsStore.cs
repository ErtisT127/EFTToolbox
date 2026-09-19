using System.Text.Json;
using EFTToolbox.Contracts;

namespace EFTToolbox.Overlay;

internal static class OverlaySettingsStore
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    internal static OverlaySettings Defaults => new() { SchemaVersion = 1, Visible = true, Shape = "square", Width = 384, Height = 384, Left = 24, Top = 24, SvgResolution = 2048, FollowCenter = true, FollowFloor = true, FollowZoom = true, TargetZoom = 2 };
    internal static OverlaySettings Clamp(OverlaySettings v)
    {
        if (v.SchemaVersion != 1 || v.Shape is not ("square" or "circle") || v.SvgResolution is not (1024 or 2048 or 4096) || !double.IsFinite(v.TargetZoom)) throw new InvalidDataException("Invalid overlay settings");
        var width = Math.Clamp(v.Width, 160, 2048);
        return v with { Width = width, Height = v.Shape == "circle" ? width : Math.Clamp(v.Height, 160, 2048), Left = Math.Clamp(v.Left, -100000, 100000), Top = Math.Clamp(v.Top, -100000, 100000), TargetZoom = Math.Clamp(v.TargetZoom, -10, 12) };
    }
}
