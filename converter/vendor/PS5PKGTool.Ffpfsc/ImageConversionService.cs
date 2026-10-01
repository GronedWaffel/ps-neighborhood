using UFS2Tool;

namespace PS5PKGTool.Ffpfsc;

public enum Ps5ImageConversionTarget
{
    Exfat,
    Ffpkg,
    Ffpfsc
}

public sealed record Ps5ImageConversionProgress(string Stage, long Completed, long Total);

public sealed class Ps5ImageConversionResult
{
    public required string OutputPath { get; init; }
    public required Ps5ImageFormat SourceFormat { get; init; }
    public required Ps5ImageConversionTarget Target { get; init; }
    public required long SourceBytes { get; init; }
    public required long OutputBytes { get; init; }
    public required int FileCount { get; init; }
}

public sealed class FfpkgBuildOptions
{
    public int BlockSize { get; init; } = 32768;
    public int FragmentSize { get; init; } = 4096;
    public int BytesPerInode { get; init; } = 262144;
    public int MinFreePercent { get; init; }
}

/// <summary>
/// Converts between PS5 dump folders and the exFAT, FFPKG (UFS2), and FFPFSC image formats.
/// Filesystem images are extracted to a temporary tree and rebuilt in the target format; wrapping a
/// filesystem image into FFPFSC is done directly without extraction.
/// </summary>
public static class Ps5ImageConversionService
{
    private const int MaximumUnwrapDepth = 4;

    public static Ps5ImageFormat DetectSource(string path) =>
        Directory.Exists(path) ? Ps5ImageFormat.Unknown : Ps5ImageFormatProbe.Detect(path);

    public static bool IsSupported(Ps5ImageFormat source, Ps5ImageConversionTarget target) => (source, target) switch
    {
        (Ps5ImageFormat.Exfat, Ps5ImageConversionTarget.Ffpkg) => true,
        (Ps5ImageFormat.Exfat, Ps5ImageConversionTarget.Ffpfsc) => true,
        (Ps5ImageFormat.Ufs2, Ps5ImageConversionTarget.Exfat) => true,
        (Ps5ImageFormat.Ufs2, Ps5ImageConversionTarget.Ffpfsc) => true,
        (Ps5ImageFormat.Pfs, Ps5ImageConversionTarget.Exfat) => true,
        (Ps5ImageFormat.Pfs, Ps5ImageConversionTarget.Ffpkg) => true,
        (Ps5ImageFormat.Pfs, Ps5ImageConversionTarget.Ffpfsc) => true,
        _ => false
    };

    public static async Task<Ps5ImageConversionResult> ConvertAsync(string sourcePath, string outputPath,
        Ps5ImageConversionTarget target, bool overwrite = false,
        IProgress<Ps5ImageConversionProgress>? progress = null, CancellationToken cancellationToken = default,
        ExfatBuildOptions? exfatOptions = null, FfpfscBuildOptions? ffpfscOptions = null,
        FfpkgBuildOptions? ffpkgOptions = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourcePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);

        string sourceFull = Path.GetFullPath(sourcePath);
        string outputFull = Path.GetFullPath(outputPath);
        bool isDirectory = Directory.Exists(sourceFull);
        if (!isDirectory && !File.Exists(sourceFull))
            throw new FileNotFoundException("The source image or dump folder does not exist.", sourceFull);

        if (!isDirectory)
        {
            if (string.Equals(sourceFull, outputFull, StringComparison.OrdinalIgnoreCase))
                throw new IOException("The output path must be different from the source image.");
            if (File.Exists(outputFull) && !overwrite)
                throw new IOException($"The output file already exists: {outputFull}");
        }

        Ps5ImageFormat sourceFormat = isDirectory ? Ps5ImageFormat.Unknown : Ps5ImageFormatProbe.Detect(sourceFull);
        long sourceBytes = isDirectory ? 0 : new FileInfo(sourceFull).Length;

