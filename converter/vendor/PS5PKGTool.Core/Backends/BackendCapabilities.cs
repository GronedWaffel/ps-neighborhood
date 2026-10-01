namespace PS5PKGTool.Core.Backends;

/// <summary>
/// What a <see cref="IPackageBackend"/> can do. The UI uses this to gate actions and options instead
/// of assuming every backend supports everything (for example LibProsperoPkg cannot build from an
/// image and cannot build very large titles).
/// </summary>
public sealed record BackendCapabilities(
    bool BuildFromDirectory,
    bool BuildFromImage,
    bool Validate,
    bool Extract,
    bool SupportsLargeImages,
    bool SupportsSeed,
    bool SupportsCompressionKnobs,
    bool SupportsRightSprxToggle,
    bool SupportsPlayGoChunks);
