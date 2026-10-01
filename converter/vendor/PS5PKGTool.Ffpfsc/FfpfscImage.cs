using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PS5PKGTool.Ffpfsc;

/// <summary>
/// Reads, writes, and verifies unsigned PS5 PFS images containing one PFSC payload.
/// The implementation is streaming and never modifies the source image.
/// </summary>
public static class FfpfscImage
{
    private const long PfsMagic = 20130315;
    private const int PfsVersion = 2;
    private const int PfsModeCaseInsensitive = 0x8;
    private const int InodeSize = 0xA8;
    private const ushort PermissionsRx = 0x16D;
    private const ushort InodeModeDirectory = 0x4000;
    private const ushort InodeModeFile = 0x8000;
    private const uint InodeFlagCompressed = 0x1;
    private const uint InodeFlagReadOnly = 0x10;
    private const uint InodeFlagInternal = 0x20000;
    private const int DirentFile = 2;
    private const int DirentDirectory = 3;
    private const int DirentDot = 4;
    private const int DirentDotDot = 5;
    private const int PayloadInodeNumber = 3;
    private const int InodeCount = 4;

    public static async Task<FfpfscBuildResult> CreateFromImageAsync(string sourcePath, string outputPath,
        FfpfscBuildOptions? options = null, IProgress<FfpfscProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourcePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        options ??= new FfpfscBuildOptions();
        options.Validate();

        string sourceFullPath = Path.GetFullPath(sourcePath);
        string outputFullPath = Path.GetFullPath(outputPath);
        if (!File.Exists(sourceFullPath)) throw new FileNotFoundException("The source image does not exist.", sourceFullPath);
        if (string.Equals(sourceFullPath, outputFullPath, StringComparison.OrdinalIgnoreCase))
            throw new IOException("The output path must be different from the source image.");
        if (File.Exists(outputFullPath) && !options.OverwriteExisting)
            throw new IOException($"The output file already exists: {outputFullPath}");

        string innerName = ResolveInnerName(sourceFullPath, options.InnerFileName);
        long sourceLength = new FileInfo(sourceFullPath).Length;
        await using var source = new FileStream(sourceFullPath, FileMode.Open, FileAccess.Read, FileShare.Read,
            0x10000, FileOptions.Asynchronous | FileOptions.SequentialScan);
        return await CreateCoreAsync(source, sourceLength, outputFullPath, innerName, options, "Compressing",
            progress, cancellationToken).ConfigureAwait(false);
    }

    public static async Task<FfpfscBuildResult> CreateFromDirectoryAsync(string sourceDirectory, string outputPath,
        FfpfscBuildOptions? options = null, ExfatBuildOptions? exfatOptions = null,
        IProgress<FfpfscProgress>? progress = null, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceDirectory);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        options ??= new FfpfscBuildOptions();
        options.Validate();
        string sourceFullPath = Path.GetFullPath(sourceDirectory);
        string outputFullPath = Path.GetFullPath(outputPath);
        if (!Directory.Exists(sourceFullPath)) throw new DirectoryNotFoundException(sourceFullPath);
        if (File.Exists(outputFullPath) && !options.OverwriteExisting)
            throw new IOException($"The output file already exists: {outputFullPath}");
        string relativeOutput = Path.GetRelativePath(sourceFullPath, outputFullPath);
        if (!Path.IsPathRooted(relativeOutput) && relativeOutput != ".." &&
            !relativeOutput.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new IOException("Save the FFPFSC image outside the source dump directory.");

        string gameRootPath = ResolveGameRoot(sourceFullPath);
        string innerName = options.InnerFileName ?? ResolveDumpImageName(gameRootPath);
        if (innerName is "." or ".." || innerName != Path.GetFileName(innerName))
            throw new ArgumentException("The inner payload name must be a plain filename.", nameof(options));
        EnsureAsciiFileName(innerName);
        using ExfatImageSource exfat = await Task.Run(() => ExfatImage.OpenDirectory(gameRootPath, exfatOptions),
            cancellationToken).ConfigureAwait(false);
        return await CreateCoreAsync(exfat.Stream, exfat.Length, outputFullPath, innerName, options, "Packing dump",
            progress, cancellationToken).ConfigureAwait(false);
    }

