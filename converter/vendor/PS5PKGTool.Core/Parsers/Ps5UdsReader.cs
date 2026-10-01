using System.Text.Json;
using PS5PKGTool.Core.Models;
using PS5PKGTool.Core.Services;

namespace PS5PKGTool.Core.Parsers;

public sealed class Ps5UdsReader
{
    private readonly UcpReader _ucp = new();

    public Ps5UdsSummary? Read(string gameRoot, CancellationToken cancellationToken = default)
    {
        string path = Path.Combine(gameRoot, "sce_sys", "uds", "uds00.ucp");
        if (!File.Exists(path)) return null;
        UcpArchive archive = _ucp.Read(path);
        return ReadArchive(archive, cancellationToken);
    }

    public Ps5UdsSummary? Read(IReadOnlyGameFileSystem files, CancellationToken cancellationToken = default)
    {
        const string path = "sce_sys/uds/uds00.ucp";
        if (!files.FileExists(path)) return null;
        UcpArchive archive = _ucp.Read(path, () => files.OpenRead(path));
        return ReadArchive(archive, cancellationToken);
    }

    private Ps5UdsSummary ReadArchive(UcpArchive archive, CancellationToken cancellationToken)
    {
        using JsonDocument enumDocument = ReadJson(archive, "enum_definition.json");
        using JsonDocument eventDocument = ReadJson(archive, "events_definition.json");
        using JsonDocument statDocument = ReadJson(archive, "stats_definition.json");
        using JsonDocument extractionDocument = ReadJson(archive, "stats_extraction.json");

        List<Ps5UdsEvent> events = ReadEvents(eventDocument.RootElement, cancellationToken);
        List<Ps5UdsStat> stats = ReadStats(statDocument.RootElement, cancellationToken);
        List<Ps5UdsEnumGroup> enumGroups = ReadEnumGroups(enumDocument.RootElement, cancellationToken);
        List<Ps5UdsRule> rules = ReadRules(extractionDocument.RootElement, cancellationToken);

        JsonElement statRoot = statDocument.RootElement;
        string npId = GetString(statRoot, "npCommunicationId");
        if (string.IsNullOrWhiteSpace(npId)) npId = GetString(enumDocument.RootElement, "npCommunicationId");
        return new Ps5UdsSummary
        {
            NpCommunicationId = npId,
            EnumGroupCount = enumGroups.Count,
            EventCount = events.Count,
            StatCount = stats.Count,
            ExtractionRuleCount = rules.Count,
            Events = events,
            Stats = stats,
            EnumGroups = enumGroups,
            Rules = rules,
            IntegrityValid = _ucp.ValidateIntegrity(archive, cancellationToken)
        };
    }

    private static List<Ps5UdsEvent> ReadEvents(JsonElement root, CancellationToken cancellationToken)
    {
        var events = new List<Ps5UdsEvent>();
        if (!TryArray(root, "events", out JsonElement array)) return events;
        foreach (JsonElement item in array.EnumerateArray())
        {
            cancellationToken.ThrowIfCancellationRequested();
            events.Add(new Ps5UdsEvent
            {
                Name = GetString(item, "eventName"),
                Type = GetString(item, "eventType"),
                DefinitionGroup = GetString(item, "definitionGroup"),
                Properties = ReadProperties(item)
            });
        }
        return events;
    }

    private static List<Ps5UdsProperty> ReadProperties(JsonElement item)
    {
        var properties = new List<Ps5UdsProperty>();
        if (!TryArray(item, "properties", out JsonElement array)) return properties;
        foreach (JsonElement property in array.EnumerateArray())
        {
            properties.Add(new Ps5UdsProperty
            {
                Path = GetString(property, "property"),
                DataType = GetString(property, "dataType"),
                ItemType = GetString(property, "itemType"),
                MappedProperty = GetString(property, "mappedProperty")
            });
        }
        return properties;
    }

    private static List<Ps5UdsStat> ReadStats(JsonElement root, CancellationToken cancellationToken)
    {
        var stats = new List<Ps5UdsStat>();
        if (!TryArray(root, "statDefinitionArray", out JsonElement array)) return stats;
        foreach (JsonElement item in array.EnumerateArray())
        {
            cancellationToken.ThrowIfCancellationRequested();
            int enumId = 0;
            if (item.TryGetProperty("enumDefinition", out JsonElement enumDefinition) &&
                enumDefinition.ValueKind == JsonValueKind.Object)
                enumId = GetInt(enumDefinition, "enumId");
            stats.Add(new Ps5UdsStat
            {
                StatId = GetInt(item, "statId"),
                Name = GetString(item, "statName"),
                DefinitionGroup = GetString(item, "definitionGroup"),
                Origin = GetString(item, "origin"),
                DataType = GetString(item, "dataType"),
                Aggregation = GetString(item, "aggregation"),
                SourceId = GetString(item, "sourceId"),
                EnumId = enumId,
                MinValue = GetString(item, "minValue"),
                MaxValue = GetString(item, "maxValue"),
                InitialValue = GetString(item, "initialValue")
            });
        }
        return stats;
    }

