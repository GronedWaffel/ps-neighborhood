using System.Globalization;
using System.Text.Json;
using PS5PKGTool.Core.Models;

namespace PS5PKGTool.Core.Parsers;

public sealed class Ps5ParamReader
{
    public Ps5GameInfo Read(string paramPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(paramPath);
        string raw = File.ReadAllText(paramPath);
        string gameRoot = Directory.GetParent(Path.GetDirectoryName(paramPath)!)?.FullName
            ?? throw new InvalidDataException("param.json is not inside sce_sys.");
        return ReadJson(raw, paramPath, gameRoot, File.GetLastWriteTimeUtc(paramPath));
    }

    public Ps5GameInfo ReadJson(string raw, string paramLocation, string sourcePath, DateTime lastWriteTimeUtc)
    {
        ArgumentNullException.ThrowIfNull(raw);
        ArgumentException.ThrowIfNullOrWhiteSpace(paramLocation);
        ArgumentException.ThrowIfNullOrWhiteSpace(sourcePath);
        using JsonDocument document = JsonDocument.Parse(raw, new JsonDocumentOptions
        {
            AllowTrailingCommas = true,
            CommentHandling = JsonCommentHandling.Skip
        });

        JsonElement root = document.RootElement;
        var warnings = new List<string>();
        var localizedTitles = ReadLocalizedTitles(root, out string defaultLanguage);
        string title = ResolveTitle(localizedTitles, defaultLanguage, sourcePath, warnings);
        uint attribute = GetUInt32(root, "attribute");
        uint attribute2 = GetUInt32(root, "attribute2");
        uint attribute3 = GetUInt32(root, "attribute3");
        uint attribute4 = GetUInt32(root, "attribute4");

        string titleId = GetString(root, "titleId");
        string contentId = GetString(root, "contentId");
        if (string.IsNullOrWhiteSpace(titleId)) warnings.Add("Title ID is missing.");
        if (string.IsNullOrWhiteSpace(contentId)) warnings.Add("Content ID is missing.");
        if (!string.IsNullOrWhiteSpace(defaultLanguage) && !localizedTitles.ContainsKey(defaultLanguage))
            warnings.Add($"Default language '{defaultLanguage}' has no localized title.");
        if (string.IsNullOrWhiteSpace(defaultLanguage))
            warnings.Add("Default language is missing; a fallback title was selected.");

        return new Ps5GameInfo
        {
            SourceKind = Ps5SourceKind.LooseDump,
            RootPath = sourcePath,
            ParamPath = paramLocation,
            Title = title,
            TitleId = titleId,
            ContentId = contentId,
            ConceptId = GetString(root, "conceptId"),
            ContentVersion = GetString(root, "contentVersion"),
            MasterVersion = GetString(root, "masterVersion"),
            TargetContentVersion = GetString(root, "targetContentVersion"),
            OriginContentVersion = GetString(root, "originContentVersion"),
            RequiredSystemSoftware = FormatSystemVersion(GetString(root, "requiredSystemSoftwareVersion")),
            SdkVersion = FormatSystemVersion(GetString(root, "sdkVersion")),
            ApplicationCategory = FormatNumericOrString(root, "applicationCategoryType"),
            DrmType = GetString(root, "applicationDrmType"),
            ContentBadgeType = FormatNumericOrString(root, "contentBadgeType"),
            DefaultLanguage = defaultLanguage,
            LocalizedTitles = localizedTitles,
            AgeLevels = ReadAgeLevels(root),
            DeclaredFeatures = DecodeFeatures(attribute, attribute2, attribute3, attribute4),
            GameIntents = ReadGameIntents(root),
            SharedAddOnServiceIds = ReadSharedAddOnIds(root),
            Attribute = attribute,
            Attribute2 = attribute2,
            Attribute3 = attribute3,
            Attribute4 = attribute4,
            DownloadDataSize = GetInt64(root, "downloadDataSize"),
            FlexibleMemorySize = ReadFlexibleMemory(root),
            CreationDate = ReadNestedString(root, "pubtools", "creationDate"),
            ToolVersion = ReadNestedString(root, "pubtools", "toolVersion"),
            VersionFileUri = GetString(root, "versionFileUri").Trim(),
            RawParamJson = raw,
            DataWarnings = warnings,
            LastWriteTimeUtc = lastWriteTimeUtc
        };
    }

    private static Dictionary<string, string> ReadLocalizedTitles(JsonElement root, out string defaultLanguage)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        defaultLanguage = string.Empty;
        if (!root.TryGetProperty("localizedParameters", out JsonElement localized) || localized.ValueKind != JsonValueKind.Object)
            return result;