    private static async Task<FfpfscBuildResult> CreateCoreAsync(Stream source, long sourceLength,
        string outputFullPath, string innerName, FfpfscBuildOptions options, string progressStage,
        IProgress<FfpfscProgress>? progress, CancellationToken cancellationToken)
    {
        string? outputDirectory = Path.GetDirectoryName(outputFullPath);
        if (!string.IsNullOrEmpty(outputDirectory)) Directory.CreateDirectory(outputDirectory);
        string tempPath = outputFullPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        int blockSize = options.PfsBlockSize;
        long timestamp = options.BuildTimestampUnixSeconds ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        byte[] fpt = BuildFlatPathTable(innerName);
        byte[] superRoot = CombineDirents(
            SerializeDirent(1, DirentFile, "flat_path_table"),
            SerializeDirent(2, DirentDirectory, "uroot"));
        byte[] userRoot = CombineDirents(
            SerializeDirent(2, DirentDot, "."),
            SerializeDirent(2, DirentDotDot, ".."),
            SerializeDirent(3, DirentFile, innerName));

        int inodeBlockCount = DivideRoundUp(InodeCount, blockSize / InodeSize);
        int superRootBlock = 1 + inodeBlockCount;
        int fptBlock = superRootBlock + 1;
        int reservedBlock = fptBlock + 1;
        int userRootBlock = reservedBlock + 1;
        int payloadBlock = userRootBlock + 1;
        long payloadOffset = checked((long)payloadBlock * blockSize);

        var inodes = new[]
        {
            new PfsInode((ushort)(InodeModeDirectory | PermissionsRx), 1,
                InodeFlagInternal | InodeFlagReadOnly, blockSize, blockSize, 1, superRootBlock, timestamp),
            new PfsInode((ushort)(InodeModeFile | PermissionsRx), 1,
                InodeFlagInternal | InodeFlagReadOnly, fpt.Length, fpt.Length, 1, fptBlock, timestamp),
            new PfsInode((ushort)(InodeModeDirectory | PermissionsRx), 3,
                InodeFlagReadOnly, blockSize, blockSize, 1, userRootBlock, timestamp),
            new PfsInode((ushort)(InodeModeFile | PermissionsRx), 1,
                InodeFlagReadOnly, 0, 0, 1, payloadBlock, timestamp)
        };

        PfscWriteResult? pfscResult = null;
        long finalBlockCount = 0;
        try
        {
            await using (var output = new FileStream(tempPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None,
                             0x10000, FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                await output.WriteAsync(BuildHeader(blockSize, options.CaseInsensitive, 0, inodeBlockCount, timestamp),
                    cancellationToken).ConfigureAwait(false);
                WriteInodeTable(output, blockSize, inodes);
                WriteAt(output, checked((long)superRootBlock * blockSize), superRoot);
                WriteAt(output, checked((long)fptBlock * blockSize), fpt);
                WriteAt(output, checked((long)userRootBlock * blockSize), userRoot);
                output.Position = payloadOffset;

                var pfscProgress = progress is null
                    ? null
                    : new Progress<PfscProgress>(value =>
                        progress.Report(new FfpfscProgress(progressStage, value.BytesProcessed, value.TotalBytes)));
                pfscResult = await PfscCodec.EncodeAsync(source, sourceLength, output, options.Compression, pfscProgress,
                    cancellationToken).ConfigureAwait(false);

                int payloadBlocks = Math.Max(1, DivideRoundUp(pfscResult.StoredLength, blockSize));
                inodes[PayloadInodeNumber] = new PfsInode((ushort)(InodeModeFile | PermissionsRx), 1,
                    InodeFlagReadOnly | InodeFlagCompressed, pfscResult.StoredLength, sourceLength,
                    payloadBlocks, payloadBlock, timestamp);
                finalBlockCount = checked(payloadBlock + payloadBlocks);
                output.Position = 0;
                await output.WriteAsync(BuildHeader(blockSize, options.CaseInsensitive, finalBlockCount,
                    inodeBlockCount, timestamp), cancellationToken).ConfigureAwait(false);
                WriteInodeTable(output, blockSize, inodes);
                output.SetLength(checked(finalBlockCount * blockSize));
                await output.FlushAsync(cancellationToken).ConfigureAwait(false);
            }

            progress?.Report(new FfpfscProgress("Verifying", sourceLength, sourceLength));
            await using (var verifyStream = File.OpenRead(tempPath))
                _ = Inspect(verifyStream);
            File.Move(tempPath, outputFullPath, options.OverwriteExisting);
        }
        catch
        {
            TryDelete(tempPath);
            throw;
        }

        return new FfpfscBuildResult
        {
            OutputPath = outputFullPath,
            InnerFileName = innerName,
            SourceLength = sourceLength,
            PfscStoredLength = pfscResult!.StoredLength,
            ContainerLength = checked(finalBlockCount * blockSize),
            PfsBlockSize = blockSize,
            PfscBlockCount = pfscResult.BlockCount,
            CompressedBlockCount = pfscResult.CompressedBlockCount
        };
    }

    public static FfpfscInfo Inspect(Stream source)
    {
        ArgumentNullException.ThrowIfNull(source);
        if (!source.CanRead || !source.CanSeek)
            throw new ArgumentException("The FFPFSC stream must be readable and seekable.", nameof(source));
        if (source.Length < 0x1000) throw new InvalidDataException("The PFS image is too small.");

        byte[] fixedHeader = ReadAt(source, 0, 0x50);
        long version = BinaryPrimitives.ReadInt64LittleEndian(fixedHeader.AsSpan(0x00, 8));
        long magic = BinaryPrimitives.ReadInt64LittleEndian(fixedHeader.AsSpan(0x08, 8));
        int mode = BinaryPrimitives.ReadUInt16LittleEndian(fixedHeader.AsSpan(0x1C, 2));
        int blockSize = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(fixedHeader.AsSpan(0x20, 4)));
        long leadingBlocks = BinaryPrimitives.ReadInt64LittleEndian(fixedHeader.AsSpan(0x28, 8));
        long inodeCount = BinaryPrimitives.ReadInt64LittleEndian(fixedHeader.AsSpan(0x30, 8));
        long blockCount = BinaryPrimitives.ReadInt64LittleEndian(fixedHeader.AsSpan(0x38, 8));
        long inodeBlockCount = BinaryPrimitives.ReadInt64LittleEndian(fixedHeader.AsSpan(0x40, 8));

        if (version != PfsVersion || magic != PfsMagic) throw new InvalidDataException("Unsupported PFS header.");
        if ((mode & ~PfsModeCaseInsensitive) != 0)
            throw new InvalidDataException("Only unsigned, unencrypted 32-bit PFS images are supported.");
        if (blockSize is < 0x1000 or > 0x100000 || (blockSize & (blockSize - 1)) != 0)
            throw new InvalidDataException("The PFS block size is invalid.");
        if (leadingBlocks != 1 || inodeCount < InodeCount || inodeCount > blockSize / InodeSize)
            throw new InvalidDataException("The PFS inode layout is unsupported.");
        if (inodeBlockCount != 1 || blockCount <= 0 || blockCount > source.Length / blockSize)
            throw new InvalidDataException("The PFS block ranges are invalid.");
        if (source.Length != checked(blockCount * blockSize))
            throw new InvalidDataException("The PFS file length does not match its block count.");

        PfsInode[] inodes = new PfsInode[InodeCount];
        for (int index = 0; index < inodes.Length; index++)
            inodes[index] = ParseInode(ReadAt(source, checked(blockSize + (long)index * InodeSize), InodeSize));
        ValidateInodeRange(inodes[0], blockCount, blockSize, "super root");
        ValidateInodeRange(inodes[1], blockCount, blockSize, "flat path table");
        ValidateInodeRange(inodes[2], blockCount, blockSize, "user root");
        ValidateInodeRange(inodes[3], blockCount, blockSize, "payload");

        IReadOnlyList<PfsDirent> superRoot = ReadDirectory(source, inodes[0], blockSize);
        RequireDirent(superRoot, 1, DirentFile, "flat_path_table");
        RequireDirent(superRoot, 2, DirentDirectory, "uroot");
        IReadOnlyList<PfsDirent> userRoot = ReadDirectory(source, inodes[2], blockSize);
        RequireDirent(userRoot, 2, DirentDot, ".");
        RequireDirent(userRoot, 2, DirentDotDot, "..");
        PfsDirent payloadEntry = userRoot.SingleOrDefault(entry => entry.Inode == PayloadInodeNumber && entry.Type == DirentFile)
            ?? throw new InvalidDataException("The PFS user root has no payload file.");

        if ((inodes[3].Flags & InodeFlagCompressed) == 0 || inodes[3].SizeCompressed < 0)
            throw new InvalidDataException("The PFS payload inode is not PFSC-compressed.");
        byte[] fpt = ReadAt(source, checked((long)inodes[1].FirstBlock * blockSize), checked((int)inodes[1].Size));
        if (fpt.Length != 8 || BinaryPrimitives.ReadUInt32LittleEndian(fpt.AsSpan(0, 4)) != HashPath('/' + payloadEntry.Name) ||
            BinaryPrimitives.ReadUInt32LittleEndian(fpt.AsSpan(4, 4)) != PayloadInodeNumber)
            throw new InvalidDataException("The PFS flat path table does not match the payload entry.");

        long payloadOffset = checked((long)inodes[3].FirstBlock * blockSize);
        PfscInfo pfsc = PfscCodec.Inspect(source, payloadOffset, inodes[3].Size);
        if (pfsc.PaddedLogicalLength < inodes[3].SizeCompressed ||
            pfsc.PaddedLogicalLength - inodes[3].SizeCompressed >= PfscCodec.LogicalBlockSize)
            throw new InvalidDataException("The PFSC logical size does not match the payload inode.");

        return new FfpfscInfo
        {
            PfsVersion = checked((int)version),
            PfsMode = mode,
            PfsBlockSize = blockSize,
            PfsBlockCount = blockCount,
            InodeCount = checked((int)inodeCount),
            InnerFileName = payloadEntry.Name,
            PayloadOffset = payloadOffset,
            StoredLength = inodes[3].Size,
            LogicalLength = inodes[3].SizeCompressed,
            Pfsc = pfsc
        };
    }

