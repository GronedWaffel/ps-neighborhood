namespace PS5PKGTool.Core.Backends;

/// <summary>
/// The set of package backends the app can select. Defaults to LibProsperoPkg per the product plan;
/// ProsperoPkgTool remains available (and is required for image sources and very large titles).
/// </summary>
public static class BackendRegistry
{
    public const string PptId = PptBackend.BackendId;
    public const string LppId = LppBackend.BackendId;
    public const string DefaultId = LppId;

    public static IReadOnlyList<IPackageBackend> All { get; } =
    [
        new LppBackend(),
        new PptBackend(),
    ];

    /// <summary>The default backend (LibProsperoPkg).</summary>
    public static IPackageBackend Default => GetById(DefaultId);

    /// <summary>Resolves a backend by id, falling back to the default for an unknown or null id.</summary>
    public static IPackageBackend Get(string? id)
    {
        if (string.IsNullOrWhiteSpace(id))
            return Default;
        return All.FirstOrDefault(backend =>
            string.Equals(backend.Id, id, StringComparison.OrdinalIgnoreCase)) ?? Default;
    }

    /// <summary>True when <paramref name="id"/> names a known backend.</summary>
    public static bool IsKnown(string? id) =>
        !string.IsNullOrWhiteSpace(id) &&
        All.Any(backend => string.Equals(backend.Id, id, StringComparison.OrdinalIgnoreCase));

    private static IPackageBackend GetById(string id) =>
        All.First(backend => string.Equals(backend.Id, id, StringComparison.OrdinalIgnoreCase));
}
