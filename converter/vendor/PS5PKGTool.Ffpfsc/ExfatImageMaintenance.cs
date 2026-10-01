using System.Buffers.Binary;
using System.Security.Cryptography;

namespace PS5PKGTool.Ffpfsc;

public enum ExfatEditKind
{
    ReplaceFile,
    AddFile,
    AddDirectory,
    AddDirectoryTree,
    Delete
}

public sealed record ExfatEditOperation(ExfatEditKind Kind, string ImagePath, string? SourcePath = null)
{
    public static ExfatEditOperation Replace(string imagePath, string sourcePath) =>
        new(ExfatEditKind.ReplaceFile, imagePath, sourcePath);
    public static ExfatEditOperation AddFile(string imagePath, string sourcePath) =>
        new(ExfatEditKind.AddFile, imagePath, sourcePath);
    public static ExfatEditOperation AddDirectory(string imagePath) =>
        new(ExfatEditKind.AddDirectory, imagePath);
    public static ExfatEditOperation AddDirectoryTree(string imagePath, string sourcePath) =>
        new(ExfatEditKind.AddDirectoryTree, imagePath, sourcePath);
    public static ExfatEditOperation Delete(string imagePath) => new(ExfatEditKind.Delete, imagePath);
}

public sealed record ExfatEditResult(
    string ImagePath,
    int OperationCount,
    bool Rebuilt,
    ExfatVerificationResult Verification);

public sealed record ExfatRepairResult(
    string ImagePath,
    bool BootRegionRecovered,
    ExfatVerificationResult Verification);

/// <summary>
/// Transactional editing and repair operations for standalone exFAT images. Exact-size single-file replacement is
/// patched in place with an on-disk rollback journal. Structural edits are applied to a staging tree and atomically
/// swapped in only after a newly generated image passes full verification.
/// </summary>
public static class ExfatImageMaintenance
{
    private const int BufferSize = 1024 * 1024;

    public static async Task<ExfatEditResult> ApplyEditsAsync(string imagePath,
        IReadOnlyList<ExfatEditOperation> operations, IProgress<FfpfscProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(imagePath);
        ArgumentNullException.ThrowIfNull(operations);
        if (operations.Count == 0) throw new ArgumentException("At least one exFAT edit is required.", nameof(operations));
        string fullPath = Path.GetFullPath(imagePath);
        if (!File.Exists(fullPath)) throw new FileNotFoundException("The exFAT image was not found.", fullPath);
        ExfatEditOperation[] normalized = operations.Select(NormalizeOperation).ToArray();
        if (normalized.Any(operation => operation.SourcePath is not null &&
                                        operation.SourcePath.Equals(fullPath, StringComparison.OrdinalIgnoreCase)))
            throw new IOException("The exFAT image itself cannot be used as an edit source file.");
        if (normalized.Any(operation => operation.Kind == ExfatEditKind.AddDirectoryTree &&
                                        operation.SourcePath is not null && IsInside(fullPath, operation.SourcePath)))
            throw new IOException("A directory containing the exFAT image cannot be imported into that image.");

        if (normalized is [{ Kind: ExfatEditKind.ReplaceFile } replacement] &&
            replacement.SourcePath is not null && CanReplaceExactly(fullPath, replacement))
        {
            await ReplaceExactlyAsync(fullPath, replacement.ImagePath, replacement.SourcePath, progress,
                cancellationToken).ConfigureAwait(false);
            ExfatVerificationResult verification = await ExfatImage.VerifyAsync(fullPath, progress,
                cancellationToken).ConfigureAwait(false);
            return new ExfatEditResult(fullPath, 1, false, verification);
        }

        ExfatVerificationResult rebuilt = await RebuildAsync(fullPath,
            staging => ApplyOperations(staging, normalized, cancellationToken), progress, cancellationToken)
            .ConfigureAwait(false);
        return new ExfatEditResult(fullPath, normalized.Length, true, rebuilt);
    }

