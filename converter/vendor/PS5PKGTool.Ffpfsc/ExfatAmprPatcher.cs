using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace PS5PKGTool.Ffpfsc;

public sealed record ExfatAmprRefreshResult(
    string ImagePath,
    int RecordCount,
    int IndexBytes,
    uint FirstCluster,
    int ClusterCount,
    string Sha256,
    bool Changed)
{
    public bool Created { get; init; }
    public bool ImageGrew { get; init; }
}

/// <summary>
/// Creates or refreshes the root AMPRIDX3 file in an exFAT image. Metadata changes are journaled in memory and
/// rolled back if cancellation or post-write verification fails.
/// </summary>
public static class ExfatAmprPatcher
{
    private const string IndexPath = "ampr_emu.index";
    private const string MarkerPath = "fakelib/libSceAmpr.sprx";
    private const int MaximumIndexBytes = 256 * 1024 * 1024;
    private const int MaximumIndexClusters = 4096;
    private const int DesiredSlackClusters = 16;
    private const uint FatEnd = 0xFFFFFFFF;

    public static Task<ExfatAmprRefreshResult> RefreshAsync(string imagePath,
        IProgress<FfpfscProgress>? progress = null, CancellationToken cancellationToken = default) =>
        Task.Run(() => Refresh(imagePath, progress, cancellationToken), cancellationToken);

