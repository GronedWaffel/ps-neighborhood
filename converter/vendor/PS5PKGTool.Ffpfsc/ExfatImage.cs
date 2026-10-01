using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace PS5PKGTool.Ffpfsc;

public sealed class ExfatBuildOptions
{
    public int? ClusterSize { get; init; }
    public bool GenerateAmprIndex { get; init; } = true;

    internal void Validate()
    {
        if (ClusterSize is int size &&
            (size is < 0x1000 or > 0x2000000 || (size & (size - 1)) != 0 || size % 512 != 0))
            throw new ArgumentOutOfRangeException(nameof(ClusterSize),
                "The exFAT cluster size must be a power of two from 4 KiB through 32 MiB.");
    }
}

public sealed class ExfatImageSource : IDisposable
{
    internal ExfatImageSource(Stream stream, long length, int clusterSize, int fileCount, int directoryCount)
    {
        Stream = stream;
        Length = length;
        ClusterSize = clusterSize;
        FileCount = fileCount;
        DirectoryCount = directoryCount;
    }

    public Stream Stream { get; }
    public long Length { get; }
    public int ClusterSize { get; }
    public int FileCount { get; }
    public int DirectoryCount { get; }
    public void Dispose() => Stream.Dispose();
}

public sealed record ExfatVerificationResult(
    string ImagePath,
    long ImageSize,
    int ClusterSize,
    int FileCount,
    int DirectoryCount,
    long LogicalFileBytes,
    string ManifestSha256);

