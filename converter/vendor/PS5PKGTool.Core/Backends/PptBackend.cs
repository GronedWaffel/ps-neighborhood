using PS5PKGTool.Core.Builders;
using PS5PKGTool.Core.Services;

namespace PS5PKGTool.Core.Backends;

/// <summary>
/// The clean-room ProsperoPkgTool engine backend. Supports directory and image builds (including
/// the multi-GiB file-backed path), and is the fallback when LibProsperoPkg cannot handle a source.
/// </summary>
public sealed class PptBackend : IPackageBackend
{
    public const string BackendId = "ppt";

    public string Id => BackendId;

    public string DisplayName => "ProsperoPkgTool";

    public BackendCapabilities Capabilities { get; } = new(
        BuildFromDirectory: true,
        BuildFromImage: true,
        Validate: true,
        Extract: true,
        SupportsLargeImages: true,
        SupportsSeed: true,
        SupportsCompressionKnobs: true,
        SupportsRightSprxToggle: true,
        SupportsPlayGoChunks: true);

    public Task<SonyDebugPackageBuildResult> BuildFromDirectoryAsync(string sourceDirectory, string outputPath,
        SonyDebugPackageBuildOptions options, IProgress<SonyDebugPackageProgress>? progress = null,
        CancellationToken cancellationToken = default) =>
        SonyDebugPackageBuilder.CreateFromDirectoryAsync(sourceDirectory, outputPath, options, progress, cancellationToken);

    public Task<SonyDebugPackageBuildResult> BuildFromImageAsync(string imagePath, string outputPath,
        SonyDebugPackageBuildOptions options, IProgress<SonyDebugPackageProgress>? progress = null,
        CancellationToken cancellationToken = default) =>
        VolumeDebugPackageBuilder.CreateFromImageAsync(imagePath, outputPath, options, progress, cancellationToken);

    public SonyDebugPackageValidationResult Validate(string packagePath,
        string passcode = SonyDebugPackageCredentials.DefaultPasscode) =>
        SonyDebugPackageBuilder.Validate(packagePath, passcode);

    public Task<SonyPackageExtractResult> ExtractAsync(string packagePath, string destination,
        string passcode = SonyDebugPackageCredentials.DefaultPasscode,
        IProgress<SonyPackageExtractProgress>? progress = null, CancellationToken cancellationToken = default) =>
        SonyPackageExtraction.ExtractAsync(packagePath, destination, passcode, progress, cancellationToken);
}
