using PS5PKGTool.Ffpfsc;
using ProsperoPkgTool;
using ProsperoPkgTool.Content;
using ProsperoPkgTool.Containers;
using ProsperoPkgTool.Gp5;
using UFS2Tool;
using EngineBuildResult = ProsperoPkgTool.Containers.DebugPackageBuildResult;
using EngineBuilder = ProsperoPkgTool.Containers.ProsperoDebugPackageBuilder;
using EngineInnerFile = ProsperoPkgTool.Containers.ProsperoInnerImageAssembler.InnerFile;

namespace PS5PKGTool.Core.Builders;

/// <summary>
/// Builds a PS5 debug package directly from a PS5 filesystem image (exFAT, UFS2/FFPKG or FFPFSC)
/// without extracting it first. Each inner file is streamed to the engine through
/// <see cref="IProsperoFileSource"/>, so only the small <c>sce_sys</c> metadata set and the
/// fake-sign/UCP-repair targets are materialized.
/// </summary>
public static class VolumeDebugPackageBuilder
{
    public static Task<SonyDebugPackageBuildResult> CreateFromImageAsync(string imagePath, string outputPath,
        SonyDebugPackageBuildOptions options, IProgress<SonyDebugPackageProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(imagePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        ArgumentNullException.ThrowIfNull(options);
        return Task.Run(() => CreateFromImage(imagePath, outputPath, options, progress, cancellationToken),
            cancellationToken);
    }

    private static SonyDebugPackageBuildResult CreateFromImage(string imagePath, string outputPath,
        SonyDebugPackageBuildOptions options, IProgress<SonyDebugPackageProgress>? progress,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string source = Path.GetFullPath(imagePath);
        string destination = Path.GetFullPath(outputPath);
        if (!File.Exists(source)) throw new FileNotFoundException("The source image was not found.", source);

        SonyDebugPackageCredentials credentials = SonyDebugPackageCredentials.Create(options.ContentId, options.Passcode);
        progress?.Report(new SonyDebugPackageProgress("Detecting image format", 0, 0, Path.GetFileName(source)));

        using IDisposable volume = OpenVolume(source, out IReadOnlyList<VolumeFile> entries,
            out Func<string, Stream> open, out string formatName);
        string readStage = $"Reading {formatName} filesystem";

        int totalEntries = entries.Count;
        progress?.Report(new SonyDebugPackageProgress(readStage, 0, totalEntries,
            Path.GetFileName(source)));

        var files = new List<EngineInnerFile>();
        var sceSys = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        long sourceBytes = 0;
        int sourceFiles = 0;
        int processedEntries = 0;

        foreach (VolumeFile entry in entries.OrderBy(item => item.Path, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            progress?.Report(new SonyDebugPackageProgress(readStage, ++processedEntries,
                totalEntries, entry.Path));
            if (entry.IsDirectory || entry.IsSymlink) continue;
            sourceBytes += entry.Size;
            sourceFiles++;

            string relative = entry.Path;
            bool publishing = SourceFolderValidator.IsPublishingArtifact(relative) ||
                Path.GetExtension(relative).Equals(".gp4", StringComparison.OrdinalIgnoreCase);
            bool underSceSys = relative.StartsWith("sce_sys/", StringComparison.OrdinalIgnoreCase);
            string sceRelative = underSceSys ? relative["sce_sys/".Length..] : string.Empty;

            if (underSceSys)
            {
                byte[] data = ReadEntry(open, relative, entry.Size);
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
                Source = new VolumeFileSource(entry.Size, () => open(relative)),
                PlayGoChunkId = 0
            });
        }

        if (!sceSys.TryGetValue("param.json", out byte[]? paramJson) || paramJson.Length == 0)
            throw new InvalidDataException(
                "The image does not contain sce_sys/param.json, which is required to build a package.");
        if (files.Count == 0)
            throw new InvalidDataException("The image does not contain any package files.");

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

        EngineBuildResult result = EngineBuilder.Build(files, new DebugPackageBuildOptions
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

    /// <summary>
    /// Sums the uncompressed payload bytes of an image (exFAT / UFS2-FFPKG / FFPFSC) without
    /// extracting or building it. Used to preflight the disk space an extract-then-build needs.
    /// </summary>
    public static long EstimatePayloadBytes(string imagePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(imagePath);
        string source = Path.GetFullPath(imagePath);
        if (!File.Exists(source)) throw new FileNotFoundException("The source image was not found.", source);

        using IDisposable volume = OpenVolume(source, out IReadOnlyList<VolumeFile> entries, out _, out _);
        long total = 0;
        foreach (VolumeFile entry in entries)
        {
            if (!entry.IsDirectory && !entry.IsSymlink)
                total += entry.Size;
        }
        return total;
    }

    private static IDisposable OpenVolume(string imagePath, out IReadOnlyList<VolumeFile> entries,
        out Func<string, Stream> open, out string formatName)
    {
        var stream = new FileStream(imagePath, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20,
            FileOptions.RandomAccess);
        try
        {
            Ps5ImageFormat format = Ps5ImageFormatProbe.Detect(stream);
            stream.Position = 0;
            switch (format)
            {
                case Ps5ImageFormat.Pfs:
                {
                    formatName = "FFPFSC";
                    FfpfscVolume volume = FfpfscVolume.Open(stream, imagePath, leaveOpen: false);
                    if (volume.InnerFilesystemKind == FfpfscInnerFilesystemKind.Pfs)
                    {
                        volume.Dispose();
                        throw new InvalidDataException(
                            "The FFPFSC inner payload is a nested PFS container, not a file tree.");
                    }
                    entries = volume.Entries
                        .Select(item => new VolumeFile(Normalize(item.Path), item.IsDirectory, false, item.Size))
                        .ToArray();
                    open = volume.OpenFile;
                    return volume;
                }
                case Ps5ImageFormat.Ufs2:
                {
                    formatName = "FFPKG";
                    var volume = new Ufs2Volume(stream, imagePath, leaveOpen: false);
                    entries = volume.Entries
                        .Select(item => new VolumeFile(Normalize(item.Path), item.IsDirectory, item.IsSymlink,
                            item.Size))
                        .ToArray();
                    open = volume.OpenFile;
                    return volume;
                }
                case Ps5ImageFormat.Exfat:
                {
                    formatName = "exFAT";
                    var volume = new ExfatVolume(stream, leaveOpen: false);
                    entries = volume.Entries
                        .Select(item => new VolumeFile(Normalize(item.Path), item.IsDirectory, false, item.Size))
                        .ToArray();
                    open = volume.OpenFile;
                    return volume;
                }
                default:
                    throw new InvalidDataException($"Unrecognised PS5 image format: {imagePath}");
            }
        }
        catch
        {
            stream.Dispose();
            throw;
        }
    }

    private static byte[] ReadEntry(Func<string, Stream> open, string path, long size)
    {
        if (size < 0 || size > int.MaxValue)
            throw new IOException($"The image file is too large to load into memory: {path}");
        using Stream stream = open(path);
        byte[] data = new byte[checked((int)size)];
        stream.ReadExactly(data);
        return data;
    }

    private static string Normalize(string path) => path.Replace('\\', '/').TrimStart('/');

    private sealed record VolumeFile(string Path, bool IsDirectory, bool IsSymlink, long Size);

    private sealed class VolumeFileSource(long length, Func<Stream> open) : IProsperoFileSource
    {
        public long Length => length;
        public Stream Open() => open();
    }

    private sealed class RelayProgress<T>(Action<T> report) : IProgress<T>
    {
        public void Report(T value) => report(value);
    }
}