    public static async Task<ExfatRepairResult> RepairAsync(string imagePath,
        IProgress<FfpfscProgress>? progress = null, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(imagePath);
        string fullPath = Path.GetFullPath(imagePath);
        if (!File.Exists(fullPath)) throw new FileNotFoundException("The exFAT image was not found.", fullPath);
        cancellationToken.ThrowIfCancellationRequested();
        progress?.Report(new FfpfscProgress("Checking exFAT boot regions", 0, 1));

        byte[]? bootJournal = null;
        int sectorSize = 0;
        bool bootRecovered = false;
        try
        {
            (bootJournal, sectorSize, bootRecovered) = NormalizeBootRegions(fullPath);
            cancellationToken.ThrowIfCancellationRequested();
            ExfatVerificationResult verification = await RebuildAsync(fullPath, _ => { }, progress,
                cancellationToken).ConfigureAwait(false);
            return new ExfatRepairResult(fullPath, bootRecovered, verification);
        }
        catch
        {
            if (bootRecovered && bootJournal is not null)
            {
                using var image = new FileStream(fullPath, FileMode.Open, FileAccess.Write, FileShare.Read,
                    BufferSize, FileOptions.RandomAccess);
                image.Position = 0;
                image.Write(bootJournal);
                image.Flush(flushToDisk: true);
            }
            throw;
        }
    }

    private static ExfatEditOperation NormalizeOperation(ExfatEditOperation operation)
    {
        string path = NormalizeImagePath(operation.ImagePath);
        string? source = operation.SourcePath is null ? null : Path.GetFullPath(operation.SourcePath);
        switch (operation.Kind)
        {
            case ExfatEditKind.ReplaceFile:
            case ExfatEditKind.AddFile:
                if (source is null || !File.Exists(source))
                    throw new FileNotFoundException("The edit source file was not found.", source);
                break;
            case ExfatEditKind.AddDirectoryTree:
                if (source is null || !Directory.Exists(source))
                    throw new DirectoryNotFoundException(source);
                break;
        }
        return operation with { ImagePath = path, SourcePath = source };
    }

    public static string NormalizeImagePath(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        string normalized = path.Replace('\\', '/').Trim('/');
        string[] parts = normalized.Split('/');
        if (parts.Any(part => part.Length == 0 || part is "." or ".." ||
                              part.Any(value => value < 0x20 || "\"*:<>?\\|".Contains(value))))
            throw new IOException($"The internal exFAT path is unsafe: {path}");
        return string.Join('/', parts);
    }

    private static bool CanReplaceExactly(string imagePath, ExfatEditOperation operation)
    {
        using var image = File.OpenRead(imagePath);
        using var volume = new ExfatVolume(image);
        ExfatEntry? entry = volume.Find(operation.ImagePath);
        return entry is { IsDirectory: false } && new FileInfo(operation.SourcePath!).Length == entry.Size;
    }