        // Direct wrap: a filesystem image becomes an FFPFSC without an extraction round trip.
        if (!isDirectory && target == Ps5ImageConversionTarget.Ffpfsc &&
            sourceFormat is Ps5ImageFormat.Exfat or Ps5ImageFormat.Ufs2)
        {
            string innerName = Path.GetFileName(sourceFull);
            FfpfscBuildOptions wrapOptions = ffpfscOptions is null
                ? new FfpfscBuildOptions { InnerFileName = innerName, OverwriteExisting = overwrite }
                : new FfpfscBuildOptions
                {
                    PfsBlockSize = ffpfscOptions.PfsBlockSize,
                    CaseInsensitive = ffpfscOptions.CaseInsensitive,
                    OverwriteExisting = overwrite,
                    InnerFileName = innerName,
                    BuildTimestampUnixSeconds = ffpfscOptions.BuildTimestampUnixSeconds,
                    Compression = ffpfscOptions.Compression
                };
            FfpfscBuildResult build = await FfpfscImage.CreateFromImageAsync(sourceFull, outputFull,
                wrapOptions,
                progress is null ? null : new Progress<FfpfscProgress>(value =>
                    progress.Report(new Ps5ImageConversionProgress(value.Stage, value.BytesProcessed, value.TotalBytes))),
                cancellationToken).ConfigureAwait(false);
            return new Ps5ImageConversionResult
            {
                OutputPath = outputFull,
                SourceFormat = sourceFormat,
                Target = target,
                SourceBytes = sourceBytes,
                OutputBytes = build.ContainerLength,
                FileCount = 1
            };
        }

        if (!isDirectory && !IsSupported(sourceFormat, target))
            throw new InvalidDataException(
                $"Converting {sourceFormat} to {target} is not supported.");

