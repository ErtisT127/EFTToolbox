using System.Text.Json;
using EFTToolbox.Contracts;

namespace EFTToolbox.Overlay;

internal static class OverlaySettingsStore
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    internal static OverlaySettings Defaults => DefaultsValues.Overlay;
    // Bounds and rounding come from the generated contract constants, not from literals here.
    internal static int ClampInt(int value, NumericLimit limit) => (int)Math.Clamp(Math.Round((double)value), limit.Min, limit.Max);
    internal static double ClampNumber(double value, NumericLimit limit) => Math.Round(Math.Clamp(value, limit.Min, limit.Max), limit.Precision);
    internal static OverlaySettings Clamp(OverlaySettings v)
    {
        if (v.SvgQualityMode is not (null or "auto" or "fixed") || v.SchemaVersion != ContractVersions.ContractSchemaVersion || v.Shape is not ("square" or "circle") || v.SvgResolution is not (1024 or 2048 or 4096 or 8192) || !double.IsFinite(v.TargetZoom)) throw new InvalidDataException("Invalid overlay settings");
        var width = ClampInt(v.Width, OverlaySettingsLimits.Width);
        // A settings file written before the field existed carries no opacity at all, which is not
        // the same as a deliberate 0%.
        return v with { SvgQualityMode = v.SvgQualityMode ?? "fixed", Width = width, Height = v.Shape == "circle" ? width : ClampInt(v.Height, OverlaySettingsLimits.Height), Left = ClampInt(v.Left, OverlaySettingsLimits.Left), Top = ClampInt(v.Top, OverlaySettingsLimits.Top), TargetZoom = ClampNumber(v.TargetZoom, OverlaySettingsLimits.TargetZoom), Opacity = v.Opacity is { } opacity ? ClampInt(opacity, OverlaySettingsLimits.Opacity) : 100 };
    }
}