/// <summary>Creates a standards-based exFAT image as a forward-only stream over a loose game directory.</summary>
public static class ExfatImage
{
    private const int SectorSize = 512;
    private const int FatOffsetSectors = 128;
    private const uint FatEnd = 0xFFFFFFFF;
    private const int FirstCluster = 2;
    private const int FileChunkSize = 1024 * 1024;
    private const uint VolumeSerial = 0x4D6B5046; // "MkPF", matching MkPFS deterministic images.
    private static readonly IComparer<string> MkPfsNameComparer = Comparer<string>.Create((left, right) =>
        string.Compare(left.ToLowerInvariant(), right.ToLowerInvariant(), StringComparison.Ordinal));
    private static readonly HashSet<string> IgnoredNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ".ds_store", ".spotlight-v100", ".trashes", ".fseventsd", ".temporaryitems",
        ".documentrevisions-v100", ".apdisk", "__macosx", ".volumeicon.icns",
        "thumbs.db", "ehthumbs.db", "desktop.ini", "$recycle.bin", "system volume information"
    };

    public static ExfatImageSource OpenDirectory(string sourceDirectory, ExfatBuildOptions? options = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceDirectory);
        options ??= new ExfatBuildOptions();
        options.Validate();
        string rootPath = Path.GetFullPath(sourceDirectory);
        if (!Directory.Exists(rootPath)) throw new DirectoryNotFoundException(rootPath);

        ExfatNode root = ScanTree(rootPath);
        if (options.GenerateAmprIndex) AddVirtualAmprIndex(root);
        int clusterSize = options.ClusterSize ?? ChooseClusterSize(root);
        byte[] upcase = BuildUpcaseTable();
        Layout layout = BuildLayout(root, clusterSize, upcase.Length);
        IEnumerable<ReadOnlyMemory<byte>> chunks = EmitImage(root, layout, upcase);
        int fileCount = Walk(root).Count(node => !node.IsDirectory);
        int directoryCount = Walk(root).Count(node => node.IsDirectory);
        return new ExfatImageSource(new ChunkSequenceStream(chunks), layout.ImageLength, clusterSize,
            fileCount, directoryCount);
    }

    public static async Task WriteDirectoryAsync(string sourceDirectory, string outputPath,
        ExfatBuildOptions? options = null, IProgress<FfpfscProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        string outputFullPath = Path.GetFullPath(outputPath);
        if (File.Exists(outputFullPath)) throw new IOException($"The output file already exists: {outputFullPath}");
        string? directory = Path.GetDirectoryName(outputFullPath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        string tempPath = outputFullPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using ExfatImageSource source = OpenDirectory(sourceDirectory, options);
            await using var output = new FileStream(tempPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                FileChunkSize, FileOptions.Asynchronous | FileOptions.SequentialScan);
            byte[] buffer = new byte[FileChunkSize];
            long copied = 0;
            while (copied < source.Length)
            {
                cancellationToken.ThrowIfCancellationRequested();
                int wanted = checked((int)Math.Min(buffer.Length, source.Length - copied));
                int read = await source.Stream.ReadAsync(buffer.AsMemory(0, wanted), cancellationToken).ConfigureAwait(false);
                if (read == 0) throw new EndOfStreamException("The exFAT serializer ended before its planned length.");
                await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                copied += read;
                progress?.Report(new FfpfscProgress("Building exFAT", copied, source.Length));
            }
            if (source.Stream.ReadByte() != -1) throw new InvalidDataException("The exFAT serializer exceeded its planned length.");
            await output.FlushAsync(cancellationToken).ConfigureAwait(false);
            output.Close();
            File.Move(tempPath, outputFullPath);
        }
        catch
        {
            try { File.Delete(tempPath); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            throw;
        }
    }

    public static Task<ExfatVerificationResult> VerifyAsync(string imagePath,
        IProgress<FfpfscProgress>? progress = null, CancellationToken cancellationToken = default) =>
        Task.Run(() => Verify(imagePath, progress, cancellationToken), cancellationToken);

    public static async Task ExtractDirectoryAsync(string imagePath, string outputDirectory,
        IProgress<FfpfscProgress>? progress = null, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(imagePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputDirectory);
        string sourcePath = Path.GetFullPath(imagePath);
        string destination = Path.GetFullPath(outputDirectory);
        if (Directory.Exists(destination) || File.Exists(destination))
            throw new IOException($"The extraction destination already exists: {destination}");
        string? parent = Path.GetDirectoryName(destination);
        if (string.IsNullOrEmpty(parent)) throw new IOException("The extraction destination has no parent directory.");
        Directory.CreateDirectory(parent);
        string temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            Directory.CreateDirectory(temporary);
            await using var image = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read,
                FileChunkSize, FileOptions.Asynchronous | FileOptions.RandomAccess);
            using var volume = new ExfatVolume(image, leaveOpen: true);
            ExfatEntry[] files = volume.Entries.Where(entry => !entry.IsDirectory)
                .OrderBy(entry => entry.Path, StringComparer.OrdinalIgnoreCase).ToArray();
            long totalBytes = files.Sum(entry => entry.Size);
            long copied = 0;

            foreach (ExfatEntry directoryEntry in volume.Entries.Where(entry => entry.IsDirectory)
                         .OrderBy(entry => entry.Path.Count(character => character == '/')))
            {
                cancellationToken.ThrowIfCancellationRequested();
                Directory.CreateDirectory(ResolveExtractionPath(temporary, directoryEntry.Path));
            }

            byte[] buffer = new byte[FileChunkSize];
            foreach (ExfatEntry entry in files)
            {
                cancellationToken.ThrowIfCancellationRequested();
                string outputPath = ResolveExtractionPath(temporary, entry.Path);
                string? outputParent = Path.GetDirectoryName(outputPath);
                if (!string.IsNullOrEmpty(outputParent)) Directory.CreateDirectory(outputParent);
                using Stream input = volume.OpenFile(entry.Path);
                await using var output = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write,
                    FileShare.None, FileChunkSize, FileOptions.Asynchronous | FileOptions.SequentialScan);
                while (true)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    int read = await input.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                    if (read == 0) break;
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                    copied += read;
                    progress?.Report(new FfpfscProgress("Extracting exFAT", copied, totalBytes));
                }
            }
            Directory.Move(temporary, destination);
        }
        catch
        {
            try { if (Directory.Exists(temporary)) Directory.Delete(temporary, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            throw;
        }
    }

    private static ExfatVerificationResult Verify(string imagePath, IProgress<FfpfscProgress>? progress,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(imagePath);
        string fullPath = Path.GetFullPath(imagePath);
        using var image = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read,
            FileChunkSize, FileOptions.RandomAccess);
        using var volume = new ExfatVolume(image, leaveOpen: true);
        ExfatEntry[] files = volume.Entries.Where(entry => !entry.IsDirectory)
            .OrderBy(entry => entry.Path, StringComparer.Ordinal).ToArray();
        long totalBytes = files.Sum(entry => entry.Size);
        long checkedBytes = 0;
        using IncrementalHash manifest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        byte[] buffer = new byte[FileChunkSize];
        byte[] sizeBytes = new byte[sizeof(long)];
        foreach (ExfatEntry entry in files)
        {
            cancellationToken.ThrowIfCancellationRequested();
            manifest.AppendData(Encoding.UTF8.GetBytes(entry.Path));
            manifest.AppendData([0]);
            BinaryPrimitives.WriteInt64LittleEndian(sizeBytes, entry.Size);
            manifest.AppendData(sizeBytes);
            using Stream input = volume.OpenFile(entry.Path);
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                int read = input.Read(buffer, 0, buffer.Length);
                if (read == 0) break;
                manifest.AppendData(buffer, 0, read);
                checkedBytes += read;
                progress?.Report(new FfpfscProgress("Verifying exFAT", checkedBytes, totalBytes));
            }
        }
        return new ExfatVerificationResult(fullPath, image.Length, volume.ClusterSize, files.Length,
            volume.Entries.Count(entry => entry.IsDirectory) + 1, totalBytes,
            Convert.ToHexString(manifest.GetHashAndReset()).ToLowerInvariant());
    }

    private static string ResolveExtractionPath(string root, string relativePath)
    {
        string fullPath = Path.GetFullPath(Path.Combine(root,
            relativePath.Replace('/', Path.DirectorySeparatorChar)));
        string prefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!fullPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("An exFAT entry leaves the extraction directory.");
        return fullPath;
    }

    private static ExfatNode ScanTree(string rootPath)
    {
        var root = new ExfatNode(string.Empty, string.Empty, true, 0, null);
        ScanDirectory(rootPath, root);
        return root;
    }

    private static void ScanDirectory(string directoryPath, ExfatNode parent)
    {
        var entries = new DirectoryInfo(directoryPath).EnumerateFileSystemInfos()
            .OrderBy(entry => entry.Name, MkPfsNameComparer).ToArray();
        foreach (FileSystemInfo entry in entries)
        {
            if (IsIgnoredName(entry.Name) || (entry.Attributes & FileAttributes.ReparsePoint) != 0) continue;
            ValidateName(entry.Name);
            string relative = parent.RelativePath.Length == 0
                ? entry.Name
                : parent.RelativePath + '/' + entry.Name;
            if (entry is DirectoryInfo directory)
            {
                var child = new ExfatNode(relative, entry.Name, true, 0, null);
                parent.Children.Add(child);
                ScanDirectory(directory.FullName, child);
            }
            else if (entry is FileInfo file)
            {
                parent.Children.Add(new ExfatNode(relative, entry.Name, false, file.Length, file.FullName,
                    new DateTimeOffset(file.LastWriteTimeUtc).ToUnixTimeSeconds()));
            }
        }
    }

    private static bool IsIgnoredName(string name) => name.StartsWith("._", StringComparison.Ordinal) ||
                                                       IgnoredNames.Contains(name);

    private static void AddVirtualAmprIndex(ExfatNode root)
    {
        bool hasMarker = Walk(root).Any(node => !node.IsDirectory &&
            node.RelativePath.Equals("fakelib/libSceAmpr.sprx", StringComparison.OrdinalIgnoreCase));
        if (!hasMarker) return;
        root.Children.RemoveAll(node => !node.IsDirectory &&
            (node.Name.Equals("ampr_emu.index", StringComparison.OrdinalIgnoreCase) ||
             node.Name.Equals("ampr_emu.index.tmp", StringComparison.OrdinalIgnoreCase)));
        byte[] index = AmprIndex.Build(Walk(root).Where(node => !node.IsDirectory).Select(node =>
            new AmprFileRecord(node.RelativePath, node.Size, node.ModifiedTime)));
        if (index.Length == 0) return;
        root.Children.Add(new ExfatNode("ampr_emu.index", "ampr_emu.index", false, index.Length, null,
            DateTimeOffset.UtcNow.ToUnixTimeSeconds(), index));
        root.Children.Sort((left, right) => MkPfsNameComparer.Compare(left.Name, right.Name));
    }

    private static void ValidateName(string name)
    {
        if (name.Length is < 1 or > 255 || name is "." or ".." ||
            name.Any(value => value < 0x20 || "\"*/:<>?\\|".Contains(value)))
            throw new IOException($"The filename cannot be represented safely in exFAT: {name}");
    }

    private static int ChooseClusterSize(ExfatNode root)
    {
        ExfatNode[] files = Walk(root).Where(node => !node.IsDirectory).ToArray();
        long total = files.Sum(node => node.Size);
        long average = files.Length == 0 ? 0 : total / files.Length;
        return average >= 1024 * 1024 ? 0x10000 : 0x8000;
    }

    private static Layout BuildLayout(ExfatNode root, int clusterSize, int upcaseLength)
    {
        int upcaseClusters = DivideRoundUp(upcaseLength, clusterSize);
        int contentClusters = upcaseClusters;
        foreach (ExfatNode node in Walk(root))
        {
            node.ClusterCount = node.IsDirectory
                ? Math.Max(1, DivideRoundUp(DirectoryEntryCount(node, node == root) * 32L, clusterSize))
                : DivideRoundUp(node.Size, clusterSize);
            contentClusters = checked(contentClusters + node.ClusterCount);
        }

        int sectorsPerCluster = clusterSize / SectorSize;
        int bitmapClusters;
        int clusterCount;
        int fatLengthSectors;
        int heapOffsetSectors;
        long volumeSectors;
        bitmapClusters = 1;
        while (true)
        {
            int total = checked(contentClusters + bitmapClusters);
            int needed = DivideRoundUp(DivideRoundUp(total, 8), clusterSize);
            if (needed == bitmapClusters) break;
            bitmapClusters = needed;
        }
        clusterCount = checked(contentClusters + bitmapClusters);
        int fatEntries = checked(clusterCount + 2);
        fatLengthSectors = Align(DivideRoundUp(checked((long)fatEntries * 4), SectorSize), sectorsPerCluster);
        heapOffsetSectors = Align(checked(FatOffsetSectors + fatLengthSectors), sectorsPerCluster);
        volumeSectors = checked((long)heapOffsetSectors + (long)clusterCount * sectorsPerCluster);

        int nextCluster = checked(FirstCluster + bitmapClusters + upcaseClusters);
        foreach (ExfatNode node in Walk(root))
        {
            if (node.ClusterCount == 0) continue;
            node.FirstCluster = nextCluster;
            nextCluster = checked(nextCluster + node.ClusterCount);
        }
        if (nextCluster != FirstCluster + clusterCount) throw new InvalidOperationException("exFAT layout accounting failed.");

        if (volumeSectors > uint.MaxValue * (long)sectorsPerCluster)
            throw new IOException("The dump is too large for this exFAT layout.");

        return new Layout(clusterSize, bitmapClusters, upcaseClusters, clusterCount, root.FirstCluster,
            fatLengthSectors, heapOffsetSectors, checked(volumeSectors * SectorSize));
    }

    private static IEnumerable<ReadOnlyMemory<byte>> EmitImage(ExfatNode root, Layout layout, byte[] upcase)
    {
        byte[] boot = BuildBootRegion(layout);
        yield return boot;
        yield return boot;
        yield return new byte[(FatOffsetSectors - 24) * SectorSize];
        foreach (ReadOnlyMemory<byte> chunk in EmitFat(root, layout)) yield return chunk;
        int paddingSectors = layout.HeapOffsetSectors - (FatOffsetSectors + layout.FatLengthSectors);
        if (paddingSectors > 0) yield return new byte[paddingSectors * SectorSize];

        foreach (ReadOnlyMemory<byte> chunk in EmitBitmap(layout.ClusterCount, layout.BitmapClusters * layout.ClusterSize))
            yield return chunk;
        yield return upcase;
        int upcasePadding = layout.UpcaseClusters * layout.ClusterSize - upcase.Length;
        if (upcasePadding > 0) yield return new byte[upcasePadding];

        foreach (ReadOnlyMemory<byte> chunk in EmitDirectory(root, root, layout)) yield return chunk;
        foreach (ExfatNode child in Walk(root).Skip(1))
        {
            if (child.IsDirectory)
            {
                foreach (ReadOnlyMemory<byte> chunk in EmitDirectory(root, child, layout)) yield return chunk;
                continue;
            }
            if (child.Size == 0) continue;
            byte[] buffer = new byte[FileChunkSize];
            long emitted = 0;
            if (child.VirtualContent is not null)
            {
                yield return child.VirtualContent;
                long virtualPadding = checked((long)child.ClusterCount * layout.ClusterSize - child.VirtualContent.Length);
                foreach (ReadOnlyMemory<byte> chunk in ZeroChunks(virtualPadding)) yield return chunk;
                continue;
            }
            using (var input = new FileStream(child.FullPath!, FileMode.Open, FileAccess.Read, FileShare.Read,
                       FileChunkSize, FileOptions.SequentialScan))
            {
                while (emitted < child.Size)
                {
                    int wanted = checked((int)Math.Min(buffer.Length, child.Size - emitted));
                    int read = input.Read(buffer, 0, wanted);
                    if (read == 0) throw new EndOfStreamException($"The source file changed during conversion: {child.FullPath}");
                    emitted += read;
                    yield return buffer.AsMemory(0, read);
                }
                if (input.ReadByte() != -1)
                    throw new IOException($"The source file grew during conversion: {child.FullPath}");
            }
            long padding = checked((long)child.ClusterCount * layout.ClusterSize - emitted);
            foreach (ReadOnlyMemory<byte> chunk in ZeroChunks(padding)) yield return chunk;
        }
    }

    private static IEnumerable<ReadOnlyMemory<byte>> EmitFat(ExfatNode root, Layout layout)
    {
        var chainEnds = new HashSet<int>
        {
            checked(FirstCluster + layout.BitmapClusters - 1),
            checked(FirstCluster + layout.BitmapClusters + layout.UpcaseClusters - 1)
        };
        foreach (ExfatNode node in Walk(root).Where(node => node.ClusterCount > 0))
            chainEnds.Add(checked(node.FirstCluster + node.ClusterCount - 1));

        long fatBytes = checked((long)layout.FatLengthSectors * SectorSize);
        byte[] buffer = new byte[FileChunkSize];
        long offset = 0;
        while (offset < fatBytes)
        {
            int count = checked((int)Math.Min(buffer.Length, fatBytes - offset));
            Array.Clear(buffer, 0, count);
            int firstEntry = checked((int)(offset / 4));
            int entries = count / 4;
            for (int index = 0; index < entries; index++)
            {
                int cluster = firstEntry + index;
                uint value = cluster switch
                {
                    0 => 0xFFFFFFF8,
                    1 => FatEnd,
                    _ when cluster > layout.ClusterCount + 1 => 0,
                    _ when chainEnds.Contains(cluster) => FatEnd,
                    _ => checked((uint)(cluster + 1))
                };
                BinaryPrimitives.WriteUInt32LittleEndian(buffer.AsSpan(index * 4, 4), value);
            }
            offset += count;
            yield return buffer.AsMemory(0, count);
        }
    }

    private static IEnumerable<ReadOnlyMemory<byte>> EmitBitmap(int clusterCount, int allocationBytes)
    {
        byte[] buffer = new byte[Math.Min(FileChunkSize, allocationBytes)];
        int bytesRemaining = DivideRoundUp(clusterCount, 8);
        int allocationRemaining = allocationBytes;
        while (allocationRemaining > 0)
        {
            int count = Math.Min(buffer.Length, allocationRemaining);
            Array.Clear(buffer, 0, count);
            int used = Math.Min(count, bytesRemaining);
            Array.Fill(buffer, (byte)0xFF, 0, used);
            if (used > 0 && bytesRemaining <= count && (clusterCount & 7) != 0)
                buffer[used - 1] = checked((byte)((1 << (clusterCount & 7)) - 1));
            bytesRemaining -= used;
            allocationRemaining -= count;
            yield return buffer.AsMemory(0, count);
        }
    }

    private static IEnumerable<ReadOnlyMemory<byte>> EmitDirectory(ExfatNode root, ExfatNode directory, Layout layout)
    {
        int emitted = 0;
        if (directory == root)
        {
            byte[] label = new byte[32];
            label[0] = 0x83;
            emitted += label.Length;
            yield return label;

            byte[] bitmap = new byte[32];
            bitmap[0] = 0x81;
            BinaryPrimitives.WriteUInt32LittleEndian(bitmap.AsSpan(0x14, 4), FirstCluster);
            BinaryPrimitives.WriteUInt64LittleEndian(bitmap.AsSpan(0x18, 8),
                checked((ulong)DivideRoundUp(layout.ClusterCount, 8)));
            emitted += bitmap.Length;
            yield return bitmap;

            byte[] upcaseEntry = new byte[32];
            upcaseEntry[0] = 0x82;
            BinaryPrimitives.WriteUInt32LittleEndian(upcaseEntry.AsSpan(0x04, 4), layout.UpcaseChecksum);
            BinaryPrimitives.WriteUInt32LittleEndian(upcaseEntry.AsSpan(0x14, 4),
                checked((uint)(FirstCluster + layout.BitmapClusters)));
            BinaryPrimitives.WriteUInt64LittleEndian(upcaseEntry.AsSpan(0x18, 8), checked((ulong)layout.UpcaseLength));
            emitted += upcaseEntry.Length;
            yield return upcaseEntry;
        }
        foreach (ExfatNode child in directory.Children)
        {
            byte[] entries = BuildFileEntrySet(child, layout.ClusterSize, layout.UpcaseMap);
            emitted += entries.Length;
            yield return entries;
        }
        long padding = checked((long)directory.ClusterCount * layout.ClusterSize - emitted);
        foreach (ReadOnlyMemory<byte> chunk in ZeroChunks(padding)) yield return chunk;
    }

    private static byte[] BuildFileEntrySet(ExfatNode child, int clusterSize, ushort[] upcaseMap)
    {
        int nameEntries = DivideRoundUp(child.Name.Length, 15);
        int secondaryCount = 1 + nameEntries;
        byte[] result = new byte[checked((secondaryCount + 1) * 32)];
        Span<byte> file = result.AsSpan(0, 32);
        file[0] = 0x85;
        file[1] = checked((byte)secondaryCount);
        BinaryPrimitives.WriteUInt16LittleEndian(file.Slice(0x04, 2), child.IsDirectory ? (ushort)0x10 : (ushort)0x20);
        const uint fixedTimestamp = ((2024 - 1980u) << 25) | (1u << 21) | (1u << 16);
        for (int offset = 0x08; offset <= 0x10; offset += 4)
            BinaryPrimitives.WriteUInt32LittleEndian(file.Slice(offset, 4), fixedTimestamp);

        Span<byte> stream = result.AsSpan(32, 32);
        stream[0] = 0xC0;
        bool allocated = child.FirstCluster >= FirstCluster;
        stream[1] = allocated ? (byte)0x01 : (byte)0;
        stream[3] = checked((byte)child.Name.Length);
        BinaryPrimitives.WriteUInt16LittleEndian(stream.Slice(0x04, 2), NameHash(child.Name, upcaseMap));
        long dataLength = child.IsDirectory ? checked((long)child.ClusterCount * clusterSize) : child.Size;
        BinaryPrimitives.WriteUInt64LittleEndian(stream.Slice(0x08, 8), checked((ulong)dataLength));
        BinaryPrimitives.WriteUInt32LittleEndian(stream.Slice(0x14, 4), allocated ? checked((uint)child.FirstCluster) : 0);
        BinaryPrimitives.WriteUInt64LittleEndian(stream.Slice(0x18, 8), checked((ulong)dataLength));

        byte[] nameBytes = Encoding.Unicode.GetBytes(child.Name);
        for (int index = 0; index < nameEntries; index++)
        {
            Span<byte> nameEntry = result.AsSpan((2 + index) * 32, 32);
            nameEntry[0] = 0xC1;
            int sourceOffset = index * 30;
            int count = Math.Min(30, nameBytes.Length - sourceOffset);
            nameBytes.AsSpan(sourceOffset, count).CopyTo(nameEntry.Slice(2, count));
        }
        BinaryPrimitives.WriteUInt16LittleEndian(file.Slice(0x02, 2), EntrySetChecksum(result));
        return result;
    }

    private static byte[] BuildBootRegion(Layout layout)
    {
        byte[] region = new byte[12 * SectorSize];
        Span<byte> vbr = region.AsSpan(0, SectorSize);
        vbr[0] = 0xEB; vbr[1] = 0x76; vbr[2] = 0x90;
        "EXFAT   "u8.CopyTo(vbr.Slice(3, 8));
        BinaryPrimitives.WriteUInt64LittleEndian(vbr.Slice(0x48, 8), checked((ulong)(layout.ImageLength / SectorSize)));
        BinaryPrimitives.WriteUInt32LittleEndian(vbr.Slice(0x50, 4), FatOffsetSectors);
        BinaryPrimitives.WriteUInt32LittleEndian(vbr.Slice(0x54, 4), checked((uint)layout.FatLengthSectors));
        BinaryPrimitives.WriteUInt32LittleEndian(vbr.Slice(0x58, 4), checked((uint)layout.HeapOffsetSectors));
        BinaryPrimitives.WriteUInt32LittleEndian(vbr.Slice(0x5C, 4), checked((uint)layout.ClusterCount));
        BinaryPrimitives.WriteUInt32LittleEndian(vbr.Slice(0x60, 4), checked((uint)layout.RootCluster));
        BinaryPrimitives.WriteUInt32LittleEndian(vbr.Slice(0x64, 4), VolumeSerial);
        BinaryPrimitives.WriteUInt16LittleEndian(vbr.Slice(0x68, 2), 0x0100);
        vbr[0x6C] = 9;
        vbr[0x6D] = checked((byte)BitOperationsLog2(layout.ClusterSize / SectorSize));
        vbr[0x6E] = 1;
        vbr[0x6F] = 0x80;
        vbr[0x70] = 0xFF;
        BinaryPrimitives.WriteUInt16LittleEndian(vbr.Slice(0x1FE, 2), 0xAA55);
        for (int sector = 1; sector <= 8; sector++)
            BinaryPrimitives.WriteUInt32LittleEndian(region.AsSpan((sector + 1) * SectorSize - 4, 4), 0xAA550000);

        uint checksum = 0;
        for (int index = 0; index < 11 * SectorSize; index++)
        {
            if (index is 106 or 107 or 112) continue;
            checksum = unchecked((checksum >> 1 | checksum << 31) + region[index]);
        }
        for (int index = 11 * SectorSize; index < 12 * SectorSize; index += 4)
            BinaryPrimitives.WriteUInt32LittleEndian(region.AsSpan(index, 4), checksum);
        return region;
    }

    private static byte[] BuildUpcaseTable() => ExfatUpcaseTable.Create();

    private static ushort[] BuildUpcaseMap(byte[] upcase)
    {
        var result = new ushort[char.MaxValue + 1];
        int sourceOffset = 0;
        int codePoint = 0;
        while (sourceOffset < upcase.Length && codePoint < result.Length)
        {
            ushort value = BinaryPrimitives.ReadUInt16LittleEndian(upcase.AsSpan(sourceOffset, 2));
            sourceOffset += 2;
            if (value != ushort.MaxValue)
            {
                result[codePoint++] = value;
                continue;
            }

            if (sourceOffset == upcase.Length && codePoint == ushort.MaxValue)
            {
                result[codePoint++] = ushort.MaxValue;
                continue;
            }

            if (sourceOffset + 2 > upcase.Length)
                throw new InvalidDataException("The exFAT up-case table ends inside an identity run.");
            int count = BinaryPrimitives.ReadUInt16LittleEndian(upcase.AsSpan(sourceOffset, 2));
            sourceOffset += 2;
            if (count == 0 || count > result.Length - codePoint)
                throw new InvalidDataException("The exFAT up-case table contains an invalid identity run.");
            for (int index = 0; index < count; index++) result[codePoint] = checked((ushort)codePoint++);
        }
        if (sourceOffset != upcase.Length || codePoint != result.Length)
            throw new InvalidDataException("The exFAT up-case table does not cover the Unicode BMP.");
        return result;
    }

    private static uint TableChecksum(byte[] data)
    {
        uint checksum = 0;
        foreach (byte value in data) checksum = unchecked((checksum >> 1 | checksum << 31) + value);
        return checksum;
    }

    private static ushort NameHash(string name, ushort[] upcaseMap)
    {
        ushort hash = 0;
        foreach (char value in name)
        {
            ushort upper = upcaseMap[value];
            hash = unchecked((ushort)((hash >> 1 | hash << 15) + (byte)upper));
            hash = unchecked((ushort)((hash >> 1 | hash << 15) + (byte)(upper >> 8)));
        }
        return hash;
    }

    private static ushort EntrySetChecksum(byte[] entries)
    {
        ushort checksum = 0;
        for (int index = 0; index < entries.Length; index++)
        {
            if (index is 2 or 3) continue;
            checksum = unchecked((ushort)((checksum >> 1 | checksum << 15) + entries[index]));
        }
        return checksum;
    }

    private static int DirectoryEntryCount(ExfatNode node, bool root)
    {
        int count = root ? 3 : 0;
        foreach (ExfatNode child in node.Children) count = checked(count + 2 + DivideRoundUp(child.Name.Length, 15));
        return count;
    }

    private static IEnumerable<ExfatNode> Walk(ExfatNode root)
    {
        yield return root;
        foreach (ExfatNode child in root.Children)
        {
            yield return child;
            if (!child.IsDirectory) continue;
            foreach (ExfatNode descendant in Walk(child).Skip(1)) yield return descendant;
        }
    }

    private static IEnumerable<ReadOnlyMemory<byte>> ZeroChunks(long count)
    {
        if (count <= 0) yield break;
        byte[] zeros = new byte[checked((int)Math.Min(FileChunkSize, count))];
        while (count > 0)
        {
            int size = checked((int)Math.Min(zeros.Length, count));
            count -= size;
            yield return zeros.AsMemory(0, size);
        }
    }

    private static int DivideRoundUp(long value, int divisor) => value == 0 ? 0 : checked((int)((value - 1) / divisor + 1));
    private static int Align(int value, int alignment) => checked((value + alignment - 1) / alignment * alignment);
    private static int BitOperationsLog2(int powerOfTwo) => System.Numerics.BitOperations.Log2(checked((uint)powerOfTwo));

    private sealed class ExfatNode(string relativePath, string name, bool isDirectory, long size, string? fullPath,
        long modifiedTime = 0, byte[]? virtualContent = null)
    {
        public string RelativePath { get; } = relativePath;
        public string Name { get; } = name;
        public bool IsDirectory { get; } = isDirectory;
        public long Size { get; } = size;
        public string? FullPath { get; } = fullPath;
        public long ModifiedTime { get; } = modifiedTime;
        public byte[]? VirtualContent { get; } = virtualContent;
        public List<ExfatNode> Children { get; } = [];
        public int FirstCluster { get; set; }
        public int ClusterCount { get; set; }
    }

    private sealed class Layout
    {
        public Layout(int clusterSize, int bitmapClusters, int upcaseClusters, int clusterCount, int rootCluster,
            int fatLengthSectors, int heapOffsetSectors, long imageLength)
        {
            ClusterSize = clusterSize;
            BitmapClusters = bitmapClusters;
            UpcaseClusters = upcaseClusters;
            ClusterCount = clusterCount;
            RootCluster = rootCluster;
            FatLengthSectors = fatLengthSectors;
            HeapOffsetSectors = heapOffsetSectors;
            ImageLength = imageLength;
            byte[] table = BuildUpcaseTable();
            UpcaseLength = table.Length;
            UpcaseChecksum = TableChecksum(table);
            UpcaseMap = BuildUpcaseMap(table);
        }

        public int ClusterSize { get; }
        public int BitmapClusters { get; }
        public int UpcaseClusters { get; }
        public int ClusterCount { get; }
        public int RootCluster { get; }
        public int FatLengthSectors { get; }
        public int HeapOffsetSectors { get; }
        public long ImageLength { get; }
        public int UpcaseLength { get; }
        public uint UpcaseChecksum { get; }
        public ushort[] UpcaseMap { get; }
    }

    private sealed class ChunkSequenceStream(IEnumerable<ReadOnlyMemory<byte>> chunks) : Stream
    {
        private readonly IEnumerator<ReadOnlyMemory<byte>> _chunks = chunks.GetEnumerator();
        private ReadOnlyMemory<byte> _current;
        private int _currentOffset;
        private bool _ended;

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> destination)
        {
            int written = 0;
            while (written < destination.Length)
            {
                if (_currentOffset >= _current.Length)
                {
                    if (_ended || !_chunks.MoveNext()) { _ended = true; break; }
                    _current = _chunks.Current;
                    _currentOffset = 0;
                    if (_current.Length == 0) continue;
                }
                int count = Math.Min(destination.Length - written, _current.Length - _currentOffset);
                _current.Span.Slice(_currentOffset, count).CopyTo(destination.Slice(written, count));
                _currentOffset += count;
                written += count;
            }
            return written;
        }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(Read(buffer.Span));
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) _chunks.Dispose();
            base.Dispose(disposing);
        }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