    private static ExfatAmprRefreshResult Refresh(string imagePath, IProgress<FfpfscProgress>? progress,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(imagePath);
        string fullPath = Path.GetFullPath(imagePath);
        cancellationToken.ThrowIfCancellationRequested();
        progress?.Report(new FfpfscProgress("Building AMPR index", 0, 1));

        byte[] replacement;
        AmprIndexInfo indexInfo;
        ExistingIndex? existing;
        VolumeState state;
        using (var image = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read,
                   1024 * 1024, FileOptions.RandomAccess))
        using (var volume = new ExfatVolume(image, leaveOpen: true))
        {
            if (!volume.Entries.Any(entry => !entry.IsDirectory &&
                    entry.Path.Equals(MarkerPath, StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("The image has no fakelib/libSceAmpr.sprx AMPR marker.");
            replacement = AmprIndex.Build(volume.Entries.Where(entry => !entry.IsDirectory).Select(entry =>
                new AmprFileRecord(entry.Path, entry.Size, 0)));
            if (replacement.Length is <= 0 or > MaximumIndexBytes)
                throw new InvalidDataException("The refreshed AMPR index has an unsupported size.");
            indexInfo = AmprIndex.Inspect(replacement);
            state = VolumeState.Load(image);
            existing = state.Index;

            if (existing is not null && existing.DataLength == replacement.Length)
            {
                uint[] dataClusters = existing.DataClusters(state).ToArray();
                byte[] original = ReadClusterData(image, state, dataClusters, replacement.Length);
                if (original.AsSpan().SequenceEqual(replacement))
                    return CreateResult(fullPath, replacement, dataClusters[0], dataClusters.Length, indexInfo,
                        changed: false, created: false, imageGrew: false);

                if (!IsSequential(dataClusters))
                    throw new InvalidOperationException(
                        "The existing AMPR index uses fragmented allocation and cannot be updated safely in place.");
                var directPlan = new PatchPlan(image.Length);
                directPlan.HadIndexBefore = true;
                directPlan.Add(state.ClusterOffset(dataClusters[0]), PadToClusters(replacement,
                    dataClusters.Length, state.ClusterSize));
                volume.Dispose();
                image.Dispose();
                ApplyAndVerify(fullPath, directPlan, replacement, progress, cancellationToken);
                return CreateResult(fullPath, replacement, dataClusters[0], dataClusters.Length, indexInfo,
                    changed: true, created: false, imageGrew: false);
            }
        }

        PatchPlan plan = BuildMigrationPlan(state, replacement, existing);
        ApplyAndVerify(fullPath, plan, replacement, progress, cancellationToken);
        return CreateResult(fullPath, replacement, plan.IndexFirstCluster, plan.IndexDataClusters, indexInfo,
            changed: true, created: existing is null, imageGrew: plan.NewLength > plan.OriginalLength);
    }

    private static PatchPlan BuildMigrationPlan(VolumeState state, byte[] replacement, ExistingIndex? existing)
    {
        int neededClusters = DivideRoundUp(replacement.Length, state.ClusterSize);
        if (neededClusters is <= 0 or > MaximumIndexClusters)
            throw new InvalidDataException("The AMPR index is too large for safe exFAT tail allocation.");

        byte[] bitmap = state.BitmapData.ToArray();
        byte[] fat = state.FatData.ToArray();
        if (existing is not null)
        {
            foreach (uint cluster in existing.AllocationClusters(state))
            {
                SetBitmap(bitmap, cluster, false);
                WriteFat(fat, cluster, 0);
            }
        }

        int entryBytes = BuildFileEntrySet(IndexPath, 2, replacement.Length, state.UpcaseMap).Length;
        bool rootNeedsExtension = existing is null && state.RootInsertOffset + entryBytes + 32 > state.RootData.Length;
        int requiredClusters = checked(neededClusters + (rootNeedsExtension ? 1 : 0));
        (uint first, int count) = FindTailRun(bitmap, state.ClusterCount, requiredClusters,
            checked(requiredClusters + DesiredSlackClusters));

        uint newClusterCount = state.ClusterCount;
        long newLength = state.ImageLength;
        byte[] boot = state.BootRegions.ToArray();
        if (first == 0)
        {
            uint extra = checked((uint)(requiredClusters + DesiredSlackClusters));
            newClusterCount = checked(state.ClusterCount + extra);
            EnsureGrowthCapacity(state, newClusterCount);
            int newBitmapLength = DivideRoundUp(newClusterCount, 8);
            Array.Resize(ref bitmap, newBitmapLength);
            first = checked(state.ClusterCount + 2);
            count = checked((int)extra);
            newLength = BuildGrownBoot(state, boot, bitmap, newClusterCount);
        }

        uint rootExtensionCluster = rootNeedsExtension ? first : 0;
        uint indexFirstCluster = checked(first + (rootNeedsExtension ? 1u : 0u));
        int indexAllocationClusters = count - (rootNeedsExtension ? 1 : 0);
        if (indexAllocationClusters < neededClusters)
            throw new InvalidDataException("The selected exFAT tail allocation is shorter than the AMPR index.");

        for (int index = 0; index < count; index++) SetBitmap(bitmap, checked(first + (uint)index), true);
        if (rootNeedsExtension)
        {
            WriteFat(fat, state.RootClusters[^1], rootExtensionCluster);
            WriteFat(fat, rootExtensionCluster, FatEnd);
        }
        WriteFatChain(fat, indexFirstCluster, indexAllocationClusters);

        int newBitmapLengthFinal = DivideRoundUp(newClusterCount, 8);
        if (bitmap.Length != newBitmapLengthFinal) Array.Resize(ref bitmap, newBitmapLengthFinal);
        byte[] root = new byte[checked(state.RootData.Length + (rootNeedsExtension ? state.ClusterSize : 0))];
        state.RootData.CopyTo(root, 0);
        BinaryPrimitives.WriteUInt64LittleEndian(root.AsSpan(state.BitmapEntryOffset + 0x18, 8),
            checked((ulong)newBitmapLengthFinal));

        byte[] entrySet = BuildFileEntrySet(IndexPath, indexFirstCluster, replacement.Length, state.UpcaseMap);
        int entryOffset = existing?.RootEntryOffset ?? state.RootInsertOffset;
        entrySet.CopyTo(root, entryOffset);
        if (existing is null) root.AsSpan(entryOffset + entrySet.Length, 32).Clear();

        UpdatePercentInUse(boot, state.SectorSize, bitmap, newClusterCount);
        var plan = new PatchPlan(state.ImageLength)
        {
            NewLength = newLength,
            IndexFirstCluster = indexFirstCluster,
            IndexDataClusters = neededClusters,
            HadIndexBefore = existing is not null
        };
        plan.Add(0, boot);
        plan.Add(state.FatOffset, fat);
        AddClusterStreamPatches(plan, state, state.BitmapClusters, bitmap);

        var rootClusters = state.RootClusters.ToList();
        if (rootNeedsExtension) rootClusters.Add(rootExtensionCluster);
        AddClusterStreamPatches(plan, state, rootClusters, root);
        plan.Add(state.ClusterOffset(indexFirstCluster), PadToClusters(replacement, neededClusters, state.ClusterSize));
        return plan;
    }

    private static void ApplyAndVerify(string path, PatchPlan plan, byte[] expected,
        IProgress<FfpfscProgress>? progress, CancellationToken cancellationToken)
    {
        try
        {
            plan.Apply(path, progress, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            VerifyIndex(path, expected);
        }
        catch (Exception writeError)
        {
            try
            {
                plan.Rollback(path);
                plan.VerifyRestored(path);
                VerifyRollback(path, plan.HadIndexBefore);
            }
            catch (Exception rollbackError)
            {
                throw new IOException("AMPR update failed and the original exFAT image could not be restored.",
                    new AggregateException(writeError, rollbackError));
            }
            if (writeError is OperationCanceledException) throw;
            throw new IOException("AMPR update verification failed; the original exFAT image was restored.", writeError);
        }
    }

    private static void VerifyIndex(string imagePath, byte[] expected)
    {
        using var image = new FileStream(imagePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite,
            1024 * 1024, FileOptions.RandomAccess);
        using var volume = new ExfatVolume(image, leaveOpen: true);
        byte[] actual = volume.ReadAllBytes(IndexPath, MaximumIndexBytes);
        if (!actual.AsSpan().SequenceEqual(expected))
            throw new InvalidDataException("The AMPR index differs after writing.");
        _ = AmprIndex.Inspect(actual);
    }

    private static void VerifyRollback(string imagePath, bool hadIndex)
    {
        using var image = File.OpenRead(imagePath);
        using var volume = new ExfatVolume(image);
        if ((volume.Find(IndexPath) is not null) != hadIndex)
            throw new InvalidDataException("The original AMPR directory entry was not restored.");
    }

    private static ExfatAmprRefreshResult CreateResult(string path, byte[] index, uint firstCluster,
        int clusterCount, AmprIndexInfo info, bool changed, bool created, bool imageGrew) =>
        new(path, info.RecordCount, index.Length, firstCluster, clusterCount,
            Convert.ToHexString(SHA256.HashData(index)).ToLowerInvariant(), changed)
        {
            Created = created,
            ImageGrew = imageGrew
        };

    private static byte[] ReadClusterData(Stream image, VolumeState state, IReadOnlyList<uint> clusters, int length)
    {
        byte[] result = new byte[length];
        int copied = 0;
        foreach (uint cluster in clusters)
        {
            int count = Math.Min(state.ClusterSize, length - copied);
            if (count <= 0) break;
            image.Position = state.ClusterOffset(cluster);
            image.ReadExactly(result.AsSpan(copied, count));
            copied += count;
        }
        if (copied != length) throw new EndOfStreamException("The AMPR allocation is shorter than its data length.");
        return result;
    }

    private static void AddClusterStreamPatches(PatchPlan plan, VolumeState state,
        IReadOnlyList<uint> clusters, byte[] data)
    {
        int copied = 0;
        foreach (uint cluster in clusters)
        {
            if (copied >= data.Length) break;
            int count = Math.Min(state.ClusterSize, data.Length - copied);
            plan.Add(state.ClusterOffset(cluster), data.AsSpan(copied, count).ToArray());
            copied += count;
        }
        if (copied != data.Length) throw new InvalidDataException("An exFAT metadata stream exceeds its allocation.");
    }

    private static byte[] PadToClusters(byte[] data, int clusterCount, int clusterSize)
    {
        byte[] result = new byte[checked(clusterCount * clusterSize)];
        data.CopyTo(result, 0);
        return result;
    }

    private static (uint First, int Count) FindTailRun(byte[] bitmap, uint clusterCount, int needed, int desired)
    {
        uint selected = 0;
        int selectedCount = 0;
        uint cluster = 2;
        uint end = checked(clusterCount + 2);
        while (cluster < end)
        {
            while (cluster < end && GetBitmap(bitmap, cluster)) cluster++;
            uint first = cluster;
            while (cluster < end && !GetBitmap(bitmap, cluster)) cluster++;
            int count = checked((int)(cluster - first));
            if (count >= needed)
            {
                selected = first;
                selectedCount = Math.Min(count, desired);
            }
        }
        return (selected, selectedCount);
    }

    private static void EnsureGrowthCapacity(VolumeState state, uint newClusterCount)
    {
        long fatCapacity = state.FatData.LongLength / 4 - 2;
        if (newClusterCount > fatCapacity)
            throw new IOException("The exFAT FAT has no spare capacity for safe tail growth.");
        long bitmapCapacity = checked((long)state.BitmapClusters.Count * state.ClusterSize * 8);
        if (newClusterCount > bitmapCapacity)
            throw new IOException("The exFAT allocation bitmap has no spare capacity for safe tail growth.");
        if (newClusterCount > 0xFFFFFF00u)
            throw new IOException("The exFAT image is too large to grow safely.");
    }

    private static long BuildGrownBoot(VolumeState state, byte[] boot, byte[] bitmap, uint newClusterCount)
    {
        long sectorsPerCluster = state.ClusterSize / state.SectorSize;
        ulong oldDataEnd = checked(state.HeapOffsetSectors + (ulong)state.ClusterCount * (ulong)sectorsPerCluster);
        ulong tailPad = state.VolumeLengthSectors > oldDataEnd ? state.VolumeLengthSectors - oldDataEnd : 0;
        if (tailPad < 24) tailPad = 24;
        ulong newDataEnd = checked(state.HeapOffsetSectors + (ulong)newClusterCount * (ulong)sectorsPerCluster);
        ulong newVolumeLength = checked(newDataEnd + tailPad);
        long newLength = checked((long)newVolumeLength * state.SectorSize);
        for (int copy = 0; copy < 2; copy++)
        {
            Span<byte> region = boot.AsSpan(copy * 12 * state.SectorSize, 12 * state.SectorSize);
            BinaryPrimitives.WriteUInt64LittleEndian(region.Slice(0x48, 8), newVolumeLength);
            BinaryPrimitives.WriteUInt32LittleEndian(region.Slice(0x5C, 4), newClusterCount);
            WriteBootChecksum(region, state.SectorSize);
        }
        return newLength;
    }

    private static void UpdatePercentInUse(byte[] boot, int sectorSize, byte[] bitmap, uint clusterCount)
    {
        long allocated = 0;
        for (uint cluster = 2; cluster < clusterCount + 2; cluster++)
            if (GetBitmap(bitmap, cluster)) allocated++;
        byte percent = clusterCount == 0 ? (byte)0 :
            checked((byte)Math.Min(100, (allocated * 100 + clusterCount - 1) / clusterCount));
        for (int copy = 0; copy < 2; copy++)
        {
            Span<byte> region = boot.AsSpan(copy * 12 * sectorSize, 12 * sectorSize);
            region[0x70] = percent;
            WriteBootChecksum(region, sectorSize);
        }
    }

    private static void WriteBootChecksum(Span<byte> region, int sectorSize)
    {
        uint checksum = 0;
        for (int index = 0; index < 11 * sectorSize; index++)
        {
            if (index is 106 or 107 or 112) continue;
            checksum = unchecked((checksum >> 1 | checksum << 31) + region[index]);
        }
        for (int index = 11 * sectorSize; index < 12 * sectorSize; index += 4)
            BinaryPrimitives.WriteUInt32LittleEndian(region.Slice(index, 4), checksum);
    }

    private static byte[] BuildFileEntrySet(string name, uint firstCluster, long size, ushort[] upcaseMap)
    {
        int nameEntries = DivideRoundUp(name.Length, 15);
        int secondaryCount = checked(1 + nameEntries);
        byte[] result = new byte[checked((secondaryCount + 1) * 32)];
        Span<byte> file = result.AsSpan(0, 32);
        file[0] = 0x85;
        file[1] = checked((byte)secondaryCount);
        BinaryPrimitives.WriteUInt16LittleEndian(file.Slice(4, 2), 0x20);
        const uint fixedTimestamp = ((2024 - 1980u) << 25) | (1u << 21) | (1u << 16);
        for (int offset = 8; offset <= 0x10; offset += 4)
            BinaryPrimitives.WriteUInt32LittleEndian(file.Slice(offset, 4), fixedTimestamp);

        Span<byte> stream = result.AsSpan(32, 32);
        stream[0] = 0xC0;
        stream[1] = 0x03;
        stream[3] = checked((byte)name.Length);
        BinaryPrimitives.WriteUInt16LittleEndian(stream.Slice(4, 2), NameHash(name, upcaseMap));
        BinaryPrimitives.WriteUInt64LittleEndian(stream.Slice(8, 8), checked((ulong)size));
        BinaryPrimitives.WriteUInt32LittleEndian(stream.Slice(0x14, 4), firstCluster);
        BinaryPrimitives.WriteUInt64LittleEndian(stream.Slice(0x18, 8), checked((ulong)size));
        byte[] nameBytes = Encoding.Unicode.GetBytes(name);
        for (int index = 0; index < nameEntries; index++)
        {
            Span<byte> target = result.AsSpan((index + 2) * 32, 32);
            target[0] = 0xC1;
            int source = index * 30;
            nameBytes.AsSpan(source, Math.Min(30, nameBytes.Length - source)).CopyTo(target.Slice(2));
        }
        BinaryPrimitives.WriteUInt16LittleEndian(file.Slice(2, 2), EntrySetChecksum(result));
        return result;
    }

    private static ushort[] BuildUpcaseMap(byte[] data)
    {
        var result = new ushort[char.MaxValue + 1];
        int source = 0;
        int codePoint = 0;
        while (source < data.Length && codePoint < result.Length)
        {
            ushort value = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(source, 2));
            source += 2;
            if (value != ushort.MaxValue)
            {
                result[codePoint++] = value;
                continue;
            }
            if (source == data.Length && codePoint == ushort.MaxValue)
            {
                result[codePoint++] = ushort.MaxValue;
                continue;
            }
            if (source + 2 > data.Length) throw new InvalidDataException("The exFAT up-case table is truncated.");
            int count = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(source, 2));
            source += 2;
            if (count <= 0 || count > result.Length - codePoint)
                throw new InvalidDataException("The exFAT up-case table has an invalid identity run.");
            for (int index = 0; index < count; index++) result[codePoint] = checked((ushort)codePoint++);
        }
        if (source != data.Length || codePoint != result.Length)
            throw new InvalidDataException("The exFAT up-case table does not cover the Unicode BMP.");
        return result;
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

    private static bool IsSequential(IReadOnlyList<uint> clusters) =>
        clusters.Count > 0 && !clusters.Skip(1).Where((cluster, index) => cluster != clusters[0] + index + 1).Any();
    private static int DivideRoundUp(long value, int divisor) =>
        value == 0 ? 0 : checked((int)((value - 1) / divisor + 1));
    private static bool GetBitmap(byte[] bitmap, uint cluster)
    {
        uint bit = checked(cluster - 2);
        return (bitmap[bit / 8] & (1 << checked((int)(bit % 8)))) != 0;
    }
    private static void SetBitmap(byte[] bitmap, uint cluster, bool allocated)
    {
        uint bit = checked(cluster - 2);
        int index = checked((int)(bit / 8));
        byte mask = checked((byte)(1 << checked((int)(bit % 8))));
        if (allocated) bitmap[index] |= mask;
        else bitmap[index] &= unchecked((byte)~mask);
    }
    private static uint ReadFat(byte[] fat, uint cluster) =>
        BinaryPrimitives.ReadUInt32LittleEndian(fat.AsSpan(checked((int)cluster * 4), 4));
    private static void WriteFat(byte[] fat, uint cluster, uint value) =>
        BinaryPrimitives.WriteUInt32LittleEndian(fat.AsSpan(checked((int)cluster * 4), 4), value);
    private static void WriteFatChain(byte[] fat, uint first, int count)
    {
        for (int index = 0; index < count; index++)
            WriteFat(fat, checked(first + (uint)index), index + 1 < count ? checked(first + (uint)index + 1) : FatEnd);
    }

    private sealed class ExistingIndex(int rootEntryOffset, long dataLength, uint firstCluster, byte streamFlags)
    {
        public int RootEntryOffset { get; } = rootEntryOffset;
        public long DataLength { get; } = dataLength;
        public uint FirstCluster { get; } = firstCluster;
        public byte StreamFlags { get; } = streamFlags;
        public IReadOnlyList<uint> DataClusters(VolumeState state) =>
            state.GetClusters(FirstCluster, DivideRoundUp(DataLength, state.ClusterSize), StreamFlags, includeFatSlack: false);
        public IReadOnlyList<uint> AllocationClusters(VolumeState state) =>
            state.GetClusters(FirstCluster, DivideRoundUp(DataLength, state.ClusterSize), StreamFlags, includeFatSlack: true);
    }

    private sealed class VolumeState
    {
        public required int SectorSize { get; init; }
        public required int ClusterSize { get; init; }
        public required uint ClusterCount { get; init; }
        public required ulong VolumeLengthSectors { get; init; }
        public required ulong HeapOffsetSectors { get; init; }
        public required long FatOffset { get; init; }
        public required long ClusterHeapOffset { get; init; }
        public required long ImageLength { get; init; }
        public required byte[] BootRegions { get; init; }
        public required byte[] FatData { get; init; }
        public required byte[] BitmapData { get; init; }
        public required IReadOnlyList<uint> BitmapClusters { get; init; }
        public required int BitmapEntryOffset { get; init; }
        public required byte[] RootData { get; init; }
        public required IReadOnlyList<uint> RootClusters { get; init; }
        public required int RootInsertOffset { get; init; }
        public required ushort[] UpcaseMap { get; init; }
        public ExistingIndex? Index { get; init; }

        public long ClusterOffset(uint cluster) => checked(ClusterHeapOffset + ((long)cluster - 2) * ClusterSize);

        public IReadOnlyList<uint> GetClusters(uint first, int minimumCount, byte flags, bool includeFatSlack)
        {
            if (first < 2 || first >= ClusterCount + 2) throw new InvalidDataException("An exFAT cluster is invalid.");
            var result = new List<uint>();
            var visited = new HashSet<uint>();
            uint cluster = first;
            bool reachedEnd = false;
            while (cluster < 0xFFFFFFF8)
            {
                if (cluster < 2 || cluster >= FatData.Length / 4 || !visited.Add(cluster)) break;
                result.Add(cluster);
                uint next = ReadFat(FatData, cluster);
                if (next >= 0xFFFFFFF8)
                {
                    reachedEnd = true;
                    break;
                }
                if (next < 2 || next >= ClusterCount + 2) break;
                cluster = next;
                if (result.Count > MaximumIndexClusters + DesiredSlackClusters && includeFatSlack) break;
            }
            if (reachedEnd && result.Count >= minimumCount && (includeFatSlack || result.Count == minimumCount))
                return includeFatSlack ? result : result.Take(minimumCount).ToArray();
            if ((flags & 0x02) != 0 && (long)first + minimumCount <= ClusterCount + 2)
                return Enumerable.Range(checked((int)first), minimumCount).Select(value => checked((uint)value)).ToArray();
            throw new InvalidDataException("An exFAT allocation chain is shorter than its declared size.");
        }

        public static VolumeState Load(FileStream image)
        {
            byte[] boot = ReadAt(image, 0, 512);
            if (!boot.AsSpan(3, 8).SequenceEqual("EXFAT   "u8))
                throw new InvalidDataException("The image is not an exFAT filesystem.");
            int sectorSize = checked(1 << boot[0x6C]);
            int clusterSize = checked(sectorSize * (1 << boot[0x6D]));
            uint fatOffsetSectors = BinaryPrimitives.ReadUInt32LittleEndian(boot.AsSpan(0x50, 4));
            uint fatLengthSectors = BinaryPrimitives.ReadUInt32LittleEndian(boot.AsSpan(0x54, 4));
            uint heapOffsetSectors = BinaryPrimitives.ReadUInt32LittleEndian(boot.AsSpan(0x58, 4));
            uint clusterCount = BinaryPrimitives.ReadUInt32LittleEndian(boot.AsSpan(0x5C, 4));
            uint rootCluster = BinaryPrimitives.ReadUInt32LittleEndian(boot.AsSpan(0x60, 4));
            ulong volumeLength = BinaryPrimitives.ReadUInt64LittleEndian(boot.AsSpan(0x48, 8));
            long fatOffset = checked((long)fatOffsetSectors * sectorSize);
            int fatBytes = checked((int)((long)fatLengthSectors * sectorSize));
            if (fatBytes > 512 * 1024 * 1024) throw new InvalidDataException("The exFAT FAT is too large to patch safely.");
            byte[] fat = ReadAt(image, fatOffset, fatBytes);
            long heapOffset = checked((long)heapOffsetSectors * sectorSize);

            IReadOnlyList<uint> rootClusters = ReadChain(fat, rootCluster, clusterCount);
            byte[] root = ReadClusters(image, heapOffset, clusterSize, rootClusters);
            int bitmapEntryOffset = -1;
            uint bitmapCluster = 0;
            long bitmapLength = 0;
            uint upcaseCluster = 0;
            long upcaseLength = 0;
            int insertOffset = root.Length;
            ExistingIndex? existing = null;
            for (int offset = 0; offset + 32 <= root.Length;)
            {
                byte type = root[offset];
                if (type == 0)
                {
                    insertOffset = offset;
                    break;
                }
                if (type == 0x81)
                {
                    bitmapEntryOffset = offset;
                    bitmapCluster = BinaryPrimitives.ReadUInt32LittleEndian(root.AsSpan(offset + 0x14, 4));
                    bitmapLength = checked((long)BinaryPrimitives.ReadUInt64LittleEndian(root.AsSpan(offset + 0x18, 8)));
                    offset += 32;
                    continue;
                }
                if (type == 0x82)
                {
                    upcaseCluster = BinaryPrimitives.ReadUInt32LittleEndian(root.AsSpan(offset + 0x14, 4));
                    upcaseLength = checked((long)BinaryPrimitives.ReadUInt64LittleEndian(root.AsSpan(offset + 0x18, 8)));
                    offset += 32;
                    continue;
                }
                if (type != 0x85)
                {
                    offset += 32;
                    continue;
                }
                int entryCount = root[offset + 1] + 1;
                if (entryCount < 3 || offset + entryCount * 32 > root.Length || root[offset + 32] != 0xC0)
                    throw new InvalidDataException("The exFAT root directory contains an invalid entry set.");
                Span<byte> stream = root.AsSpan(offset + 32, 32);
                int nameLength = stream[3];
                byte[] nameBytes = new byte[nameLength * 2];
                int copied = 0;
                for (int index = 0; copied < nameBytes.Length; index++)
                {
                    Span<byte> nameEntry = root.AsSpan(offset + (index + 2) * 32, 32);
                    if (nameEntry[0] != 0xC1) throw new InvalidDataException("An exFAT filename entry is missing.");
                    int count = Math.Min(30, nameBytes.Length - copied);
                    nameEntry.Slice(2, count).CopyTo(nameBytes.AsSpan(copied));
                    copied += count;
                }
                string name = Encoding.Unicode.GetString(nameBytes);
                if (name.Equals(IndexPath, StringComparison.OrdinalIgnoreCase))
                {
                    ushort attributes = BinaryPrimitives.ReadUInt16LittleEndian(root.AsSpan(offset + 4, 2));
                    if ((attributes & 0x10) != 0) throw new InvalidDataException("The root ampr_emu.index is a directory.");
                    long length = checked((long)BinaryPrimitives.ReadUInt64LittleEndian(stream.Slice(0x18, 8)));
                    uint first = BinaryPrimitives.ReadUInt32LittleEndian(stream.Slice(0x14, 4));
                    existing = new ExistingIndex(offset, length, first, stream[1]);
                }
                offset += entryCount * 32;
            }
            if (bitmapEntryOffset < 0 || bitmapLength <= 0 || bitmapLength > int.MaxValue)
                throw new InvalidDataException("The exFAT root allocation bitmap is missing or invalid.");
            if (upcaseCluster < 2 || upcaseLength <= 0 || upcaseLength > 1024 * 1024)
                throw new InvalidDataException("The exFAT up-case table is missing or invalid.");
            IReadOnlyList<uint> bitmapClusters = ReadChain(fat, bitmapCluster, clusterCount);
            if ((long)bitmapClusters.Count * clusterSize < bitmapLength)
                throw new InvalidDataException("The exFAT allocation bitmap chain is truncated.");
            byte[] bitmap = ReadClusterStream(image, heapOffset, clusterSize, bitmapClusters, checked((int)bitmapLength));
            IReadOnlyList<uint> upcaseClusters = ReadChain(fat, upcaseCluster, clusterCount);
            byte[] upcase = ReadClusterStream(image, heapOffset, clusterSize, upcaseClusters, checked((int)upcaseLength));
            return new VolumeState
            {
                SectorSize = sectorSize,
                ClusterSize = clusterSize,
                ClusterCount = clusterCount,
                VolumeLengthSectors = volumeLength,
                HeapOffsetSectors = heapOffsetSectors,
                FatOffset = fatOffset,
                ClusterHeapOffset = heapOffset,
                ImageLength = image.Length,
                BootRegions = ReadAt(image, 0, checked(24 * sectorSize)),
                FatData = fat,
                BitmapData = bitmap,
                BitmapClusters = bitmapClusters,
                BitmapEntryOffset = bitmapEntryOffset,
                RootData = root,
                RootClusters = rootClusters,
                RootInsertOffset = insertOffset,
                UpcaseMap = BuildUpcaseMap(upcase),
                Index = existing
            };
        }

        private static IReadOnlyList<uint> ReadChain(byte[] fat, uint first, uint clusterCount)
        {
            var result = new List<uint>();
            var visited = new HashSet<uint>();
            uint cluster = first;
            while (cluster < 0xFFFFFFF8)
            {
                if (cluster < 2 || cluster >= clusterCount + 2 || !visited.Add(cluster))
                    throw new InvalidDataException("An exFAT metadata chain is invalid or cyclic.");
                result.Add(cluster);
                cluster = ReadFat(fat, cluster);
                if (result.Count > clusterCount) throw new InvalidDataException("An exFAT metadata chain is too long.");
            }
            return result;
        }

        private static byte[] ReadClusters(Stream image, long heapOffset, int clusterSize,
            IReadOnlyList<uint> clusters) => ReadClusterStream(image, heapOffset, clusterSize, clusters,
            checked(clusters.Count * clusterSize));

        private static byte[] ReadClusterStream(Stream image, long heapOffset, int clusterSize,
            IReadOnlyList<uint> clusters, int length)
        {
            byte[] result = new byte[length];
            int copied = 0;
            foreach (uint cluster in clusters)
            {
                int count = Math.Min(clusterSize, length - copied);
                if (count <= 0) break;
                image.Position = checked(heapOffset + ((long)cluster - 2) * clusterSize);
                image.ReadExactly(result.AsSpan(copied, count));
                copied += count;
            }
            if (copied != length) throw new EndOfStreamException("An exFAT metadata stream is truncated.");
            return result;
        }
    }

    private sealed class PatchPlan(long originalLength)
    {
        private readonly List<Patch> _patches = [];
        public long OriginalLength { get; } = originalLength;
        public long NewLength { get; set; } = originalLength;
        public uint IndexFirstCluster { get; set; }
        public int IndexDataClusters { get; set; }
        public bool HadIndexBefore { get; set; }

        public void Add(long offset, byte[] data)
        {
            if (offset < 0 || data.Length == 0) throw new ArgumentOutOfRangeException(nameof(offset));
            long end = checked(offset + data.Length);
            if (_patches.Any(patch => offset < patch.Offset + patch.Data.Length && patch.Offset < end))
                throw new InvalidOperationException("The exFAT patch plan contains overlapping byte ranges.");
            _patches.Add(new Patch(offset, data));
        }

        public void Apply(string path, IProgress<FfpfscProgress>? progress, CancellationToken cancellationToken)
        {
            long total = _patches.Sum(patch => (long)patch.Data.Length);
            long written = 0;
            using var image = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read,
                1024 * 1024, FileOptions.RandomAccess);
            if (image.Length != OriginalLength) throw new IOException("The exFAT image changed before it could be updated.");
            try
            {
                if (NewLength > OriginalLength) image.SetLength(NewLength);
                foreach (Patch patch in _patches)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    int originalCount = checked((int)Math.Min(patch.Data.Length,
                        Math.Max(0, OriginalLength - patch.Offset)));
                    patch.Original = originalCount == 0 ? [] : ReadAt(image, patch.Offset, originalCount);
                    image.Position = patch.Offset;
                    image.Write(patch.Data);
                    patch.Applied = true;
                    written += patch.Data.Length;
                    progress?.Report(new FfpfscProgress("Writing AMPR index", written, total));
                    cancellationToken.ThrowIfCancellationRequested();
                }
                image.Flush(flushToDisk: true);
            }
            catch
            {
                Restore(image);
                throw;
            }
        }

        public void Rollback(string path)
        {
            using var image = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read,
                1024 * 1024, FileOptions.RandomAccess);
            Restore(image);
        }