    private static async Task ReplaceExactlyAsync(string imagePath, string internalPath, string sourcePath,
        IProgress<FfpfscProgress>? progress, CancellationToken cancellationToken)
    {
        uint[] clusters;
        int clusterSize;
        long heapOffset;
        long fileLength;
        await using (var readImage = new FileStream(imagePath, FileMode.Open, FileAccess.Read, FileShare.Read,
                         BufferSize, FileOptions.Asynchronous | FileOptions.RandomAccess))
        using (var volume = new ExfatVolume(readImage, leaveOpen: true))
        {
            ExfatEntry entry = volume.Find(internalPath) ??
                               throw new FileNotFoundException("The internal exFAT file was not found.", internalPath);
            if (entry.IsDirectory) throw new IOException("A directory cannot be replaced with a file.");
            fileLength = entry.Size;
            if (new FileInfo(sourcePath).Length != fileLength)
                throw new InvalidOperationException("Fast replacement requires an exactly equal file size.");
            clusters = volume.GetFileClusters(internalPath).ToArray();
            clusterSize = volume.ClusterSize;
            heapOffset = volume.ClusterHeapOffset;
        }

        string journalPath = imagePath + "." + Guid.NewGuid().ToString("N") + ".replace-journal";
        byte[] buffer = new byte[BufferSize];
        bool journalComplete = false;
        bool imageModified = false;
        try
        {
            await using (var image = new FileStream(imagePath, FileMode.Open, FileAccess.ReadWrite, FileShare.Read,
                             BufferSize, FileOptions.Asynchronous | FileOptions.RandomAccess))
            await using (var journal = new FileStream(journalPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                             BufferSize, FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                long copied = 0;
                foreach (uint cluster in clusters)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    int count = checked((int)Math.Min(clusterSize, fileLength - copied));
                    image.Position = checked(heapOffset + ((long)cluster - 2) * clusterSize);
                    int remaining = count;
                    while (remaining > 0)
                    {
                        int chunk = Math.Min(buffer.Length, remaining);
                        await image.ReadExactlyAsync(buffer.AsMemory(0, chunk), cancellationToken).ConfigureAwait(false);
                        await journal.WriteAsync(buffer.AsMemory(0, chunk), cancellationToken).ConfigureAwait(false);
                        remaining -= chunk;
                    }
                    copied += count;
                    progress?.Report(new FfpfscProgress("Journaling original exFAT file", copied, fileLength));
                }
                await journal.FlushAsync(cancellationToken).ConfigureAwait(false);
                journalComplete = true;

                await using var source = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read,
                    BufferSize, FileOptions.Asynchronous | FileOptions.SequentialScan);
                copied = 0;
                imageModified = true;
                foreach (uint cluster in clusters)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    int count = checked((int)Math.Min(clusterSize, fileLength - copied));
                    image.Position = checked(heapOffset + ((long)cluster - 2) * clusterSize);
                    int remaining = count;
                    while (remaining > 0)
                    {
                        int chunk = Math.Min(buffer.Length, remaining);
                        await source.ReadExactlyAsync(buffer.AsMemory(0, chunk), cancellationToken).ConfigureAwait(false);
                        await image.WriteAsync(buffer.AsMemory(0, chunk), cancellationToken).ConfigureAwait(false);
                        remaining -= chunk;
                    }
                    copied += count;
                    progress?.Report(new FfpfscProgress("Replacing exFAT file", copied, fileLength));
                    cancellationToken.ThrowIfCancellationRequested();
                }
                await image.FlushAsync(CancellationToken.None).ConfigureAwait(false);
                image.Flush(flushToDisk: true);
            }

