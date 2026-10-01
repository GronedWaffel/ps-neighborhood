using System.Text.Json.Serialization;

namespace PS5PKGTool.Core.Models;

public enum Ps5SourceKind
{
    LooseDump,
    SonyPackage,
    Ffpfsc,
    FilesystemImage,
    Ffpkg
}

public sealed class Ps5GameInfo
{
    public Ps5SourceKind SourceKind { get; set; }
    public string RootPath { get; set; } = string.Empty;
    public string ParamPath { get; set; } = string.Empty;
    public string VirtualRoot { get; set; } = string.Empty;
    public long SourceSize { get; set; }
    public string ContainerInnerFileName { get; set; } = string.Empty;
    /// <summary>Host container file length (the on-disk image/PKG size), distinct from logical sizes.</summary>
    public long ContainerFileLength { get; set; }
    /// <summary>Logical length of the image's inner filesystem (not the container file, not a file sum).</summary>
    public long ContainerLogicalSize { get; set; }
    /// <summary>Stored/compressed extent of the inner filesystem (wrapper length for FFPFSC).</summary>
    public long ContainerStoredSize { get; set; }
    public int ContainerBlockCount { get; set; }
    /// <summary>Sum of the files exposed under the selected game root (set once the inventory is read).</summary>
    public long GameRootBytes { get; set; }
    public string Title { get; set; } = string.Empty;
    public string TitleId { get; set; } = string.Empty;
    public string ContentId { get; set; } = string.Empty;
    public string ConceptId { get; set; } = string.Empty;
    public string ContentVersion { get; set; } = string.Empty;
    public string MasterVersion { get; set; } = string.Empty;
    public string TargetContentVersion { get; set; } = string.Empty;
    public string OriginContentVersion { get; set; } = string.Empty;
    public string RequiredSystemSoftware { get; set; } = string.Empty;
    public string SdkVersion { get; set; } = string.Empty;
    public string ApplicationCategory { get; set; } = string.Empty;
    public string DrmType { get; set; } = string.Empty;
    public string ContentBadgeType { get; set; } = string.Empty;
    public string DefaultLanguage { get; set; } = string.Empty;
    public Dictionary<string, string> LocalizedTitles { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, int> AgeLevels { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public List<string> DeclaredFeatures { get; set; } = [];
    public List<string> GameIntents { get; set; } = [];
    public List<string> SharedAddOnServiceIds { get; set; } = [];
    public uint Attribute { get; set; }
    public uint Attribute2 { get; set; }
    public uint Attribute3 { get; set; }
    public uint Attribute4 { get; set; }
    public long DownloadDataSize { get; set; }
    public long? FlexibleMemorySize { get; set; }
    public string CreationDate { get; set; } = string.Empty;
    public string ToolVersion { get; set; } = string.Empty;
    public string VersionFileUri { get; set; } = string.Empty;
    public string RawParamJson { get; set; } = string.Empty;
    public List<string> DataWarnings { get; set; } = [];
    public DateTime LastWriteTimeUtc { get; set; }
    public SonyPkgSummary? Package { get; set; }

    public string DisplayVersion => string.IsNullOrWhiteSpace(ContentVersion) ? MasterVersion : ContentVersion;

    /// <summary>
    /// Best-effort console generation inferred from the product code (the first four title ID
    /// characters, or the content ID's title segment). Items read by this app are PS5; a PS4 code
    /// such as CUSA, PCAS, or PLAS is reported as PS4.
    /// </summary>
    [JsonIgnore]
    public string Platform
    {
        get
        {
            string code = TitleId.Length >= 4
                ? TitleId[..4].ToUpperInvariant()
                : ContentId.Length >= 11 ? ContentId.Substring(7, 4).ToUpperInvariant() : string.Empty;
            return code.StartsWith("CU", StringComparison.Ordinal) ||
                   code.StartsWith("PC", StringComparison.Ordinal) ||
                   code.StartsWith("PL", StringComparison.Ordinal)
                ? "PS4"
                : "PS5";
        }
    }

    public string SourceDescription => SourceKind switch
    {
        Ps5SourceKind.SonyPackage => Package is { Kind: SonyPkgKind.FinalizedDebug }
            ? "Debug PKG"
            : Package?.KindDisplayName ?? "PKG",
        Ps5SourceKind.Ffpfsc => "FFPFSC",
        Ps5SourceKind.FilesystemImage => "exFAT",
        Ps5SourceKind.Ffpkg => "FFPKG",
        _ => "Dump Files"
    };
}
