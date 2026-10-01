using ProsperoPkgTool;
using ProsperoPkgTool.Content;
using ProsperoPkgTool.Containers;
using ProsperoPkgTool.Gp5;
using EngineBuilder = ProsperoPkgTool.Containers.ProsperoDebugPackageBuilder;
using EngineInnerFile = ProsperoPkgTool.Containers.ProsperoInnerImageAssembler.InnerFile;

namespace PS5PKGTool.Core.Builders;

public sealed class ProsperoDebugPackageBuildOptions
{
    public required string ContentId { get; init; }
    public string Passcode { get; init; } = SonyDebugPackageCredentials.DefaultPasscode;

    /// <summary>
    /// Optional 16-byte outer-PFS seed. When supplied the build is byte-reproducible
    /// (deterministic CNT entry keys, fixed outer PFS seed); otherwise the engine randomizes.
    /// </summary>
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

/// <summary>
/// Builds a PS5 debug package from an unpacked dump folder using the vendored, validated
/// <c>ProsperoPkgTool</c> engine (MIT) as a managed library. Files are passed to the engine's
/// <c>Build</c> API directly (disk-backed by path).
/// </summary>
public static class ProsperoDebugPackageBuilder
{
    public static Task<SonyDebugPackageBuildResult> CreateFromDirectoryAsync(string sourceDirectory,
        string outputPath, ProsperoDebugPackageBuildOptions options,
        IProgress<SonyDebugPackageProgress>? progress = null, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceDirectory);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        ArgumentNullException.ThrowIfNull(options);
        return Task.Run(() => CreateFromDirectory(sourceDirectory, outputPath, options, progress, cancellationToken),
            cancellationToken);
    }

    private static SonyDebugPackageBuildResult CreateFromDirectory(string sourceDirectory, string outputPath,
        ProsperoDebugPackageBuildOptions options, IProgress<SonyDebugPackageProgress>? progress,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string source = Path.GetFullPath(sourceDirectory);
        string destination = Path.GetFullPath(outputPath);
        if (!Directory.Exists(source)) throw new DirectoryNotFoundException(source);

        SonyDebugPackageCredentials credentials = SonyDebugPackageCredentials.Create(options.ContentId, options.Passcode);
        progress?.Report(new SonyDebugPackageProgress("Reading source folder", 0, 0, Path.GetFileName(source)));

        var files = new List<EngineInnerFile>();
        var sceSys = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        long sourceBytes = 0;
        int sourceFiles = 0;

        string[] sourcePaths = Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories)
            .OrderBy(item => item, StringComparer.Ordinal)
            .ToArray();
        int processedFiles = 0;
        progress?.Report(new SonyDebugPackageProgress("Reading source folder", 0, sourcePaths.Length,
            Path.GetFileName(source)));

        foreach (string path in sourcePaths)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string relative = Path.GetRelativePath(source, path).Replace('\\', '/');
            sourceBytes += new FileInfo(path).Length;
            sourceFiles++;
            progress?.Report(new SonyDebugPackageProgress("Reading source folder", ++processedFiles,
                sourcePaths.Length, relative));

            bool publishing = SourceFolderValidator.IsPublishingArtifact(relative) ||
                Path.GetExtension(relative).Equals(".gp4", StringComparison.OrdinalIgnoreCase);
            bool underSceSys = relative.StartsWith("sce_sys/", StringComparison.OrdinalIgnoreCase);
            string sceRelative = underSceSys ? relative["sce_sys/".Length..] : string.Empty;

            if (underSceSys)
            {
                byte[] data = File.ReadAllBytes(path);
                sceSys[sceRelative] = ProsperoUcpArchive.IsRepairableSceSysPath(sceRelative)
                    ? ProsperoUcpArchive.RepairIfNeeded(data)
                    : data;
            }

            if (publishing) continue;
            if (underSceSys && ProsperoSceSysMedia.IsOuterCntFile(sceRelative)) continue;

            if (underSceSys && ProsperoUcpArchive.IsRepairableSceSysPath(sceRelative))
            {
                files.Add(new EngineInnerFile
                {
                    Path = "/" + relative,
                    Data = sceSys[sceRelative],
                    PlayGoChunkId = 0
                });
                continue;
            }

            files.Add(new EngineInnerFile
            {
                Path = "/" + relative,
                SourcePath = path,
                Length = new FileInfo(path).Length,
                PlayGoChunkId = 0
            });
        }

        if (!sceSys.TryGetValue("param.json", out byte[]? paramJson) || paramJson.Length == 0)
            throw new InvalidDataException(
                "The dump does not contain sce_sys/param.json, which is required to build a package.");
        if (files.Count == 0)
            throw new InvalidDataException("The dump does not contain any package files.");

        var log = new DebugPackageBuildLog
        {
            Log = options.Log ?? (_ => { }),
            Progress = new RelayProgress<ProsperoBuildProgress>(value =>
                progress?.Report(new SonyDebugPackageProgress(
                    value.StageId is { } stage ? ProsperoBuildStages.Name(stage) : value.Stage,
                    value.BytesTotal > 0 ? value.BytesDone : value.Done,
                    value.BytesTotal > 0 ? value.BytesTotal : value.Total,
                    value.CurrentPath ?? string.Empty)))
        };

        DebugPackageBuildResult result = EngineBuilder.Build(files, new DebugPackageBuildOptions
        {
            OutputPath = destination,
            ContentId = credentials.ContentId,
            Passcode = credentials.Passcode,
            ParamJson = paramJson,
            Compression = options.Compression.ToEngine(),
            KrakenLevel = options.KrakenLevel,
            KrakenThreads = options.KrakenThreads,
            PlayGoChunkCount = options.PlayGoChunkCount,
            DrmTypeOverride = options.DrmTypeOverride,
            OuterSeed = options.Seed,
            DeterministicEntryKeys = options.Seed is { Length: 16 },
            SdkVersionOverride = options.SdkVersionOverride,
            TempDirectory = options.TempDirectory,
            SceSysFiles = sceSys,
            FakeSignModules = options.FakeSignModules,
            InjectRightSprx = options.InjectRightSprx,
            Log = log
        }, cancellationToken);

        return new SonyDebugPackageBuildResult
        {
            OutputPath = destination,
            ContentId = credentials.ContentId,
            KeyFingerprint = credentials.Fingerprint,
            PackageSize = new FileInfo(destination).Length,
            SourceBytes = sourceBytes,
            SourceFiles = sourceFiles,
            UsesDefaultPasscode = credentials.UsesDefaultPasscode
        };
    }

    private sealed class RelayProgress<T>(Action<T> report) : IProgress<T>
    {
        public void Report(T value) => report(value);
    }
}
