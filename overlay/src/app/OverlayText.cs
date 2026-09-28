namespace EFTToolbox.Overlay;

/// <summary>
/// The overlay's own strings. The dashboard's i18n cannot reach this process, so the panel keeps its
/// few labels here in the two languages the tool ships with; the language follows the user settings
/// (applied on connect and whenever a settings write broadcasts) and defaults to Chinese.
/// </summary>
internal static class OverlayText
{
    internal static string Language { get; set; } = "zh-CN";

    private static readonly Dictionary<string, Dictionary<string, string>> Table = new()
    {
        ["recognition.title"] = new() { ["zh-CN"] = "识别结果", ["en-US"] = "Recognition results" },
        ["recognition.name"] = new() { ["zh-CN"] = "名称", ["en-US"] = "Name" },
        ["recognition.trader"] = new() { ["zh-CN"] = "出售给商人", ["en-US"] = "To trader" },
        ["recognition.flea"] = new() { ["zh-CN"] = "出售给跳蚤市场", ["en-US"] = "To flea market" },
        ["recognition.loading"] = new() { ["zh-CN"] = "正在识别…", ["en-US"] = "Recognizing…" },
        ["recognition.empty"] = new() { ["zh-CN"] = "未找到匹配物品", ["en-US"] = "No matching items" },
        ["recognition.failed"] = new() { ["zh-CN"] = "识别失败", ["en-US"] = "Recognition failed" },
        // The pipeline reports stable short codes, so the panel completes the sentence here rather
        // than pasting an internal code where the reason belongs.
        ["recognition.error.image_invalid"] = new() { ["zh-CN"] = "识别失败：图片无效", ["en-US"] = "Recognition failed: invalid image" },
        ["recognition.error.ocr_empty"] = new() { ["zh-CN"] = "识别失败：未识别到文字", ["en-US"] = "Recognition failed: no text recognized" },
        ["recognition.error.ocr_failed"] = new() { ["zh-CN"] = "识别失败：请重试", ["en-US"] = "Recognition failed: try again" },
    };

    internal static string Get(string key, params object[] arguments)
    {
        if (!Table.TryGetValue(key, out var entries)) return key;
        if (!entries.TryGetValue(Language, out var text) && !entries.TryGetValue("zh-CN", out text)) return key;
        return arguments.Length == 0 ? text : string.Format(text, arguments);
    }

    /// <summary>Expands the code the pipeline reports into the sentence the panel shows; a code this
    /// table does not know still gets the generic failure instead of its raw name.</summary>
    internal static string RecognitionError(string code) =>
        Table.ContainsKey($"recognition.error.{code}") ? Get($"recognition.error.{code}") : Get("recognition.failed");
}
