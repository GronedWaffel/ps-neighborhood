using PS5PKGTool.Core.Builders;
using PS5PKGTool.Core.Models;
using PS5PKGTool.Core.Parsers;
using ProsperoPkgTool.Containers;

namespace PS5PKGTool.Core.Services;

public readonly record struct SonyPackageExtractProgress(long CompletedBytes, long TotalBytes, string CurrentPath);
public sealed class SonyPackageExtractResult
{
    public required string Destination { get; init; }
    public required int FileCount { get; init; }
    public required long ExtractedBytes { get; init; }
}

public static class SonyPackageExtraction
{
    public static async Task<SonyPackageExtractResult> ExtractAsync(string packagePath, string destination,
        string passcode = SonyDebugPackageCredentials.DefaultPasscode,
        IProgress<SonyPackageExtractProgress>? progress = null, CancellationToken cancellationToken = default)
    {
        string output = Path.GetFullPath(destination);
        if (Directory.Exists(output)) throw new IOException("The extraction destination already exists: " + output);
        SonyPkgSummary package = new SonyPkgReader().Read(packagePath, passcode);
        SonyPfsSummary pfs = package.NestedPfs ?? throw new InvalidDataException("The package contains no indexed PFS image.");
        string staging = output + ".extracting." + Guid.NewGuid().ToString("N");
        long completed = 0;
        long total;
        int fileCount;
        try
        {
            Directory.CreateDirectory(staging);
            if (pfs.EngineAccess is { } engine)
            {
                ProsperoInnerPfsReader.Entry[] files = engine.Files.ToArray();
                cancellationToken.ThrowIfCancellationRequested();
                if (files.Length == 0)
                    throw new InvalidDataException("The package inner image could not be decoded for extraction. " + engine.DecodeError);
                total = files.Sum(file => file.Size);
                EnsureWorkingSpace(staging, total);
                fileCount = files.Length;
                foreach (ProsperoInnerPfsReader.Entry file in files)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    string relative = engine.ToRelativePath(file);
                    if (relative.Length == 0) continue;
                    string target = ResolveContainedPath(staging, relative);
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    await using var outputFile = new FileStream(target, FileMode.CreateNew, FileAccess.Write,
                        FileShare.None, 1024 * 1024, FileOptions.Asynchronous);
                    await using Stream input = engine.OpenInnerFile(file);
                    byte[] buffer = new byte[1024 * 1024];
                    long position = 0;
                    while (position < file.Size)
                    {
                        int take = checked((int)Math.Min(buffer.Length, file.Size - position));
                        int read = await input.ReadAsync(buffer.AsMemory(0, take), cancellationToken).ConfigureAwait(false);
                        if (read <= 0) throw new EndOfStreamException($"Inner file '{relative}' ended unexpectedly.");
                        await outputFile.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                        position += read;
                        completed += read;
                        progress?.Report(new SonyPackageExtractProgress(completed, total, relative));
                    }
                }
            }
            else
            {
                if (pfs.AccessState != SonyPfsAccessState.PlaintextIndexed || pfs.Files.Any(file => file.Extents.Count == 0))
                    throw new InvalidDataException("The package contains compressed or unavailable files that cannot be extracted by the current reader.");
                total = pfs.Files.Sum(file => file.Size);
                EnsureWorkingSpace(staging, total);
                fileCount = pfs.Files.Count;
                foreach (SonyPfsEntry entry in pfs.Files)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    string target = ResolveContainedPath(staging, entry.RelativePath);
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    await using var outputFile = new FileStream(target, FileMode.CreateNew, FileAccess.Write,
                        FileShare.None, 1024 * 1024, FileOptions.Asynchronous);
                    long position = 0;
                    while (position < entry.Size)
                    {
                        int count = checked((int)Math.Min(1024 * 1024, entry.Size - position));
                        byte[] data = SonyPfsEntryDataReader.ReadRange(packagePath, package, pfs, entry, position, count);
                        await outputFile.WriteAsync(data, cancellationToken).ConfigureAwait(false);
                        position += count;
                        completed += count;
                        progress?.Report(new SonyPackageExtractProgress(completed, total, entry.RelativePath));
                    }
                }
            }

            Directory.Move(staging, output);
            return new SonyPackageExtractResult { Destination = output, FileCount = fileCount, ExtractedBytes = completed };
        }
        catch
        {
            try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch (IOException) { }
            throw;
        }
        finally
        {
            // This access is private to the extraction; dispose it so the source package is not
            // left open (a large package holds a write-blocking handle while decoded).
            pfs.EngineAccess?.Dispose();
        }
    }

    private static string ResolveContainedPath(string root, string relative)
    {
        if (relative.Replace('\\', '/').Split('/').Any(p => p is "." or ".." || p.Length == 0 || p.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || p.EndsWith('.') || p.EndsWith(' ')))
            throw new InvalidDataException("Package contains an unsafe Windows path.");
        if (string.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative)) throw new InvalidDataException("Package path is unsafe.");
        string rootFull = Path.GetFullPath(root) + Path.DirectorySeparatorChar;
        string target = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!target.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Package path escapes the extraction root.");
        return target;
    }

    // Neighborhood reserves room for extracted files and a worst-case uncompressed output.
    private static void EnsureWorkingSpace(string root, long expandedBytes)
    {
        long needed = checked(expandedBytes * 2 + 4L * 1024 * 1024 * 1024);
        long free = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(root))!).AvailableFreeSpace;
        if (free < needed) throw new IOException($"Insufficient working space: need {needed:N0} free bytes after package decoding; have {free:N0}.");
    }
}
