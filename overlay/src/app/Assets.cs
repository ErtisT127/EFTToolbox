namespace EFTToolbox.Overlay;

internal static class Assets
{
    // Asset references are backend paths like /api/assets/items/item-<hash>.webp; the part after
    // the prefix resolves under the bootstrap asset directory. Null means the URL is not a safe
    // asset path, which callers treat like a missing file instead of guessing a location.
    internal static string? LocalPath(string root, string url)
    {
        if (!url.StartsWith("/api/assets/", StringComparison.Ordinal)) return null;
        var relative = url["/api/assets/".Length..];
        if (relative.Length == 0 || relative.Contains('\\') || relative.EndsWith('/')) return null;
        foreach (var segment in relative.Split('/'))
            if (segment.Length == 0 || segment == "." || segment == "..") return null;
        var full = Path.GetFullPath(Path.Combine(root, relative));
        var boundary = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return full.StartsWith(boundary, StringComparison.Ordinal) ? full : null;
    }
}