    private static List<Ps5UdsEnumGroup> ReadEnumGroups(JsonElement root, CancellationToken cancellationToken)
    {
        var groups = new List<Ps5UdsEnumGroup>();
        if (!TryArray(root, "enumArray", out JsonElement array)) return groups;
        foreach (JsonElement item in array.EnumerateArray())
        {
            cancellationToken.ThrowIfCancellationRequested();
            var values = new List<string>();
            if (TryArray(item, "enumValueArray", out JsonElement valueArray))
            {
                foreach (JsonElement value in valueArray.EnumerateArray())
                {
                    string name = GetString(value, "name");
                    values.Add(string.IsNullOrEmpty(name) ? GetInt(value, "id").ToString() : name);
                }
            }
            groups.Add(new Ps5UdsEnumGroup
            {
                EnumId = GetInt(item, "enumId"),
                DefinitionGroup = GetString(item, "definitionGroup"),
                SourceId = GetString(item, "sourceId"),
                Values = values
            });
        }
        return groups;
    }

    private static List<Ps5UdsRule> ReadRules(JsonElement root, CancellationToken cancellationToken)
    {
        var rules = new List<Ps5UdsRule>();
        if (!TryArray(root, "statsExtractionRuleArray", out JsonElement array)) return rules;
        foreach (JsonElement item in array.EnumerateArray())
        {
            cancellationToken.ThrowIfCancellationRequested();
            string eventName = string.Empty;
            string condition = string.Empty;
            if (item.TryGetProperty("condition", out JsonElement conditionElement) &&
                conditionElement.ValueKind == JsonValueKind.Object)
            {
                eventName = GetString(conditionElement, "eventName");
                if (conditionElement.TryGetProperty("property", out JsonElement property) &&
                    property.ValueKind == JsonValueKind.Object)
                {
                    string text = string.Join(' ', new[]
                    {
                        GetString(property, "path"), GetString(property, "comparator"), GetString(property, "value")
                    }.Where(value => value.Length > 0));
                    condition = text;
                }
            }

            string input = string.Empty;
            string convert = string.Empty;
            int outputStatId = 0;
            string outputStatName = string.Empty;
            if (item.TryGetProperty("action", out JsonElement action) && action.ValueKind == JsonValueKind.Object)
            {
                input = GetString(action, "input");
                convert = GetString(action, "convert");
                if (action.TryGetProperty("output", out JsonElement output) && output.ValueKind == JsonValueKind.Object)
                {
                    outputStatId = GetInt(output, "statId");
                    outputStatName = GetString(output, "statName");
                }
            }

            rules.Add(new Ps5UdsRule
            {
                RuleId = GetInt(item, "ruleId"),
                DefinitionGroup = GetString(item, "definitionGroup"),
                SourceId = GetString(item, "sourceId"),
                EventName = eventName,
                Condition = condition,
                Input = input,
                Convert = convert,
                OutputStatId = outputStatId,
                OutputStatName = outputStatName
            });
        }
        return rules;
    }

    private static bool TryArray(JsonElement element, string name, out JsonElement array)
    {
        if (element.TryGetProperty(name, out array) && array.ValueKind == JsonValueKind.Array) return true;
        array = default;
        return false;
    }

    private static int GetInt(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out JsonElement value)) return 0;
        return value.ValueKind switch
        {
            JsonValueKind.Number when value.TryGetInt32(out int number) => number,
            JsonValueKind.String when int.TryParse(value.GetString(), out int parsed) => parsed,
            _ => 0
        };
    }


    private JsonDocument ReadJson(UcpArchive archive, string name)
    {
        UcpEntry entry = UcpReader.Find(archive, name) ?? throw new InvalidDataException($"UDS archive has no {name}.");
        return JsonDocument.Parse(_ucp.ReadEntryText(archive, entry));
    }

    private static int ArrayLength(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.Array ? value.GetArrayLength() : 0;

    private static string GetString(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;
}
