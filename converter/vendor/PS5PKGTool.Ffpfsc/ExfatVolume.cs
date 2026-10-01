using System.Buffers.Binary;
using System.Text;

namespace PS5PKGTool.Ffpfsc;

public sealed class ExfatEntry
{
    internal ExfatEntry(string path, string name, bool isDirectory, long size, uint firstCluster,
        bool contiguous, ushort attributes)
    {
        Path = path;
        Name = name;
        IsDirectory = isDirectory;
        Size = size;
        FirstCluster = firstCluster;
        IsContiguous = contiguous;
        Attributes = attributes;
    }

    public string Path { get; }
    public string Name { get; }
    public bool IsDirectory { get; }
    public long Size { get; }
    public uint FirstCluster { get; }
    public bool IsContiguous { get; }
    public ushort Attributes { get; }
}

/// <summary>Minimal read-only exFAT filesystem used by PS5 FFPFSC images.</summary>
public sealed class ExfatVolume : IDisposable
{
    private const uint FatEndMinimum = 0xFFFFFFF8;
    private const int MaximumEntries = 2_000_000;
    private const int MaximumDepth = 256;
    private readonly Stream _image;
    private readonly bool _leaveOpen;
    private readonly object _sync = new();
    private readonly uint[] _fat;
    private readonly Dictionary<string, ExfatEntry> _byPath = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<ExfatEntry> _entries = [];
    private bool _disposed;

    public ExfatVolume(Stream image, bool leaveOpen = false)
    {
        ArgumentNullException.ThrowIfNull(image);
        if (!image.CanRead || !image.CanSeek)
            throw new ArgumentException("The exFAT image must be readable and seekable.", nameof(image));
        _image = image;
        _leaveOpen = leaveOpen;

        byte[] boot = ReadAt(0, 512);
        if (!boot.AsSpan(3, 8).SequenceEqual("EXFAT   "u8) ||
            BinaryPrimitives.ReadUInt16LittleEndian(boot.AsSpan(0x1FE, 2)) != 0xAA55)
            throw new InvalidDataException("The image is not a supported exFAT filesystem.");
        int sectorShift = boot[0x6C];
        int clusterShift = boot[0x6D];
        if (sectorShift is < 9 or > 12 || clusterShift > 25)
            throw new InvalidDataException("The exFAT sector or cluster shift is invalid.");
        SectorSize = checked(1 << sectorShift);
        SectorsPerCluster = checked(1 << clusterShift);
        ClusterSize = checked(SectorSize * SectorsPerCluster);
        uint fatOffsetSectors = BinaryPrimitives.ReadUInt32LittleEndian(boot.AsSpan(0x50, 4));
        uint fatLengthSectors = BinaryPrimitives.ReadUInt32LittleEndian(boot.AsSpan(0x54, 4));
        uint heapOffsetSectors = BinaryPrimitives.ReadUInt32LittleEndian(boot.AsSpan(0x58, 4));
        ClusterCount = BinaryPrimitives.ReadUInt32LittleEndian(boot.AsSpan(0x5C, 4));
        RootCluster = BinaryPrimitives.ReadUInt32LittleEndian(boot.AsSpan(0x60, 4));
        FatOffset = checked((long)fatOffsetSectors * SectorSize);
        ClusterHeapOffset = checked((long)heapOffsetSectors * SectorSize);
        long fatBytes = checked((long)fatLengthSectors * SectorSize);
        if (ClusterCount == 0 || RootCluster < 2 || RootCluster >= ClusterCount + 2 ||
            fatBytes < checked((long)(ClusterCount + 2) * 4) || ClusterHeapOffset >= image.Length)
            throw new InvalidDataException("The exFAT volume geometry is invalid.");
        byte[] fatData = ReadAt(FatOffset, checked((int)((ClusterCount + 2) * 4L)));
        _fat = new uint[ClusterCount + 2];
        for (int index = 0; index < _fat.Length; index++)
            _fat[index] = BinaryPrimitives.ReadUInt32LittleEndian(fatData.AsSpan(index * 4, 4));

        var visitedDirectories = new HashSet<uint>();
        ReadDirectory(string.Empty, RootCluster, null, false, visitedDirectories, 0);
    }

    public int SectorSize { get; }
    public int SectorsPerCluster { get; }
    public int ClusterSize { get; }
    public uint ClusterCount { get; }
    public uint RootCluster { get; }
    public long FatOffset { get; }
    public long ClusterHeapOffset { get; }
    public IReadOnlyList<ExfatEntry> Entries => _entries;

    public ExfatEntry? Find(string path)
    {
        ThrowIfDisposed();
        _byPath.TryGetValue(NormalizePath(path), out ExfatEntry? entry);
        return entry;
    }