            byte[] sourceHash;
            byte[] imageHash;
            await using (FileStream source = File.OpenRead(sourcePath))
                sourceHash = await SHA256.HashDataAsync(source, cancellationToken).ConfigureAwait(false);
            await using (var image = File.OpenRead(imagePath))
            using (var volume = new ExfatVolume(image, leaveOpen: true))
            await using (Stream replaced = volume.OpenFile(internalPath))
                imageHash = await SHA256.HashDataAsync(replaced, cancellationToken).ConfigureAwait(false);
            if (!sourceHash.AsSpan().SequenceEqual(imageHash))
                throw new InvalidDataException("The replaced exFAT file failed SHA-256 verification.");
        }
        catch
        {
            if (imageModified && journalComplete && File.Exists(journalPath))
                await RestoreJournalAsync(imagePath, journalPath, clusters, heapOffset, clusterSize, fileLength)
                    .ConfigureAwait(false);
            throw;
        }
        finally
        {
            TryDeleteFile(journalPath);
        }
    }

    private static async Task RestoreJournalAsync(string imagePath, string journalPath, IReadOnlyList<uint> clusters,
        long heapOffset, int clusterSize, long fileLength)
    {
        byte[] buffer = new byte[BufferSize];
        await using var image = new FileStream(imagePath, FileMode.Open, FileAccess.Write, FileShare.Read,
            BufferSize, FileOptions.Asynchronous | FileOptions.RandomAccess);
        await using var journal = new FileStream(journalPath, FileMode.Open, FileAccess.Read, FileShare.Read,
            BufferSize, FileOptions.Asynchronous | FileOptions.SequentialScan);
        long copied = 0;
        foreach (uint cluster in clusters)
        {
            int count = checked((int)Math.Min(clusterSize, fileLength - copied));
            image.Position = checked(heapOffset + ((long)cluster - 2) * clusterSize);
            int remaining = count;
            while (remaining > 0)
            {
                int chunk = Math.Min(buffer.Length, remaining);
                await journal.ReadExactlyAsync(buffer.AsMemory(0, chunk)).ConfigureAwait(false);
                await image.WriteAsync(buffer.AsMemory(0, chunk)).ConfigureAwait(false);
                remaining -= chunk;
            }
            copied += count;
        }
        await image.FlushAsync().ConfigureAwait(false);
        image.Flush(flushToDisk: true);
    }

    private static async Task<ExfatVerificationResult> RebuildAsync(string imagePath, Action<string> editStaging,
        IProgress<FfpfscProgress>? progress, CancellationToken cancellationToken)
    {
        int clusterSize;
        using (var image = File.OpenRead(imagePath))
        using (var volume = new ExfatVolume(image))
            clusterSize = volume.ClusterSize;

        string directory = Path.GetDirectoryName(imagePath) ?? throw new IOException("The image has no parent directory.");
        string token = Guid.NewGuid().ToString("N");
        string staging = Path.Combine(directory, ".PS5PKGTool-exfat-edit-" + token);
        string replacement = imagePath + "." + token + ".rebuild";
        string backup = imagePath + "." + token + ".backup";
        try
        {
            await ExfatImage.ExtractDirectoryAsync(imagePath, staging, progress, cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            editStaging(staging);
            RemoveStaleAmprIndex(staging);
            cancellationToken.ThrowIfCancellationRequested();
            await ExfatImage.WriteDirectoryAsync(staging, replacement,
                new ExfatBuildOptions { ClusterSize = clusterSize, GenerateAmprIndex = true }, progress,
                cancellationToken).ConfigureAwait(false);
            _ = await ExfatImage.VerifyAsync(replacement, progress, cancellationToken).ConfigureAwait(false);

            File.Move(imagePath, backup);
            try
            {
                File.Move(replacement, imagePath);
                ExfatVerificationResult finalVerification = await ExfatImage.VerifyAsync(imagePath, progress,
                    cancellationToken).ConfigureAwait(false);
                TryDeleteFile(backup);
                return finalVerification;
            }
            catch
            {
                if (File.Exists(imagePath)) File.Delete(imagePath);
                if (File.Exists(backup)) File.Move(backup, imagePath);
                throw;
            }
        }
        finally
        {
            TryDeleteDirectory(staging);
            TryDeleteFile(replacement);
        }
    }

    private static void ApplyOperations(string stagingRoot, IReadOnlyList<ExfatEditOperation> operations,
        CancellationToken cancellationToken)
    {
        foreach (ExfatEditOperation operation in operations)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string target = ResolveStagingPath(stagingRoot, operation.ImagePath);
            switch (operation.Kind)
            {
                case ExfatEditKind.ReplaceFile:
                    if (!File.Exists(target)) throw new FileNotFoundException("The replacement target was not found.", operation.ImagePath);
                    File.Copy(operation.SourcePath!, target, overwrite: true);
                    break;
                case ExfatEditKind.AddFile:
                    if (File.Exists(target) || Directory.Exists(target))
                        throw new IOException($"The added path already exists: {operation.ImagePath}");
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    File.Copy(operation.SourcePath!, target);
                    break;
                case ExfatEditKind.AddDirectory:
                    if (File.Exists(target)) throw new IOException($"A file already uses this path: {operation.ImagePath}");
                    Directory.CreateDirectory(target);
                    break;
                case ExfatEditKind.AddDirectoryTree:
                    if (File.Exists(target) || Directory.Exists(target))
                        throw new IOException($"The added path already exists: {operation.ImagePath}");
                    CopyDirectory(operation.SourcePath!, target, cancellationToken);
                    break;
                case ExfatEditKind.Delete:
                    if (File.Exists(target)) File.Delete(target);
                    else if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
                    else throw new FileNotFoundException("The deletion target was not found.", operation.ImagePath);
                    break;
                default:
                    throw new ArgumentOutOfRangeException(nameof(operation.Kind));
            }
        }
    }

    private static string ResolveStagingPath(string root, string imagePath)
    {
        string full = Path.GetFullPath(Path.Combine(root, imagePath.Replace('/', Path.DirectorySeparatorChar)));
        string prefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new IOException("An exFAT edit path leaves the staging directory.");
        return full;
    }

    private static void CopyDirectory(string source, string destination, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(destination);
        foreach (string directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
        {
            cancellationToken.ThrowIfCancellationRequested();
            string relative = Path.GetRelativePath(source, directory);
            Directory.CreateDirectory(Path.Combine(destination, relative));
        }
        foreach (string file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            cancellationToken.ThrowIfCancellationRequested();
            string relative = Path.GetRelativePath(source, file);
            string target = Path.Combine(destination, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target);
        }
    }

    private static void RemoveStaleAmprIndex(string stagingRoot)
    {
        if (File.Exists(Path.Combine(stagingRoot, "fakelib", "libSceAmpr.sprx"))) return;
        TryDeleteFile(Path.Combine(stagingRoot, "ampr_emu.index"));
        TryDeleteFile(Path.Combine(stagingRoot, "ampr_emu.index.tmp"));
    }

    private static (byte[] Original, int SectorSize, bool Changed) NormalizeBootRegions(string imagePath)
    {
        using var image = new FileStream(imagePath, FileMode.Open, FileAccess.ReadWrite, FileShare.Read,
            BufferSize, FileOptions.RandomAccess);
        int sectorSize = DetectSectorSize(image);
        int regionSize = checked(12 * sectorSize);
        byte[] original = new byte[checked(regionSize * 2)];
        image.Position = 0;
        image.ReadExactly(original);
        ReadOnlySpan<byte> main = original.AsSpan(0, regionSize);
        ReadOnlySpan<byte> backup = original.AsSpan(regionSize, regionSize);
        bool mainValid = IsValidBootRegion(main, sectorSize);
        bool backupValid = IsValidBootRegion(backup, sectorSize);
        if (!mainValid && !backupValid)
            throw new InvalidDataException("Both exFAT boot regions are invalid; automatic repair has no trusted source.");
        byte[] repaired = original.ToArray();
        bool changed = false;
        if (!mainValid && backupValid)
        {
            backup.CopyTo(repaired.AsSpan(0, regionSize));
            changed = true;
        }
        else if (!backupValid || !main.SequenceEqual(backup))
        {
            main.CopyTo(repaired.AsSpan(regionSize, regionSize));
            changed = true;
        }
        if (changed)
        {
            image.Position = 0;
            image.Write(repaired);
            image.Flush(flushToDisk: true);
        }
        return (original, sectorSize, changed);
    }

    private static int DetectSectorSize(Stream image)
    {
        byte[] first = new byte[512];
        image.Position = 0;
        image.ReadExactly(first);
        if (first.AsSpan(3, 8).SequenceEqual("EXFAT   "u8) && first[0x6C] is >= 9 and <= 12)
            return 1 << first[0x6C];
        foreach (int size in new[] { 512, 1024, 2048, 4096 })
        {
            long offset = checked(12L * size);
            if (offset + 512 > image.Length) continue;
            image.Position = offset;
            image.ReadExactly(first);
            if (first.AsSpan(3, 8).SequenceEqual("EXFAT   "u8) && first[0x6C] is >= 9 and <= 12 &&
                (1 << first[0x6C]) == size) return size;
        }
        throw new InvalidDataException("No recognizable exFAT boot region was found.");
    }

    private static bool IsValidBootRegion(ReadOnlySpan<byte> region, int sectorSize)
    {
        if (region.Length != 12 * sectorSize || !region.Slice(3, 8).SequenceEqual("EXFAT   "u8) ||
            BinaryPrimitives.ReadUInt16LittleEndian(region.Slice(0x1FE, 2)) != 0xAA55) return false;
        uint checksum = 0;
        for (int index = 0; index < 11 * sectorSize; index++)
        {
            if (index is 106 or 107 or 112) continue;
            checksum = unchecked((checksum >> 1 | checksum << 31) + region[index]);
        }
        for (int offset = 11 * sectorSize; offset < 12 * sectorSize; offset += 4)
            if (BinaryPrimitives.ReadUInt32LittleEndian(region.Slice(offset, 4)) != checksum) return false;
        return true;
    }

    private static void TryDeleteFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static bool IsInside(string path, string directory)
    {
        string fullPath = Path.GetFullPath(path);
        string fullDirectory = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return fullPath.StartsWith(fullDirectory, StringComparison.OrdinalIgnoreCase);
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
