using System.Text.Json;
using PS5PKGTool.Core.Models;
using PS5PKGTool.Core.Services;

namespace PS5PKGTool.Core.Parsers;

public sealed class Ps5TrophyReader
{
    private const int TrophyIconSize = 40;
    private readonly UcpReader _ucp = new();

    public Ps5TrophySet? Read(string gameRoot, string preferredLanguage, CancellationToken cancellationToken = default)
    {
        string path = Path.Combine(gameRoot, "sce_sys", "trophy2", "trophy00.ucp");
        if (!File.Exists(path)) return null;
        UcpArchive archive = _ucp.Read(path);
        return ReadArchive(archive, preferredLanguage, cancellationToken);
    }

    public Ps5TrophySet? Read(IReadOnlyGameFileSystem files, string preferredLanguage,
        CancellationToken cancellationToken = default)
    {
        const string path = "sce_sys/trophy2/trophy00.ucp";
        if (!files.FileExists(path)) return null;
        UcpArchive archive = _ucp.Read(path, () => files.OpenRead(path));
        return ReadArchive(archive, preferredLanguage, cancellationToken);
    }

    private Ps5TrophySet ReadArchive(UcpArchive archive, string preferredLanguage,
        CancellationToken cancellationToken)
    {
        UcpEntry configEntry = UcpReader.Find(archive, "tropconf.json")
            ?? throw new InvalidDataException("The PS5 trophy archive has no tropconf.json.");
        using JsonDocument config = JsonDocument.Parse(_ucp.ReadEntryText(archive, configEntry));
        JsonElement configRoot = config.RootElement;

        var languages = new List<string>();
        if (configRoot.TryGetProperty("languages", out JsonElement languageArray) && languageArray.ValueKind == JsonValueKind.Array)
            languages.AddRange(languageArray.EnumerateArray().Select(value => value.GetString() ?? string.Empty).Where(value => value.Length > 0));

        string defaultLanguage = GetString(configRoot, "defaultLanguage");
        string selectedLanguage = SelectLanguage(archive, preferredLanguage, defaultLanguage, languages);
        UcpEntry metadataEntry = UcpReader.Find(archive, $"tropmeta_{selectedLanguage}.json")
            ?? throw new InvalidDataException("The PS5 trophy archive has no usable localized metadata.");
        using JsonDocument metadata = JsonDocument.Parse(_ucp.ReadEntryText(archive, metadataEntry));

        Dictionary<string, (string Name, string Description)> localized = ReadLocalizedMetadata(metadata.RootElement);
        var trophies = new List<Ps5Trophy>();
        if (configRoot.TryGetProperty("trophies", out JsonElement definitions) && definitions.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement definition in definitions.EnumerateArray())
            {
                cancellationToken.ThrowIfCancellationRequested();
                string idText = GetString(definition, "id");
                _ = int.TryParse(idText, out int id);
                localized.TryGetValue(idText, out var text);
                UcpEntry? iconEntry = UcpReader.Find(archive, $"trop{idText}.png");
                byte[]? iconPng = iconEntry is null ? null : _ucp.ReadEntry(archive, iconEntry);
                int? udsStatId = null;
                if (definition.TryGetProperty("unlockCondition", out JsonElement unlockCondition) &&
                    unlockCondition.ValueKind == JsonValueKind.Object &&
                    unlockCondition.TryGetProperty("udsStatId", out JsonElement statIdValue))
                {
                    string rawStat = statIdValue.ValueKind == JsonValueKind.String
                        ? statIdValue.GetString() ?? string.Empty
                        : statIdValue.GetRawText();
                    if (int.TryParse(rawStat, out int parsedStatId)) udsStatId = parsedStatId;
                }
                trophies.Add(new Ps5Trophy
                {
                    Id = id,
                    Grade = GradeName(GetString(definition, "grade")),
                    Hidden = GetBoolean(definition, "hidden"),
                    HasReward = GetBoolean(definition, "hasReward"),
                    Name = text.Name ?? string.Empty,
                    Description = text.Description ?? string.Empty,
                    PlatinumTrophyId = GetString(definition, "platinumTrophyId"),
                    UnlockCondition = FormatUnlockCondition(definition),
                    UdsStatId = udsStatId,
                    IconPng = iconPng,
                    Icon = iconPng is null
                        ? null
                        : Ps5ImageCodec.DecodePngToRgba(iconPng, TrophyIconSize, TrophyIconSize)
                });
            }
        }

        JsonElement metadataRoot = metadata.RootElement;
        string title = string.Empty;
        if (metadataRoot.TryGetProperty("metadata", out JsonElement metadataObject) &&
            metadataObject.TryGetProperty("titleMetadata", out JsonElement titleMetadata))
            title = GetString(titleMetadata, "name");

        return new Ps5TrophySet
        {
            NpCommunicationId = GetString(configRoot, "trophyNpCommId"),
            Title = title,
            TrophySetVersion = GetString(configRoot, "trophySetVersion"),
            SelectedLanguage = selectedLanguage,
            Languages = languages,
            Trophies = trophies,
            IntegrityValid = _ucp.ValidateIntegrity(archive, cancellationToken)
        };
    }

    private static string SelectLanguage(UcpArchive archive, string preferred, string fallback, IReadOnlyList<string> languages)
    {
        bool Exists(string value) => value.Length > 0 && UcpReader.Find(archive, $"tropmeta_{value}.json") is not null;
        if (Exists(preferred)) return preferred;
        if (Exists(fallback)) return fallback;
        if (Exists("en-US")) return "en-US";
        return languages.FirstOrDefault(Exists) ?? string.Empty;
    }

    private static Dictionary<string, (string Name, string Description)> ReadLocalizedMetadata(JsonElement root)
    {
        var result = new Dictionary<string, (string, string)>(StringComparer.OrdinalIgnoreCase);
        if (!root.TryGetProperty("metadata", out JsonElement metadata) ||
            !metadata.TryGetProperty("trophyMetadata", out JsonElement trophies) || trophies.ValueKind != JsonValueKind.Array)
            return result;
        foreach (JsonElement trophy in trophies.EnumerateArray())
            result[GetString(trophy, "id")] = (GetString(trophy, "name"), GetString(trophy, "detail"));
        return result;
    }

    private static string FormatUnlockCondition(JsonElement definition)
    {
        if (!definition.TryGetProperty("unlockCondition", out JsonElement condition) || condition.ValueKind != JsonValueKind.Object)
            return string.Empty;
        string stat = GetString(condition, "udsStatId");
        string comparator = GetString(condition, "comparator");
        string target = GetString(condition, "targetValue");
        bool progressive = GetBoolean(condition, "progressive");
        string result = string.Join(' ', new[] { $"Stat {stat}", comparator, target }.Where(value => !string.IsNullOrWhiteSpace(value)));
        return progressive ? result + " (progressive)" : result;
    }

    private static string GradeName(string value) => value.ToUpperInvariant() switch
    {
        "P" => "Platinum",
        "G" => "Gold",
        "S" => "Silver",
        "B" => "Bronze",
        _ => value
    };

    private static bool GetBoolean(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.True;

    private static string GetString(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out JsonElement value)) return string.Empty;
        return value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : value.GetRawText();
    }
}