    public Stream OpenFile(string path)
    {
        ExfatEntry entry = Find(path) ?? throw new FileNotFoundException("The file was not found in the exFAT image.", path);
        if (entry.IsDirectory) throw new IOException("The requested exFAT entry is a directory.");
        return OpenEntry(entry);
    }

    public byte[] ReadAllBytes(string path, int maximumBytes = 256 * 1024 * 1024)
    {
        ExfatEntry entry = Find(path) ?? throw new FileNotFoundException("The file was not found in the exFAT image.", path);
        if (entry.IsDirectory) throw new IOException("The requested exFAT entry is a directory.");
        if (entry.Size > maximumBytes || entry.Size > int.MaxValue)
            throw new IOException($"The exFAT file is too large to load into memory: {entry.Path}");
        using Stream input = OpenEntry(entry);
        byte[] data = new byte[checked((int)entry.Size)];
        input.ReadExactly(data);
        return data;
    }

    public string ReadAllText(string path, Encoding? encoding = null, int maximumBytes = 16 * 1024 * 1024) =>
        (encoding ?? new UTF8Encoding(false, true)).GetString(ReadAllBytes(path, maximumBytes));

    public IReadOnlyList<uint> GetFileClusters(string path)
    {
        ExfatEntry entry = Find(path) ?? throw new FileNotFoundException("The file was not found in the exFAT image.", path);
        if (entry.IsDirectory) throw new IOException("The requested exFAT entry is a directory.");
        if (entry.Size == 0) return [];
        return GetClusters(entry.FirstCluster, entry.Size, entry.IsContiguous);
    }

    private Stream OpenEntry(ExfatEntry entry)
    {
        if (entry.Size == 0) return new MemoryStream(Array.Empty<byte>(), writable: false);
        uint[] clusters = GetClusters(entry.FirstCluster, entry.Size, entry.IsContiguous);
        return new ExfatFileStream(_image, _sync, clusters, ClusterHeapOffset, ClusterSize, entry.Size);
    }

    private void ReadDirectory(string parentPath, uint firstCluster, long? dataLength, bool contiguous,
        HashSet<uint> visitedDirectories, int depth)
    {
        if (depth > MaximumDepth) throw new InvalidDataException("The exFAT directory depth exceeds the safety limit.");
        if (!visitedDirectories.Add(firstCluster)) throw new InvalidDataException("The exFAT directory graph contains a cycle.");
        long length = dataLength ?? checked((long)GetClusters(firstCluster, null, false).Length * ClusterSize);
        if (length > 512L * 1024 * 1024) throw new InvalidDataException("An exFAT directory is unreasonably large.");
        var pseudo = new ExfatEntry(parentPath, Path.GetFileName(parentPath), true, length, firstCluster, contiguous, 0x10);
        using Stream directory = OpenEntry(pseudo);
        byte[] data = new byte[checked((int)length)];
        directory.ReadExactly(data);

        for (int offset = 0; offset + 32 <= data.Length;)
        {
            byte type = data[offset];
            if (type == 0) break;
            if (type != 0x85) { offset += 32; continue; }
            int secondaryCount = data[offset + 1];
            int setLength = checked((secondaryCount + 1) * 32);
            if (secondaryCount < 2 || offset + setLength > data.Length)
                throw new InvalidDataException("An exFAT file entry set is truncated.");
            ReadOnlySpan<byte> primary = data.AsSpan(offset, 32);
            ReadOnlySpan<byte> stream = data.AsSpan(offset + 32, 32);
            if (stream[0] != 0xC0) throw new InvalidDataException("An exFAT file entry has no stream extension.");
            int nameLength = stream[3];
            int requiredNames = (nameLength + 14) / 15;
            if (requiredNames > secondaryCount - 1)
                throw new InvalidDataException("An exFAT filename entry set is incomplete.");
            byte[] nameBytes = new byte[nameLength * 2];
            int copied = 0;
            for (int index = 0; index < requiredNames; index++)
            {
                ReadOnlySpan<byte> nameEntry = data.AsSpan(offset + (index + 2) * 32, 32);
                if (nameEntry[0] != 0xC1) throw new InvalidDataException("An exFAT filename extension is missing.");
                int count = Math.Min(30, nameBytes.Length - copied);
                nameEntry.Slice(2, count).CopyTo(nameBytes.AsSpan(copied));
                copied += count;
            }
            string name = Encoding.Unicode.GetString(nameBytes);
            ValidateName(name);
            ushort attributes = BinaryPrimitives.ReadUInt16LittleEndian(primary.Slice(4, 2));
            bool isDirectory = (attributes & 0x10) != 0;
            bool noFatChain = (stream[1] & 0x02) != 0;
            uint childCluster = BinaryPrimitives.ReadUInt32LittleEndian(stream.Slice(0x14, 4));
            ulong sizeValue = BinaryPrimitives.ReadUInt64LittleEndian(stream.Slice(0x18, 8));
            if (sizeValue > long.MaxValue) throw new InvalidDataException("An exFAT entry is too large.");
            long size = (long)sizeValue;
            string path = parentPath.Length == 0 ? name : parentPath + '/' + name;
            var entry = new ExfatEntry(path, name, isDirectory, size, childCluster, noFatChain, attributes);
            if (!_byPath.TryAdd(path, entry)) throw new InvalidDataException($"Duplicate exFAT path: {path}");
            _entries.Add(entry);
            if (_entries.Count > MaximumEntries) throw new InvalidDataException("The exFAT entry count exceeds the safety limit.");
            if (isDirectory && childCluster >= 2)
                ReadDirectory(path, childCluster, size, noFatChain, visitedDirectories, depth + 1);
            offset += setLength;
        }
    }