    public static async Task ExtractAsync(string ffpfscPath, string outputPath,
        IProgress<FfpfscProgress>? progress = null, CancellationToken cancellationToken = default)
    {
        string inputFullPath = Path.GetFullPath(ffpfscPath);
        string outputFullPath = Path.GetFullPath(outputPath);
        if (string.Equals(inputFullPath, outputFullPath, StringComparison.OrdinalIgnoreCase))
            throw new IOException("The extraction output must differ from the FFPFSC image.");
        if (File.Exists(outputFullPath)) throw new IOException($"The output file already exists: {outputFullPath}");
        string? directory = Path.GetDirectoryName(outputFullPath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        string tempPath = outputFullPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await using var input = File.OpenRead(inputFullPath);
            FfpfscInfo info = Inspect(input);
            await using var output = new FileStream(tempPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                0x10000, FileOptions.Asynchronous | FileOptions.SequentialScan);
            var decodeProgress = progress is null
                ? null
                : new Progress<PfscProgress>(value =>
                    progress.Report(new FfpfscProgress("Extracting", value.BytesProcessed, value.TotalBytes)));
            await PfscCodec.DecodeAsync(input, output, info.LogicalLength, info.PayloadOffset, info.StoredLength,
                decodeProgress, cancellationToken).ConfigureAwait(false);
            await output.FlushAsync(cancellationToken).ConfigureAwait(false);
            output.Close();
            File.Move(tempPath, outputFullPath);
        }
        catch
        {
            TryDelete(tempPath);
            throw;
        }
    }