        string tempRoot = Path.Combine(Path.GetTempPath(), "PS5PKGTool", "convert", Guid.NewGuid().ToString("N"));
        string? tempOutput = null;
        try
        {
            string tree;
            int fileCount;
            if (isDirectory)
            {
                tree = sourceFull;
                fileCount = Directory.EnumerateFiles(tree, "*", SearchOption.AllDirectories).Count();
            }
            else
            {
                Directory.CreateDirectory(tempRoot);
                tree = Path.Combine(tempRoot, "tree");
                await ExtractAsync(sourceFull, tree, sourceFormat, progress, cancellationToken).ConfigureAwait(false);
                fileCount = Directory.EnumerateFiles(tree, "*", SearchOption.AllDirectories).Count();
            }

            string outputDirectory = Path.GetDirectoryName(outputFull) ?? tempRoot;
            Directory.CreateDirectory(outputDirectory);
            tempOutput = outputFull + "." + Guid.NewGuid().ToString("N") + ".tmp";
            await BuildAsync(tree, tempOutput, target, BuildVolumeName(sourceFull), progress, cancellationToken, exfatOptions, ffpfscOptions, ffpkgOptions)
                .ConfigureAwait(false);
            await VerifyOutputAsync(tempOutput, target, progress, cancellationToken).ConfigureAwait(false);

            long outputBytes = new FileInfo(tempOutput).Length;
            File.Move(tempOutput, outputFull, overwrite);
            tempOutput = null;
            return new Ps5ImageConversionResult
            {
                OutputPath = outputFull,
                SourceFormat = sourceFormat,
                Target = target,
                SourceBytes = sourceBytes,
                OutputBytes = outputBytes,
                FileCount = fileCount
            };
        }
        finally
        {
            if (tempOutput is not null) TryDelete(tempOutput);
            if (Directory.Exists(tempRoot)) TryDeleteDirectory(tempRoot);
        }
    }

    private static async Task ExtractAsync(string source, string tree, Ps5ImageFormat format,
        IProgress<Ps5ImageConversionProgress>? progress, CancellationToken cancellationToken)
    {
        switch (format)
        {
            case Ps5ImageFormat.Exfat:
                await ExfatImage.ExtractDirectoryAsync(source, tree,
                    progress is null ? null : new Progress<FfpfscProgress>(value =>
                        progress.Report(new Ps5ImageConversionProgress(value.Stage, value.BytesProcessed, value.TotalBytes))),
                    cancellationToken).ConfigureAwait(false);
                break;
            case Ps5ImageFormat.Ufs2:
                await Ufs2Operations.ExtractAsync(source, tree,
                    progress is null ? null : new Progress<Ufs2Progress>(value =>
                        progress.Report(new Ps5ImageConversionProgress(value.Stage, value.Completed, value.Total))),
                    cancellationToken).ConfigureAwait(false);
                break;
            case Ps5ImageFormat.Pfs:
                await FfpfscImage.ExtractToDirectoryAsync(source, tree, overwrite: true,
                    progress is null ? null : new Progress<FfpfscProgress>(value =>
                        progress.Report(new Ps5ImageConversionProgress(value.Stage, value.BytesProcessed, value.TotalBytes))),
                    cancellationToken).ConfigureAwait(false);
                break;
            default:
                throw new InvalidDataException("The source image format is not supported.");
        }
    }

    private static async Task BuildAsync(string tree, string output, Ps5ImageConversionTarget target,
        string volumeName, IProgress<Ps5ImageConversionProgress>? progress, CancellationToken cancellationToken,
        ExfatBuildOptions? exfatOptions, FfpfscBuildOptions? ffpfscOptions, FfpkgBuildOptions? ffpkgOptions)
    {
        switch (target)
        {
            case Ps5ImageConversionTarget.Exfat:
                await ExfatImage.WriteDirectoryAsync(tree, output, exfatOptions ?? new ExfatBuildOptions(),
                    progress is null ? null : new Progress<FfpfscProgress>(value =>
                        progress.Report(new Ps5ImageConversionProgress(value.Stage, value.BytesProcessed, value.TotalBytes))),
                    cancellationToken).ConfigureAwait(false);
                break;
            case Ps5ImageConversionTarget.Ffpkg:
                FfpkgBuildOptions options = ffpkgOptions ?? new FfpkgBuildOptions();
                await Ufs2Operations.CreateFromDirectoryAsync(tree, output, volumeName,
                    progress is null ? null : new Progress<Ufs2Progress>(value =>
                        progress.Report(new Ps5ImageConversionProgress(value.Stage, value.Completed, value.Total))),
                    cancellationToken, options.BlockSize, options.FragmentSize, options.BytesPerInode,
                    options.MinFreePercent).ConfigureAwait(false);
                break;
            case Ps5ImageConversionTarget.Ffpfsc:
                await FfpfscImage.CreateFromDirectoryAsync(tree, output, ffpfscOptions ?? new FfpfscBuildOptions(),
                    exfatOptions,
                    progress is null ? null : new Progress<FfpfscProgress>(value =>
                        progress.Report(new Ps5ImageConversionProgress(value.Stage, value.BytesProcessed, value.TotalBytes))),
                    cancellationToken).ConfigureAwait(false);
                break;
            default:
                throw new InvalidDataException("The target image format is not supported.");
        }
    }

    private static async Task VerifyOutputAsync(string output, Ps5ImageConversionTarget target,
        IProgress<Ps5ImageConversionProgress>? progress, CancellationToken cancellationToken)
    {
        switch (target)
        {
            case Ps5ImageConversionTarget.Exfat:
                await ExfatImage.VerifyAsync(output,
                    progress is null ? null : new Progress<FfpfscProgress>(value =>
                        progress.Report(new Ps5ImageConversionProgress(value.Stage, value.BytesProcessed, value.TotalBytes))),
                    cancellationToken).ConfigureAwait(false);
                break;
            case Ps5ImageConversionTarget.Ffpkg:
                await Ufs2Operations.VerifyAsync(output,
                    progress is null ? null : new Progress<Ufs2Progress>(value =>
                        progress.Report(new Ps5ImageConversionProgress(value.Stage, value.Completed, value.Total))),
                    cancellationToken).ConfigureAwait(false);
                break;
            case Ps5ImageConversionTarget.Ffpfsc:
                await FfpfscImage.VerifyAsync(output, null,
                    progress is null ? null : new Progress<FfpfscProgress>(value =>
                        progress.Report(new Ps5ImageConversionProgress(value.Stage, value.BytesProcessed, value.TotalBytes))),
                    cancellationToken).ConfigureAwait(false);
                break;
        }
    }

    private static string BuildVolumeName(string sourcePath)
    {
        string name = Path.GetFileNameWithoutExtension(sourcePath);
        string sanitized = new string(name.Where(value => value is >= ' ' and <= '~' &&
            value is not '"' and not '*' and not '/' and not ':' and not '<' and not '>' and not '?' and not '\\' and not '|')
            .ToArray()).Trim(' ', '.');
        return sanitized.Length == 0 ? "PS5_GAME" : sanitized;
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void TryDeleteDirectory(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
