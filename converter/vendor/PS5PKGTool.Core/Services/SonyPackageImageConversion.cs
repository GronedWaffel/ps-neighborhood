using PS5PKGTool.Core.Models;
using PS5PKGTool.Ffpfsc;

namespace PS5PKGTool.Core.Services;

/// <summary>
/// Converts a PS5 debug package into a standalone filesystem image (exFAT, FFPKG/UFS2 or FFPFSC).
/// The package's readable content (inner PFS files plus outer CNT metadata such as
/// <c>sce_sys/param.json</c>, artwork and trophies) is materialized to a temporary tree after
/// dropping the container's internal bookkeeping files, then rebuilt in the target format.
/// </summary>
public static class SonyPackageImageConversion
{
    // Inner-PFS system tables synthesized by the assembler, plus the debug markers the builder
    // injects, are not part of a normal dump and must not be re-emitted as regular files.
    private static readonly HashSet<string> ExcludedPaths = new(StringComparer.OrdinalIgnoreCase)
    {
        "inode_flat_path_table",
        "apr_flat_path_table",
        "afid_to_ino_table",
        "sce_sys/keystone",
        "sce_sys/about/right.sprx",
        "sce_sys/pfs-version.dat"
    };

    public static async Task<Ps5ImageConversionResult> ConvertAsync(string packagePath, string outputPath,
        Ps5ImageConversionTarget target, bool overwrite = false,
        IProgress<Ps5ImageConversionProgress>? progress = null, CancellationToken cancellationToken = default,
        ExfatBuildOptions? exfatOptions = null, FfpfscBuildOptions? ffpfscOptions = null,
        FfpkgBuildOptions? ffpkgOptions = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packagePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);

        Ps5GameInfo game = new SonyPkgGameReader().Read(packagePath);
        if (game.SourceKind != Ps5SourceKind.SonyPackage)
            throw new InvalidDataException("The source is not a PS5 package.");

        string packageFull = Path.GetFullPath(packagePath);
        string outputFull = Path.GetFullPath(outputPath);
        if (string.Equals(packageFull, outputFull, StringComparison.OrdinalIgnoreCase))
            throw new IOException("The output path must be different from the source package.");

        string tempRoot = Path.Combine(Path.GetTempPath(), "PS5PKGTool", "pkg-image",
            Guid.NewGuid().ToString("N"));
        string tree = Path.Combine(tempRoot, "tree");
        try
        {
            await ExtractCleanTreeAsync(game, tree, progress, cancellationToken).ConfigureAwait(false);
            return await Ps5ImageConversionService.ConvertAsync(tree, outputFull, target, overwrite, progress,
                cancellationToken, exfatOptions, ffpfscOptions, ffpkgOptions).ConfigureAwait(false);
        }
        finally
        {
            try { if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static async Task ExtractCleanTreeAsync(Ps5GameInfo game, string tree,
        IProgress<Ps5ImageConversionProgress>? progress, CancellationToken cancellationToken)
    {
        using IReadOnlyGameFileSystem files = GameFileSystem.Open(game, cancellationToken);
        GameFileRecord[] wanted = files.Files
            .Where(file => file.RelativePath.Length > 0 && !ExcludedPaths.Contains(file.RelativePath))
            .ToArray();
        if (wanted.Length == 0)
            throw new InvalidDataException(
                "The package does not expose any readable files (it may be retail or require a passcode).");

        long total = wanted.Sum(file => file.Size);
        long completed = 0;
        Directory.CreateDirectory(tree);
        foreach (GameFileRecord file in wanted)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string relative = GameFileSystem.NormalizePath(file.RelativePath);
            string target = Path.GetFullPath(Path.Combine(tree, relative.Replace('/', Path.DirectorySeparatorChar)));
            if (!target.StartsWith(Path.GetFullPath(tree) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("A package path escapes the extraction root.");
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            await using Stream input = files.OpenRead(relative);
            await using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                1024 * 1024, FileOptions.Asynchronous);
            byte[] buffer = new byte[1024 * 1024];
            while (true)
            {
                int read = await input.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (read == 0) break;
                await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                completed += read;
                progress?.Report(new Ps5ImageConversionProgress("Extracting package", completed, total));
            }
        }
    }
}