    public static async Task<FfpfscVerificationResult> VerifyAsync(string ffpfscPath, string? originalSourcePath = null,
        IProgress<FfpfscProgress>? progress = null, CancellationToken cancellationToken = default)
    {
        await using var input = File.OpenRead(ffpfscPath);
        FfpfscInfo info = Inspect(input);
        using var decodedHasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        await using var hashSink = new IncrementalHashStream(decodedHasher);
        var decodeProgress = progress is null
            ? null
            : new Progress<PfscProgress>(value =>
                progress.Report(new FfpfscProgress("Verifying", value.BytesProcessed, value.TotalBytes)));
        await PfscCodec.DecodeAsync(input, hashSink, info.LogicalLength, info.PayloadOffset, info.StoredLength,
            decodeProgress, cancellationToken).ConfigureAwait(false);
        string decodedHash = Convert.ToHexString(decodedHasher.GetHashAndReset());

        string? sourceHash = null;
        bool? matches = null;
        if (originalSourcePath is not null)
        {
            await using var original = File.OpenRead(originalSourcePath);
            byte[] hash = await SHA256.HashDataAsync(original, cancellationToken).ConfigureAwait(false);
            sourceHash = Convert.ToHexString(hash);
            matches = original.Length == info.LogicalLength && sourceHash == decodedHash;
        }

        return new FfpfscVerificationResult
        {
            Info = info,
            StructureValid = true,
            EveryPfscBlockDecodes = true,
            SourceMatches = matches,
            SourceSha256 = sourceHash,
            DecodedSha256 = decodedHash
        };
    }

