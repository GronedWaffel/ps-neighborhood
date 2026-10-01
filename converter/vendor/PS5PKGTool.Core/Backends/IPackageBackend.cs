using PS5PKGTool.Core.Builders;
using PS5PKGTool.Core.Services;

namespace PS5PKGTool.Core.Backends;

/// <summary>
/// A selectable PS5 package engine that can build, validate and extract packages. Two
/// implementations ship: <c>PptBackend</c> (the vendored clean-room ProsperoPkgTool engine) and
/// <c>LppBackend</c> (the vendored GPL LibProsperoPkg library). The selected backend is the one that
/// both builds a package and later validates/extracts it, so the reader always matches the writer.
/// </summary>
public interface IPackageBackend
{
    /// <summary>Stable id used in settings and the UI (e.g. <c>ppt</c>, <c>lpp</c>).</summary>
    string Id { get; }

    /// <summary>Human-readable name shown in the backend selector.</summary>
    string DisplayName { get; }

    /// <summary>What this backend can do.</summary>
    BackendCapabilities Capabilities { get; }

    /// <summary>Builds a package from an unpacked folder (a dump/app tree).</summary>
    Task<SonyDebugPackageBuildResult> BuildFromDirectoryAsync(string sourceDirectory, string outputPath,
        SonyDebugPackageBuildOptions options, IProgress<SonyDebugPackageProgress>? progress = null,
        CancellationToken cancellationToken = default);

    /// <summary>Builds a package from an image source (exFAT / FFPKG / FFPFSC). Not all backends support this.</summary>
    Task<SonyDebugPackageBuildResult> BuildFromImageAsync(string imagePath, string outputPath,
        SonyDebugPackageBuildOptions options, IProgress<SonyDebugPackageProgress>? progress = null,
        CancellationToken cancellationToken = default);

    /// <summary>Validates a package with this backend's own reader.</summary>
    SonyDebugPackageValidationResult Validate(string packagePath,
        string passcode = SonyDebugPackageCredentials.DefaultPasscode);

    /// <summary>Extracts a package's filesystem to <paramref name="destination"/>.</summary>
    Task<SonyPackageExtractResult> ExtractAsync(string packagePath, string destination,
        string passcode = SonyDebugPackageCredentials.DefaultPasscode,
        IProgress<SonyPackageExtractProgress>? progress = null, CancellationToken cancellationToken = default);
}
