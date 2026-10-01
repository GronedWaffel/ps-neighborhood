using System.Text;
using System.Text.RegularExpressions;

namespace PS5PKGTool.Core.Services;

/// <summary>Resolved values for the rename format tokens. Empty values drop out of the result.</summary>
public sealed record Ps5RenameTokens(
    string Title = "",
    string TitleId = "",
    string ContentId = "",
    string ConceptId = "",
    string Version = "",
    string ContentVersion = "",
    string MasterVersion = "",
    string Category = "",
    string Region = "",
    string Platform = "",
    string SystemVersion = "",
    string SdkVersion = "",
    string Source = "",
    string Size = "",
    string Language = "",
    string Drm = "",
    string Date = "",
    string Tool = "")
{
    public static readonly Ps5RenameTokens Empty = new();
}

/// <summary>
/// Expands a user rename format such as <c>{TITLE} [{TITLE_ID}]</c> into a safe base name (no
/// extension). Unknown tokens are left in place so the user can see and fix a mistake, and empty
/// values collapse their surrounding brackets and separators.
/// </summary>
public static class Ps5RenameFormatter
{
    private static readonly (string Token, Func<Ps5RenameTokens, string> Selector)[] TokenTable =
    [
        ("{TITLE}", tokens => tokens.Title),
        ("{TITLE_ID}", tokens => tokens.TitleId),
        ("{CONTENT_ID}", tokens => tokens.ContentId),
        ("{CONCEPT_ID}", tokens => tokens.ConceptId),
        ("{VERSION}", tokens => tokens.Version),
        ("{CONTENT_VERSION}", tokens => tokens.ContentVersion),
        ("{MASTER_VERSION}", tokens => tokens.MasterVersion),
        ("{CATEGORY}", tokens => tokens.Category),
        ("{REGION}", tokens => tokens.Region),
        ("{PLATFORM}", tokens => tokens.Platform),
        ("{SYSTEM_VERSION}", tokens => tokens.SystemVersion),
        ("{SDK_VERSION}", tokens => tokens.SdkVersion),
        ("{SOURCE}", tokens => tokens.Source),
        ("{SIZE}", tokens => tokens.Size),
        ("{LANGUAGE}", tokens => tokens.Language),
        ("{DRM}", tokens => tokens.Drm),
        ("{DATE}", tokens => tokens.Date),
        ("{TOOL}", tokens => tokens.Tool)
    ];

    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        "CONIN$", "CONOUT$"
    };

    /// <summary>The token names, for the settings help text and for validation.</summary>
    public static IReadOnlyList<string> TokenNames { get; } = TokenTable.Select(entry => entry.Token).ToArray();

    /// <summary>Expands <paramref name="format"/> into a safe base name, falling back when empty.</summary>
    public static string Expand(string? format, Ps5RenameTokens tokens, string fallback)
    {
        string result = format ?? string.Empty;
        if (string.IsNullOrWhiteSpace(result))
            return Sanitize(fallback);

        foreach ((string token, Func<Ps5RenameTokens, string> selector) in TokenTable)
            result = result.Replace(token, selector(tokens), StringComparison.OrdinalIgnoreCase);

        // Drop empty bracket groups (allowing inner spaces), then normalise.
        result = Regex.Replace(result, @"\[\s*\]", string.Empty);
        result = Regex.Replace(result, @"\(\s*\)", string.Empty);
        result = CollapseWhitespace(result);
        result = Sanitize(result);
        return result.Length == 0 ? Sanitize(fallback) : result;
    }

    /// <summary>Replaces characters Windows forbids and guards reserved device names.</summary>
    public static string Sanitize(string value)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        char[] invalid = Path.GetInvalidFileNameChars();
        var builder = new StringBuilder(value.Length);
        foreach (char character in value)
            builder.Append(Array.IndexOf(invalid, character) >= 0 ? '_' : character);
        string result = builder.ToString().Trim(' ', '.', '-', '_');
        return ReservedNames.Contains(result) ? "_" + result : result;
    }

    private static string CollapseWhitespace(string value)
    {
        var builder = new StringBuilder(value.Length);
        bool lastWasSpace = false;
        foreach (char character in value)
        {
            if (char.IsWhiteSpace(character))
            {
                if (!lastWasSpace && builder.Length > 0) builder.Append(' ');
                lastWasSpace = true;
                continue;
            }
            builder.Append(character);
            lastWasSpace = false;
        }
        return builder.ToString().TrimEnd();
    }
}