    /// <summary>
    /// Non-throwing verification that reports structural validity and PFSC decode success independently.
    /// </summary>
    public static async Task<FfpfscVerificationResult> TryVerifyAsync(string ffpfscPath,
        string? originalSourcePath = null, IProgress<FfpfscProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        FfpfscInfo info;
        try
        {
            await using var input = File.OpenRead(ffpfscPath);
            info = Inspect(input);
        }
        catch (Exception ex) when (ex is InvalidDataException or EndOfStreamException or IOException or ArgumentException)
        {
            return new FfpfscVerificationResult
            {
                Info = null,
                StructureValid = false,
                EveryPfscBlockDecodes = false,
                Error = ex.Message
            };
        }

        try
        {
            return await VerifyAsync(ffpfscPath, originalSourcePath, progress, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is InvalidDataException or EndOfStreamException or IOException or ArgumentException)
        {
            return new FfpfscVerificationResult
            {
                Info = info,
                StructureValid = true,
                EveryPfscBlockDecodes = false,
                Error = ex.Message
            };
        }
    }

    private const int MaximumUnwrapDepth = 4;

    /// <summary>
    /// Extracts the full inner tree (exFAT or UFS2), unwrapping nested PFS containers.
    /// Returns the number of files written.
    /// </summary>
    public static async Task<int> ExtractToDirectoryAsync(string ffpfscPath, string outputDirectory,
        bool overwrite = false, IProgress<FfpfscProgress>? progress = null, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(ffpfscPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputDirectory);
        string outputFullPath = Path.GetFullPath(outputDirectory);
        Directory.CreateDirectory(outputFullPath);
        using FfpfscVolume volume = FfpfscVolume.Open(ffpfscPath);
        return await ExtractVolumeToDirectoryAsync(volume, outputFullPath, overwrite, progress, cancellationToken, 0)
            .ConfigureAwait(false);
    }

    private static async Task<int> ExtractVolumeToDirectoryAsync(FfpfscVolume volume, string root, bool overwrite,
        IProgress<FfpfscProgress>? progress, CancellationToken cancellationToken, int depth)
    {
        if (volume.InnerFilesystemKind == FfpfscInnerFilesystemKind.Pfs)
        {
            if (depth >= MaximumUnwrapDepth)
                throw new InvalidDataException("The FFPFSC image nests more than four container layers.");
            using FfpfscVolume nested = FfpfscVolume.Open(volume.PayloadStream,
                volume.Path + "!" + volume.Info.InnerFileName, leaveOpen: true);
            return await ExtractVolumeToDirectoryAsync(nested, root, overwrite, progress, cancellationToken,
                depth + 1).ConfigureAwait(false);
        }

        long total = 0;
        foreach (FfpfscVolumeEntry entry in volume.Entries)
            if (!entry.IsDirectory) total += Math.Max(0, entry.Size);

        long written = 0;
        int count = 0;
        foreach (FfpfscVolumeEntry entry in volume.Entries)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string relative = entry.Path.Replace('/', Path.DirectorySeparatorChar);
            string target = Path.GetFullPath(Path.Combine(root, relative));
            if (!string.Equals(target, root, StringComparison.OrdinalIgnoreCase) &&
                !target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException($"The inner path escapes the output folder: {entry.Path}");

            if (entry.IsDirectory)
            {
                Directory.CreateDirectory(target);
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if (File.Exists(target) && !overwrite)
                throw new IOException($"The output file already exists: {target}");
            await using (Stream input = volume.OpenFile(entry.Path))
            await using (var output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None,
                             0x10000, FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                await input.CopyToAsync(output, 0x10000, cancellationToken).ConfigureAwait(false);
                await output.FlushAsync(cancellationToken).ConfigureAwait(false);
            }
            written += Math.Max(0, entry.Size);
            count++;
            progress?.Report(new FfpfscProgress("Extracting", written, total));
        }
        return count;
    }

    private static byte[] BuildHeader(int blockSize, bool caseInsensitive, long finalBlockCount,
        int inodeBlockCount, long timestamp)
    {
        byte[] header = new byte[blockSize];
        BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(0x00, 8), PfsVersion);
        BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(0x08, 8), PfsMagic);
        header[0x1A] = 1;
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(0x1C, 2),
            checked((ushort)(caseInsensitive ? PfsModeCaseInsensitive : 0)));
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(0x20, 4), checked((uint)blockSize));
        BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(0x28, 8), 1);
        BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(0x30, 8), InodeCount);
        BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(0x38, 8), finalBlockCount);
        BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(0x40, 8), inodeBlockCount);

        Span<byte> signatureInode = header.AsSpan(0x50, 0x310);
        BinaryPrimitives.WriteUInt16LittleEndian(signatureInode.Slice(0x02, 2), 1);
        BinaryPrimitives.WriteUInt32LittleEndian(signatureInode.Slice(0x04, 4), InodeFlagReadOnly);
        long inodeBytes = checked((long)inodeBlockCount * blockSize);
        BinaryPrimitives.WriteInt64LittleEndian(signatureInode.Slice(0x08, 8), inodeBytes);
        BinaryPrimitives.WriteInt64LittleEndian(signatureInode.Slice(0x10, 8), inodeBytes);
        for (int index = 0; index < 4; index++)
            BinaryPrimitives.WriteInt64LittleEndian(signatureInode.Slice(0x18 + index * 8, 8), timestamp);
        BinaryPrimitives.WriteUInt32LittleEndian(signatureInode.Slice(0x60, 4), checked((uint)inodeBlockCount));
        BinaryPrimitives.WriteInt64LittleEndian(signatureInode.Slice(0x88, 8), 1);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(0x368, 4), 1);
        return header;
    }

    private static void WriteInodeTable(Stream output, int blockSize, IReadOnlyList<PfsInode> inodes)
    {
        output.Position = blockSize;
        for (int index = 0; index < inodes.Count; index++)
            output.Write(SerializeInode(inodes[index], index == 0));
    }

    private static byte[] SerializeInode(PfsInode inode, bool superRoot)
    {
        byte[] data = new byte[InodeSize];
        BinaryPrimitives.WriteUInt16LittleEndian(data.AsSpan(0x00, 2), inode.Mode);
        BinaryPrimitives.WriteUInt16LittleEndian(data.AsSpan(0x02, 2), inode.LinkCount);
        BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(0x04, 4), inode.Flags);
        BinaryPrimitives.WriteInt64LittleEndian(data.AsSpan(0x08, 8), inode.Size);
        BinaryPrimitives.WriteInt64LittleEndian(data.AsSpan(0x10, 8), inode.SizeCompressed);
        for (int index = 0; index < 4; index++)
            BinaryPrimitives.WriteInt64LittleEndian(data.AsSpan(0x18 + index * 8, 8), inode.Timestamp);
        BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(0x60, 4), checked((uint)inode.Blocks));
        for (int index = 0; index < 12; index++)
            BinaryPrimitives.WriteInt32LittleEndian(data.AsSpan(0x64 + index * 4, 4),
                index == 0 ? inode.FirstBlock : superRoot ? 0 : -1);
        return data;
    }

    private static PfsInode ParseInode(byte[] data) => new(
        BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(0x00, 2)),
        BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(0x02, 2)),
        BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(0x04, 4)),
        BinaryPrimitives.ReadInt64LittleEndian(data.AsSpan(0x08, 8)),
        BinaryPrimitives.ReadInt64LittleEndian(data.AsSpan(0x10, 8)),
        checked((int)BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(0x60, 4))),
        BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(0x64, 4)),
        BinaryPrimitives.ReadInt64LittleEndian(data.AsSpan(0x18, 8)));

    private static void ValidateInodeRange(PfsInode inode, long totalBlocks, int blockSize, string label)
    {
        if (inode.Size < 0 || inode.SizeCompressed < 0 || inode.Blocks <= 0 || inode.FirstBlock <= 0 ||
            inode.FirstBlock >= totalBlocks || inode.Blocks > totalBlocks - inode.FirstBlock ||
            inode.Size > checked((long)inode.Blocks * blockSize))
            throw new InvalidDataException($"The PFS {label} inode has an invalid range.");
    }

    private static IReadOnlyList<PfsDirent> ReadDirectory(Stream source, PfsInode inode, int blockSize)
    {
        int length = checked((int)Math.Min(inode.Size, checked((long)inode.Blocks * blockSize)));
        byte[] data = ReadAt(source, checked((long)inode.FirstBlock * blockSize), length);
        var result = new List<PfsDirent>();
        int offset = 0;
        while (offset + 16 <= data.Length)
        {
            uint ino = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(offset, 4));
            int type = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 4, 4));
            int nameLength = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 8, 4));
            int entrySize = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 12, 4));
            if (ino == 0 && type == 0 && nameLength == 0 && entrySize == 0) break;
            if (nameLength < 0 || entrySize < 16 || (entrySize & 7) != 0 || nameLength > entrySize - 16 ||
                entrySize > data.Length - offset)
                throw new InvalidDataException("A PFS directory entry is malformed.");
            string name;
            try { name = Encoding.ASCII.GetString(data, offset + 16, nameLength); }
            catch (DecoderFallbackException ex) { throw new InvalidDataException("A PFS filename is not ASCII.", ex); }
            result.Add(new PfsDirent(ino, type, name));
            offset += entrySize;
        }
        return result;
    }

    private static void RequireDirent(IEnumerable<PfsDirent> entries, uint inode, int type, string name)
    {
        if (!entries.Any(entry => entry.Inode == inode && entry.Type == type && entry.Name == name))
            throw new InvalidDataException($"The PFS directory entry '{name}' is missing.");
    }

    private static byte[] SerializeDirent(uint inode, int type, string name)
    {
        EnsureAsciiFileName(name);
        byte[] nameBytes = Encoding.ASCII.GetBytes(name);
        int entrySize = Align(nameBytes.Length + 17, 8);
        byte[] result = new byte[entrySize];
        BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(0, 4), inode);
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(4, 4), type);
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(8, 4), nameBytes.Length);
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(12, 4), entrySize);
        nameBytes.CopyTo(result, 16);
        return result;
    }

    private static byte[] BuildFlatPathTable(string innerName)
    {
        byte[] result = new byte[8];
        BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(0, 4), HashPath('/' + innerName));
        BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(4, 4), PayloadInodeNumber);
        return result;
    }

    private static uint HashPath(string path)
    {
        uint hash = 0;
        foreach (char value in path)
        {
            char folded = char.ToUpperInvariant(value);
            hash = unchecked(folded + 31u * hash);
        }
        return hash;
    }

    private static string ResolveInnerName(string sourcePath, string? requestedName)
    {
        string name = requestedName ?? Path.GetFileName(sourcePath);
        if (string.IsNullOrWhiteSpace(name) || name is "." or ".." || name != Path.GetFileName(name))
            throw new ArgumentException("The inner payload name must be a plain filename.", nameof(requestedName));
        EnsureAsciiFileName(name);
        return name;
    }

    private static string ResolveDumpImageName(string sourceDirectory)
    {
        string parameterPath = Path.Combine(sourceDirectory, "sce_sys", "param.json");
        if (File.Exists(parameterPath))
        {
            try
            {
                using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(parameterPath));
                if (document.RootElement.ValueKind == JsonValueKind.Object)
                {
                    foreach (JsonProperty property in document.RootElement.EnumerateObject())
                    {
                        if (!property.Name.Equals("titleId", StringComparison.OrdinalIgnoreCase) ||
                            property.Value.ValueKind != JsonValueKind.String) continue;
                        string? value = property.Value.GetString();
                        if (value is not null && Regex.IsMatch(value, "^[A-Za-z]{4}[0-9]{5}$"))
                            return value.ToUpperInvariant() + ".exfat";
                    }
                }
            }
            catch (JsonException) { }
            catch (IOException) { }
        }

        string folderName = new DirectoryInfo(sourceDirectory).Name;
        string asciiName = new(folderName.Select(value => value is >= ' ' and <= '~' &&
            value is not '"' and not '*' and not '/' and not ':' and not '<' and not '>' and not '?' and not '\\' and not '|'
                ? value
                : '_').ToArray());
        asciiName = asciiName.Trim(' ', '.');
        return (asciiName.Length == 0 ? "PS5_GAME" : asciiName) + ".exfat";
    }

    private static string ResolveGameRoot(string sourceDirectory)
    {
        if (File.Exists(Path.Combine(sourceDirectory, "sce_sys", "param.json"))) return sourceDirectory;

        var candidates = new List<string>();
        var pending = new Stack<DirectoryInfo>();
        pending.Push(new DirectoryInfo(sourceDirectory));
        while (pending.Count > 0)
        {
            DirectoryInfo current = pending.Pop();
            DirectoryInfo[] children;
            try
            {
                children = current.EnumerateDirectories()
                    .Where(directory => (directory.Attributes & FileAttributes.ReparsePoint) == 0)
                    .OrderByDescending(directory => directory.Name, StringComparer.OrdinalIgnoreCase)
                    .ToArray();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                throw new IOException($"Unable to inspect the selected dump folder: {current.FullName}", ex);
            }

            foreach (DirectoryInfo child in children)
            {
                if (child.Name.Equals("sce_sys", StringComparison.OrdinalIgnoreCase) &&
                    File.Exists(Path.Combine(child.FullName, "param.json")))
                {
                    string candidate = current.FullName;
                    if (!candidates.Contains(candidate, StringComparer.OrdinalIgnoreCase)) candidates.Add(candidate);
                    if (candidates.Count > 1)
                    {
                        string display = string.Join(Environment.NewLine,
                            candidates.Select(path => "  " + Path.GetRelativePath(sourceDirectory, path)));
                        throw new InvalidDataException(
                            $"Multiple PS5 game roots were found in the selected folder. Select one game folder directly:{Environment.NewLine}{display}");
                    }
                    continue;
                }
                pending.Push(child);
            }
        }

        return candidates.Count == 1 ? candidates[0] : sourceDirectory;
    }

    private static void EnsureAsciiFileName(string name)
    {
        if (name.Any(value => value > 0x7F || value == '\0'))
            throw new ArgumentException($"PFS filenames must contain ASCII characters only: {name}");
    }

    private static byte[] CombineDirents(params byte[][] entries)
    {
        int length = entries.Sum(entry => entry.Length);
        byte[] result = new byte[length];
        int offset = 0;
        foreach (byte[] entry in entries)
        {
            entry.CopyTo(result, offset);
            offset += entry.Length;
        }
        return result;
    }

    private static void WriteAt(Stream stream, long offset, byte[] data)
    {
        stream.Position = offset;
        stream.Write(data);
    }

    private static byte[] ReadAt(Stream stream, long offset, int count)
    {
        if (offset < 0 || count < 0 || offset > stream.Length || count > stream.Length - offset)
            throw new InvalidDataException("A PFS read range is outside the image.");
        byte[] result = new byte[count];
        stream.Position = offset;
        stream.ReadExactly(result);
        return result;
    }

    private static int DivideRoundUp(long value, int divisor) => value == 0 ? 0 : checked((int)((value - 1) / divisor + 1));
    private static int Align(int value, int alignment) => checked((value + alignment - 1) / alignment * alignment);

    private static void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private sealed record PfsInode(ushort Mode, ushort LinkCount, uint Flags, long Size, long SizeCompressed,
        int Blocks, int FirstBlock, long Timestamp);
    private sealed record PfsDirent(uint Inode, int Type, string Name);

    private sealed class IncrementalHashStream(IncrementalHash hash) : Stream
    {
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public override void Write(byte[] buffer, int offset, int count) => hash.AppendData(buffer, offset, count);
        public override void Write(ReadOnlySpan<byte> buffer) => hash.AppendData(buffer);
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            hash.AppendData(buffer.Span);
            return ValueTask.CompletedTask;
        }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
