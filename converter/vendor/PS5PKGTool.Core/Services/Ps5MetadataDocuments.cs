using System.Text.Json;
using System.Text.Json.Nodes;

namespace PS5PKGTool.Core.Services;

public sealed class Ps5JsonDocumentModel
{
    private Ps5JsonDocumentModel(JsonObject root) => Root = root;
    public JsonObject Root { get; }

    public static Ps5JsonDocumentModel Load(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        return Parse(File.ReadAllText(path));
    }

    public static Ps5JsonDocumentModel Parse(string json)
    {
        JsonNode? node = JsonNode.Parse(json, documentOptions: new JsonDocumentOptions
        { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
        return new Ps5JsonDocumentModel(node as JsonObject ?? throw new InvalidDataException("The JSON root must be an object."));
    }

    public string GetString(string name) => Root[name]?.GetValue<string>()?.Trim() ?? string.Empty;
    public void SetString(string name, string? value) => Root[name] = value ?? string.Empty;

    public void SaveAtomic(string path)
    {
        string destination = Path.GetFullPath(path);
        string? parent = Path.GetDirectoryName(destination);
        if (string.IsNullOrWhiteSpace(parent)) throw new ArgumentException("The JSON path has no parent directory.", nameof(path));
        Directory.CreateDirectory(parent);
        string temporary = Path.Combine(parent, "." + Path.GetFileName(destination) + "." + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            File.WriteAllText(temporary, Root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            File.Move(temporary, destination, true);
        }
        finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch (IOException) { } }
    }
}

public sealed class Ps5ParamDocument
{
    private readonly Ps5JsonDocumentModel _document;
    private Ps5ParamDocument(Ps5JsonDocumentModel document) => _document = document;
    public JsonObject Root => _document.Root;
    public string ContentId { get => _document.GetString("contentId"); set => _document.SetString("contentId", value); }
    public string TitleId { get => _document.GetString("titleId"); set => _document.SetString("titleId", value); }
    public string ContentVersion { get => _document.GetString("contentVersion"); set => _document.SetString("contentVersion", value); }
    public string ApplicationDrmType { get => _document.GetString("applicationDrmType"); set => _document.SetString("applicationDrmType", value); }
    public static Ps5ParamDocument Load(string path) => new(Ps5JsonDocumentModel.Load(path));
    public static Ps5ParamDocument Create(string contentId, string titleId, string title, string language = "en-US")
    {
        var model = Ps5JsonDocumentModel.Parse("{}");
        model.SetString("contentId", contentId);
        model.SetString("titleId", titleId);
        model.SetString("contentVersion", "01.000.000");
        model.SetString("applicationDrmType", "free");
        model.Root["localizedParameters"] = new JsonObject
        {
            ["defaultLanguage"] = language,
            [language] = new JsonObject { ["titleName"] = title }
        };
        return new Ps5ParamDocument(model);
    }
    public void SetLocalizedTitle(string language, string title)
    {
        if (string.IsNullOrWhiteSpace(language)) throw new ArgumentException("Language is required.", nameof(language));
        JsonObject localized = Root["localizedParameters"] as JsonObject ?? new JsonObject();
        localized[language] = new JsonObject { ["titleName"] = title };
        if (localized["defaultLanguage"] is null) localized["defaultLanguage"] = language;
        Root["localizedParameters"] = localized;
    }
    public void SaveAtomic(string path) => _document.SaveAtomic(path);
}

public sealed class Ps5ManifestDocument
{
    private readonly Ps5JsonDocumentModel _document;
    private Ps5ManifestDocument(Ps5JsonDocumentModel document) => _document = document;
    public JsonObject Root => _document.Root;
    public static Ps5ManifestDocument Load(string path) => new(Ps5JsonDocumentModel.Load(path));
    public static Ps5ManifestDocument Create(string contentId, string titleId)
    {
        var model = Ps5JsonDocumentModel.Parse("{}");
        model.SetString("contentId", contentId); model.SetString("titleId", titleId);
        model.Root["applicationData"] = new JsonObject();
        return new Ps5ManifestDocument(model);
    }
    public void SaveAtomic(string path) => _document.SaveAtomic(path);
}
