using PS5PKGTool.Core.Parsers;
using PS5PKGTool.Core.Services;
using ProsperoPkgTool.Containers;

namespace PS5PKGTool.Core.Builders;

public sealed class SonyDebugPackageBuildOptions
{
    public required string ContentId { get; init; }
    public string Passcode { get; init; } = SonyDebugPackageCredentials.DefaultPasscode;

    /// <summary>Optional 16-byte outer-PFS seed for a byte-reproducible package.</summary>
    public byte[]? Seed { get; init; }

    /// <summary>Optional full 64-bit executable SDK id to stamp (param.json + .sceversion).
    /// Null preserves the source metadata.</summary>
    public ulong? SdkVersionOverride { get; init; }

    /// <summary>Optional workspace folder for the multi-GiB file-backed path. Null uses the system temp folder.</summary>
    public string? TempDirectory { get; init; }

    /// <summary>Optional sink for engine log lines (free-space warnings, stale workspace sweep).</summary>
    public Action<string>? Log { get; init; }

    /// <summary>Inner-image compression. Default is Auto (Kraken where it helps, stored otherwise).</summary>
    public Ps5InnerCompression Compression { get; init; } = Ps5InnerCompression.Auto;

    /// <summary>Kraken level recorded in the compressed header (Oodle naming, -4..9). Header-only here.</summary>
    public int KrakenLevel { get; init; } = 7;

    /// <summary>Blocks encoded concurrently; 0 selects the processor count.</summary>
    public int KrakenThreads { get; init; }

    /// <summary>PlayGo chunk count for the generated project; 1 matches the debug/nwonly profile.</summary>
    public int PlayGoChunkCount { get; init; } = 1;

    /// <summary>Optional DRM token to force in param.json. Null preserves the source token;
    /// "standard" is the opt-in override surfaced by the Advanced build setting.</summary>
    public string? DrmTypeOverride { get; init; }

    /// <summary>Convert raw ELF modules to debug fake-SELF containers. Default true.</summary>
    public bool FakeSignModules { get; init; } = true;

    /// <summary>Inject the built-in debug sce_sys/about/right.sprx when the source lacks one. Default true.</summary>
    public bool InjectRightSprx { get; init; } = true;
}

public readonly record struct SonyDebugPackageProgress(string Stage, long CompletedBytes,
    long TotalBytes, string CurrentPath);

public sealed class SonyDebugPackageBuildResult
{
    public required string OutputPath { get; init; }
    public required string ContentId { get; init; }
    public required string KeyFingerprint { get; init; }
    public required long PackageSize { get; init; }
    public required long SourceBytes { get; init; }
    public required int SourceFiles { get; init; }
    public required bool UsesDefaultPasscode { get; init; }
}

public sealed class SonyDebugPackageValidationResult
{
    public required bool IsValid { get; init; }
    public required string Message { get; init; }
    public required int IndexedFiles { get; init; }
    public required long PackageSize { get; init; }
}

public static class SonyDebugPackageBuilder
{
    public static async Task<SonyDebugPackageBuildResult> CreateFromDirectoryAsync(string sourceDirectory,
        string outputPath, SonyDebugPackageBuildOptions options,
        IProgress<SonyDebugPackageProgress>? progress = null, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceDirectory);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        ArgumentNullException.ThrowIfNull(options);
        return await ProsperoDebugPackageBuilder.CreateFromDirectoryAsync(sourceDirectory, outputPath,
            new ProsperoDebugPackageBuildOptions
            {
                ContentId = options.ContentId,
                Passcode = options.Passcode,
                Seed = options.Seed,
                SdkVersionOverride = options.SdkVersionOverride,
                TempDirectory = options.TempDirectory,
                Log = options.Log,
                Compression = options.Compression,
                KrakenLevel = options.KrakenLevel,
                KrakenThreads = options.KrakenThreads,
                PlayGoChunkCount = options.PlayGoChunkCount,
                DrmTypeOverride = options.DrmTypeOverride,
                FakeSignModules = options.FakeSignModules,
                InjectRightSprx = options.InjectRightSprx
            },
            progress, cancellationToken).ConfigureAwait(false);
    }

    public static SonyDebugPackageValidationResult Validate(string packagePath,
        string passcode = SonyDebugPackageCredentials.DefaultPasscode)
    {
        try
        {
            string fullPath = Path.GetFullPath(packagePath);
            ProsperoPackageInspection inspection = ProsperoPackageReader.Read(fullPath);
            ProsperoPackageVerificationReport report = ProsperoPackageVerifier.Verify(fullPath, passcode);
            using var access = SonyEnginePackageAccess.Open(fullPath, passcode);
            bool isDebug = inspection.Kind is ProsperoPackageKind.FinalizedDebug or ProsperoPackageKind.FinalizedPatchDebug;
            bool decodes = access.DecodeError is null && access.Files.Any();
            bool valid = isDebug && !report.HasFailure && decodes;
            string message = valid
                ? "The engine verified FIH/CNT structure, digests, outer PFS ICV, NAPS, reconstruction and inner PFS integrity."
                : string.Join("; ", report.Checks.Where(check => check.State == VerificationState.Fail)
                    .Select(check => check.Name + ": " + check.Detail));
            if (!decodes && string.IsNullOrWhiteSpace(message))
                message = access.DecodeError is { } decodeError
                    ? (access.DecodeUnsupported
                        ? $"This package uses a format this build does not support yet: {decodeError}"
                        : decodeError)
                    : "The package could not be decoded with the supplied passcode.";
            if (string.IsNullOrWhiteSpace(message)) message = "The package structure is incomplete.";
            return new SonyDebugPackageValidationResult
            {
                IsValid = valid,
                Message = message,
                IndexedFiles = access.Files.Count(),
                PackageSize = new FileInfo(fullPath).Length
            };
        }
        catch (Exception ex)
        {
            return new SonyDebugPackageValidationResult { IsValid = false, Message = ex.Message, IndexedFiles = 0,
                PackageSize = File.Exists(packagePath) ? new FileInfo(packagePath).Length : 0 };
        }
    }
}
