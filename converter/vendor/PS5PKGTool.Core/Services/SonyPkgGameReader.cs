using System.Text;
using System.Text.RegularExpressions;
using PS5PKGTool.Core.Models;
using PS5PKGTool.Core.Parsers;

namespace PS5PKGTool.Core.Services;

public sealed partial class SonyPkgGameReader
{
    private const int MaximumParamJsonSize = 16 * 1024 * 1024;
    private readonly SonyPkgReader _packageReader = new();
    private readonly Ps5ParamReader _paramReader = new();

    public Ps5GameInfo Read(string packagePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packagePath);
        string fullPath = Path.GetFullPath(packagePath);
        SonyPkgSummary package = _packageReader.Read(fullPath);
        DateTime lastWrite = File.GetLastWriteTimeUtc(fullPath);
        string inferredContentId = ExtractContentId(Path.GetFileNameWithoutExtension(fullPath));
        string effectiveContentId = string.IsNullOrWhiteSpace(package.ContentId)
            ? inferredContentId
            : package.ContentId;
        SonyPkgEntry? paramEntry = package.Entries.FirstOrDefault(entry => entry.Id == 0x2000 && !entry.IsEncrypted);

        Ps5GameInfo game;
        if (paramEntry is not null && paramEntry.DataSize <= MaximumParamJsonSize)
        {
            byte[] data = ReadParamBytes(fullPath, package, paramEntry);
            string raw = Encoding.UTF8.GetString(data).TrimStart('\uFEFF').TrimEnd('\0');
            game = _paramReader.ReadJson(raw, fullPath + "::sce_sys/param.json", fullPath, lastWrite);
        }
        else if (TryReadInnerParamJson(package, out string innerJson, out string innerOrigin))
        {
            // The outer CNT entry is absent (or too large), but the inner PFS may still expose
            // sce_sys/param.json when the game filesystem is readable. Record the inner origin so the
            // Raw tab can state where the JSON came from.
            game = _paramReader.ReadJson(innerJson, innerOrigin, fullPath, lastWrite);
        }
        else
        {
            string fallbackTitle = Path.GetFileNameWithoutExtension(fullPath);
            game = new Ps5GameInfo
            {
                RootPath = fullPath,
                ParamPath = string.Empty,
                Title = string.IsNullOrWhiteSpace(fallbackTitle) ? "Unknown PS5 Package" : fallbackTitle,
                ContentId = effectiveContentId,
                TitleId = ExtractTitleId(effectiveContentId),
                LastWriteTimeUtc = lastWrite
            };
            game.DataWarnings.Add(paramEntry is null
                ? "An unencrypted param.json entry was not available in the CNT metadata."
                : "param.json exceeds the safe metadata read limit.");
        }

        game.SourceKind = Ps5SourceKind.SonyPackage;
        game.RootPath = fullPath;
        game.SourceSize = package.FileSize;
        game.Package = package;
        if (string.IsNullOrWhiteSpace(game.ContentId)) game.ContentId = effectiveContentId;
        if (string.IsNullOrWhiteSpace(game.TitleId)) game.TitleId = ExtractTitleId(game.ContentId);
        if (string.IsNullOrWhiteSpace(package.ContentId) && !string.IsNullOrWhiteSpace(inferredContentId))
            game.DataWarnings.Add("The content ID and title ID were inferred from the standard Sony package filename.");
        if (package.Kind == SonyPkgKind.FinalizedRetail && package.Entries.Count == 0)
            game.DataWarnings.Add("This retail FIH has no embedded CNT metadata. Detailed game metadata and artwork are inside the encrypted PFS and require the matching retail image key.");
        if (!string.IsNullOrWhiteSpace(package.ContentId) &&
            !string.IsNullOrWhiteSpace(game.ContentId) &&
            !string.Equals(package.ContentId, game.ContentId, StringComparison.Ordinal))
            game.DataWarnings.Add($"CNT content ID '{package.ContentId}' differs from param.json content ID '{game.ContentId}'.");
        if (package.FormatVersion is not null and not 3)
            game.DataWarnings.Add($"FIH format version is {package.FormatVersion}; version 3 is normally expected.");
        if (package.EncryptedEntryCount > 0)
            game.DataWarnings.Add($"{package.EncryptedEntryCount:N0} CNT entr{(package.EncryptedEntryCount == 1 ? "y is" : "ies are")} encrypted.");
        return game;
    }

    /// <summary>
    /// Fallback for packages whose outer CNT has no readable param.json entry: read the copy inside
    /// the inner PFS when the game filesystem decodes. Returns false when it is unavailable.
    /// </summary>
    private static bool TryReadInnerParamJson(SonyPkgSummary package, out string raw, out string origin)
    {
        raw = string.Empty;
        origin = string.Empty;
        if (package.NestedPfs?.EngineAccess is not { } access)
            return false;
        try
        {
            if (!access.TryFindFile("sce_sys/param.json",
                    out ProsperoPkgTool.Containers.ProsperoInnerPfsReader.Entry entry) ||
                entry.Size <= 0 || entry.Size > MaximumParamJsonSize)
                return false;
            byte[] data = access.ReadFile(entry);
            raw = Encoding.UTF8.GetString(data).TrimStart('\uFEFF').TrimEnd('\0');
            if (raw.Length == 0) return false;
            origin = "inner PFS sce_sys/param.json";
            return true;
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException or
                                   NotSupportedException or ArgumentException)
        {
            return false;
        }
    }

    // Reads param.json through the already-parsed engine access when available, so the package is
    // not re-parsed a third time just to read its metadata entry.
    private byte[] ReadParamBytes(string fullPath, SonyPkgSummary package, SonyPkgEntry paramEntry) =>
        package.NestedPfs?.EngineAccess is { } access
            ? access.ReadCntEntry(paramEntry.Id, paramEntry.DataSize)
            : _packageReader.ReadEntryBytes(fullPath, package, paramEntry, MaximumParamJsonSize);

    private static string ExtractTitleId(string contentId)
    {
        Match match = TitleIdPattern().Match(contentId ?? string.Empty);
        return match.Success ? match.Value.ToUpperInvariant() : string.Empty;
    }

    private static string ExtractContentId(string value)
    {
        Match match = ContentIdPattern().Match(value ?? string.Empty);
        return match.Success ? match.Value.ToUpperInvariant() : string.Empty;
    }

    [GeneratedRegex(@"PPSA\d{5}", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex TitleIdPattern();

    [GeneratedRegex(@"[A-Z]{2}\d{4}-PPSA\d{5}_\d{2}-[A-Z0-9]{16}",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ContentIdPattern();
}
