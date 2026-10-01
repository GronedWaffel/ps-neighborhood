namespace PS5PKGTool.Core.Services;

/// <summary>One named rename format: a short menu <paramref name="Label"/> and its token pattern.</summary>
public sealed record Ps5RenameFormat(string Label, string Format);

/// <summary>
/// The rename format presets, mirroring the PS4PKGTool idea. The menu label is the pattern with the
/// braces removed so it reads cleanly ("TITLE [TITLE_ID]"). The custom format comes from settings.
/// </summary>
public static class Ps5RenameFormats
{
    public const string CustomLabel = "Custom (from Settings)";

    public static IReadOnlyList<Ps5RenameFormat> Presets { get; } =
    [
        new("PLATFORM TITLE [TITLE_ID]", "{PLATFORM} {TITLE} [{TITLE_ID}]"),
        new("TITLE", "{TITLE}"),
        new("TITLE [TITLE_ID]", "{TITLE} [{TITLE_ID}]"),
        new("TITLE [TITLE_ID] [VERSION]", "{TITLE} [{TITLE_ID}] [{VERSION}]"),
        new("TITLE [CATEGORY]", "{TITLE} [{CATEGORY}]"),
        new("TITLE_ID", "{TITLE_ID}"),
        new("TITLE_ID [TITLE]", "{TITLE_ID} [{TITLE}]"),
        new("[TITLE_ID] [CATEGORY] [VERSION] TITLE", "[{TITLE_ID}] [{CATEGORY}] [{VERSION}] {TITLE}"),
        new("TITLE [CATEGORY] [VERSION]", "{TITLE} [{CATEGORY}] [{VERSION}]"),
        new("CONTENT_ID", "{CONTENT_ID}"),
        new("CONTENT_ID [VERSION]", "{CONTENT_ID} [{VERSION}]"),
        new("TITLE [REGION] [CATEGORY]", "{TITLE} [{REGION}] [{CATEGORY}]")
    ];
}