        public void VerifyRestored(string path)
        {
            using var image = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite,
                1024 * 1024, FileOptions.RandomAccess);
            if (image.Length != OriginalLength)
                throw new InvalidDataException("The original exFAT image length was not restored.");
            foreach (Patch patch in _patches)
            {
                if (!patch.Applied || patch.Original is null || patch.Original.Length == 0) continue;
                byte[] actual = ReadAt(image, patch.Offset, patch.Original.Length);
                if (!actual.AsSpan().SequenceEqual(patch.Original))
                    throw new InvalidDataException("An original exFAT metadata range was not restored.");
            }
        }

        private void Restore(FileStream image)
        {
            foreach (Patch patch in _patches.AsEnumerable().Reverse())
            {
                if (!patch.Applied || patch.Original is null || patch.Original.Length == 0) continue;
                image.Position = patch.Offset;
                image.Write(patch.Original);
            }
            image.SetLength(OriginalLength);
            image.Flush(flushToDisk: true);
        }
    }

    private sealed class Patch(long offset, byte[] data)
    {
        public long Offset { get; } = offset;
        public byte[] Data { get; } = data;
        public byte[]? Original { get; set; }
        public bool Applied { get; set; }
    }

    private static byte[] ReadAt(Stream stream, long offset, int count)
    {
        if (offset < 0 || count < 0 || offset > stream.Length || count > stream.Length - offset)
            throw new EndOfStreamException("An exFAT patch read is outside the image.");
        byte[] result = new byte[count];
        stream.Position = offset;
        stream.ReadExactly(result);
        return result;
    }
}