    private uint[] GetClusters(uint firstCluster, long? dataLength, bool contiguous)
    {
        if (firstCluster < 2 || firstCluster >= _fat.Length)
            throw new InvalidDataException("An exFAT entry has an invalid first cluster.");
        int expected = dataLength.HasValue ? checked((int)((dataLength.Value + ClusterSize - 1) / ClusterSize)) : -1;
        if (expected == 0) return [];
        if (contiguous && expected >= 0)
        {
            if ((long)firstCluster + expected > _fat.Length)
                throw new InvalidDataException("A contiguous exFAT extent leaves the cluster heap.");
            return Enumerable.Range(checked((int)firstCluster), expected).Select(value => checked((uint)value)).ToArray();
        }
        var result = new List<uint>(expected > 0 ? expected : 4);
        var visited = new HashSet<uint>();
        uint cluster = firstCluster;
        while (cluster < FatEndMinimum)
        {
            if (cluster < 2 || cluster >= _fat.Length || !visited.Add(cluster))
                throw new InvalidDataException("An exFAT FAT chain is invalid or cyclic.");
            result.Add(cluster);
            if (expected >= 0 && result.Count == expected) break;
            cluster = _fat[cluster];
            if (result.Count > ClusterCount) throw new InvalidDataException("An exFAT FAT chain is unreasonably long.");
        }
        if (expected >= 0 && result.Count != expected)
            throw new InvalidDataException("An exFAT FAT chain is shorter than its declared data length.");
        return result.ToArray();
    }

    private byte[] ReadAt(long offset, int count)
    {
        if (offset < 0 || count < 0 || offset > _image.Length || count > _image.Length - offset)
            throw new InvalidDataException("An exFAT read is outside the decoded image.");
        byte[] data = new byte[count];
        lock (_sync)
        {
            _image.Position = offset;
            _image.ReadExactly(data);
        }
        return data;
    }

    private static string NormalizePath(string path) => path.Replace('\\', '/').Trim('/');
    private static void ValidateName(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name is "." or ".." || name.Contains('/') || name.Contains('\\'))
            throw new InvalidDataException("An exFAT entry contains an unsafe filename.");
    }
    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);
    public void Dispose()
    {
        if (_disposed) return;
        if (!_leaveOpen) _image.Dispose();
        _disposed = true;
    }

    private sealed class ExfatFileStream(Stream image, object sync, uint[] clusters, long heapOffset,
        int clusterSize, long length) : Stream
    {
        private long _position;
        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => length;
        public override long Position
        {
            get => _position;
            set
            {
                if (value < 0 || value > length) throw new ArgumentOutOfRangeException(nameof(value));
                _position = value;
            }
        }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> destination)
        {
            int total = checked((int)Math.Min(destination.Length, length - _position));
            int written = 0;
            lock (sync)
            {
                while (written < total)
                {
                    int clusterIndex = checked((int)(_position / clusterSize));
                    int inCluster = checked((int)(_position % clusterSize));
                    int count = Math.Min(total - written, clusterSize - inCluster);
                    long imageOffset = checked(heapOffset + ((long)clusters[clusterIndex] - 2) * clusterSize + inCluster);
                    image.Position = imageOffset;
                    image.ReadExactly(destination.Slice(written, count));
                    written += count;
                    _position += count;
                }
            }
            return written;
        }
        public override long Seek(long offset, SeekOrigin origin)
        {
            long target = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => checked(_position + offset),
                SeekOrigin.End => checked(length + offset),
                _ => throw new ArgumentOutOfRangeException(nameof(origin))
            };
            Position = target;
            return target;
        }
        public override void Flush() { }
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