        defaultLanguage = GetString(localized, "defaultLanguage");
        foreach (JsonProperty property in localized.EnumerateObject())
        {
            if (property.NameEquals("defaultLanguage") || property.Value.ValueKind != JsonValueKind.Object) continue;
            string title = GetString(property.Value, "titleName");
            if (!string.IsNullOrWhiteSpace(title)) result[property.Name] = title;
        }
        return result;
    }

    private static string ResolveTitle(Dictionary<string, string> localized, string defaultLanguage,
        string sourcePath, List<string> warnings)
    {
        string title = string.Empty;
        if (!string.IsNullOrWhiteSpace(defaultLanguage)) localized.TryGetValue(defaultLanguage, out title!);
        if (string.IsNullOrWhiteSpace(title)) localized.TryGetValue("en-US", out title!);
        if (string.IsNullOrWhiteSpace(title)) title = localized.Values.FirstOrDefault() ?? string.Empty;
        if (LooksLikePlaceholder(title))
        {
            warnings.Add($"Localized title '{title}' looks invalid; the folder name was used.");
            title = string.Empty;
        }
        if (!string.IsNullOrWhiteSpace(title)) return title;

        string folderName = File.Exists(sourcePath)
            ? Path.GetFileNameWithoutExtension(sourcePath)
            : Path.GetFileName(sourcePath.TrimEnd(Path.DirectorySeparatorChar));
        int marker = folderName.IndexOf(" PS5 Dump", StringComparison.OrdinalIgnoreCase);
        if (marker > 0) folderName = folderName[..marker];
        if (folderName.EndsWith("-app", StringComparison.OrdinalIgnoreCase)) folderName = folderName[..^4];
        return string.IsNullOrWhiteSpace(folderName) ? "Unknown PS5 Game" : folderName;
    }

    private static bool LooksLikePlaceholder(string value) =>
        string.Equals(value, "pundek", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(value, "unknown", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(value, "title", StringComparison.OrdinalIgnoreCase);

    private static Dictionary<string, int> ReadAgeLevels(JsonElement root)
    {
        var result = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        if (!root.TryGetProperty("ageLevel", out JsonElement age) || age.ValueKind != JsonValueKind.Object) return result;
        foreach (JsonProperty property in age.EnumerateObject())
            if (property.Value.TryGetInt32(out int level)) result[property.Name] = level;
        return result;
    }

    private static List<string> ReadGameIntents(JsonElement root)
    {
        var result = new List<string>();
        if (!root.TryGetProperty("gameIntent", out JsonElement gameIntent) ||
            !gameIntent.TryGetProperty("permittedIntents", out JsonElement intents) || intents.ValueKind != JsonValueKind.Array)
            return result;
        foreach (JsonElement item in intents.EnumerateArray())
        {
            string value = GetString(item, "intentType");
            if (!string.IsNullOrWhiteSpace(value)) result.Add(value);
        }
        return result;
    }

    private static List<string> ReadSharedAddOnIds(JsonElement root)
    {
        var result = new List<string>();
        if (!root.TryGetProperty("addcont", out JsonElement addcont) ||
            !addcont.TryGetProperty("serviceIdForSharing", out JsonElement ids) || ids.ValueKind != JsonValueKind.Array)
            return result;
        foreach (JsonElement item in ids.EnumerateArray())
        {
            string value = item.ValueKind == JsonValueKind.String ? item.GetString()?.Trim() ?? string.Empty : string.Empty;
            if (!string.IsNullOrWhiteSpace(value)) result.Add(value);
        }
        return result;
    }

    private static long? ReadFlexibleMemory(JsonElement root)
    {
        if (!root.TryGetProperty("kernel", out JsonElement kernel) ||
            !kernel.TryGetProperty("flexibleMemorySize", out JsonElement value) || !value.TryGetInt64(out long size))
            return null;
        return size;
    }

    private static List<string> DecodeFeatures(uint attribute, uint attribute2, uint attribute3, uint attribute4)
    {
        var result = new List<string>();
        if ((attribute & (1u << 29)) != 0) result.Add("HDR");
        if ((attribute3 & (1u << 6)) != 0) result.Add("120 Hz");
        if ((attribute3 & (1u << 10)) != 0) result.Add("PS VR2 supported");
        if ((attribute3 & (1u << 11)) != 0) result.Add("PS VR2 required");
        if ((attribute3 & (1u << 18)) != 0) result.Add("VRR");
        if ((attribute3 & (1u << 19)) != 0) result.Add("VRR 120 Hz");
        if ((attribute3 & (1u << 20)) != 0) result.Add("VRR disabled");
        if ((attribute3 & (1u << 22)) != 0) result.Add("PS5 Pro");
        if ((attribute3 & (1u << 23)) != 0) result.Add("PS5 Pro 8K");
        if ((attribute4 & 1u) != 0) result.Add("Power Saver");
        if (attribute2 != 0) result.Add($"Attribute2 0x{attribute2:X8}");
        return result;
    }

    public static string FormatSystemVersion(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        string hex = value.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? value[2..] : value;
        if (hex.Length < 4 || !ulong.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out _)) return value;
        string major = hex[..2].TrimStart('0');
        if (major.Length == 0) major = "0";
        return $"{major}.{hex.Substring(2, 2)}";
    }

    private static string ReadNestedString(JsonElement root, string objectName, string propertyName) =>
        root.TryGetProperty(objectName, out JsonElement nested) ? GetString(nested, propertyName) : string.Empty;

    private static string GetString(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out JsonElement value)) return string.Empty;
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? string.Empty,
            JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False => value.GetRawText(),
            _ => string.Empty
        };
    }

    private static string FormatNumericOrString(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value)) return string.Empty;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetUInt32(out uint number)) return $"{number} (0x{number:X8})";
        return value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : value.GetRawText();
    }

    private static uint GetUInt32(JsonElement root, string name) =>
        root.TryGetProperty(name, out JsonElement value) && value.TryGetUInt32(out uint result) ? result : 0;

    private static long GetInt64(JsonElement root, string name) =>
        root.TryGetProperty(name, out JsonElement value) && value.TryGetInt64(out long result) ? result : 0;
}
