using System.Security.Cryptography;
using System.Text;

namespace PS5PKGTool.Core.Parsers;

public sealed class UcpEntry
{
    public int Index { get; init; }
    public string Name { get; init; } = string.Empty;
    public long Offset { get; init; }
    public long Size { get; init; }
}

public sealed class UcpArchive
{
    private readonly Func<Stream> _openSource;

    internal UcpArchive(string filePath, Func<Stream> openSource, uint version, long declaredSize,
        uint entrySize, byte[] storedSha1, IReadOnlyList<UcpEntry> entries)
    {
        FilePath = filePath;
        _openSource = openSource;
        Version = version;
        DeclaredSize = declaredSize;
        EntrySize = entrySize;
        StoredSha1 = storedSha1;
        Entries = entries;
    }

    public string FilePath { get; }
    public uint Version { get; }
    public long DeclaredSize { get; }
    public uint EntrySize { get; }
    public byte[] StoredSha1 { get; }
    public IReadOnlyList<UcpEntry> Entries { get; }
    internal Stream OpenSource() => _openSource();
}

public sealed class UcpReader
{
    private const int HeaderSize = 0x60;
    private const int HashOffset = 0x1C;
    private const int HashLength = 20;
    private static readonly byte[] Magic = [0xB2, 0x28, 0xC6, 0x0A];
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    public UcpArchive Read(string filePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        string fullPath = Path.GetFullPath(filePath);
        return Read(fullPath, () => new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read));
    }

    public UcpArchive Read(string sourceName, Func<Stream> openSource)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceName);
        ArgumentNullException.ThrowIfNull(openSource);
        using Stream stream = openSource();
        if (!stream.CanRead || !stream.CanSeek)
            throw new InvalidDataException("The UCP source must be readable and seekable.");
        Span<byte> header = stackalloc byte[HeaderSize];
        stream.ReadExactly(header);

        if (!header[..4].SequenceEqual(Magic))
            throw new InvalidDataException("The file is not a supported UCP archive.");

        uint version = BigEndian.UInt32(header.Slice(4, 4));
        ulong declaredSizeValue = BigEndian.UInt64(header.Slice(8, 8));
        uint fileCount = BigEndian.UInt32(header.Slice(16, 4));
        uint entrySize = BigEndian.UInt32(header.Slice(20, 4));

        if (version != 1)
            throw new InvalidDataException($"Unsupported UCP version {version}.");
        if (declaredSizeValue > long.MaxValue || (long)declaredSizeValue != stream.Length)
            throw new InvalidDataException("The UCP declared size does not match the file size.");
        if (entrySize < 0x30 || entrySize > 0x1000)
            throw new InvalidDataException($"Invalid UCP entry size 0x{entrySize:X}.");
        if (fileCount > 100_000)
            throw new InvalidDataException("The UCP entry count is unreasonable.");

        long tableSize = checked((long)fileCount * entrySize);
        if (HeaderSize + tableSize > stream.Length)
            throw new InvalidDataException("The UCP entry table extends beyond the file.");

        byte[] storedSha1 = header.Slice(HashOffset, HashLength).ToArray();
        var entries = new List<UcpEntry>(checked((int)fileCount));
        byte[] record = new byte[entrySize];
        long previousEnd = HeaderSize + tableSize;

        for (int index = 0; index < fileCount; index++)
        {
            stream.ReadExactly(record);
            int terminator = Array.IndexOf(record, (byte)0, 0, 32);
            if (terminator < 0) terminator = 32;
            string name = StrictUtf8.GetString(record, 0, terminator);
            ulong offsetValue = BigEndian.UInt64(record.AsSpan(32, 8));
            ulong sizeValue = BigEndian.UInt64(record.AsSpan(40, 8));

            if (string.IsNullOrWhiteSpace(name))
                throw new InvalidDataException($"UCP entry {index} has no name.");
            if (offsetValue > long.MaxValue || sizeValue > long.MaxValue)
                throw new InvalidDataException($"UCP entry {name} is too large.");

            long offset = (long)offsetValue;
            long size = (long)sizeValue;
            long end = checked(offset + size);
            if (offset < previousEnd || end > stream.Length)
                throw new InvalidDataException($"UCP entry {name} has an invalid data range.");

            entries.Add(new UcpEntry { Index = index, Name = name, Offset = offset, Size = size });
            previousEnd = end;
        }

        return new UcpArchive(sourceName, openSource, version, (long)declaredSizeValue, entrySize, storedSha1, entries);
    }

    public bool ValidateIntegrity(UcpArchive archive, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(archive);
        using Stream stream = archive.OpenSource();
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA1);
        byte[] buffer = new byte[1024 * 1024];
        long position = 0;
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            long start = Math.Max(HashOffset, position);
            long end = Math.Min(HashOffset + HashLength, position + read);
            if (start < end)
                Array.Clear(buffer, checked((int)(start - position)), checked((int)(end - start)));
            hash.AppendData(buffer, 0, read);
            position += read;
        }
        return CryptographicOperations.FixedTimeEquals(hash.GetHashAndReset(), archive.StoredSha1);
    }

    public byte[] ReadEntry(UcpArchive archive, UcpEntry entry)
    {
        ArgumentNullException.ThrowIfNull(archive);
        ArgumentNullException.ThrowIfNull(entry);
        if (entry.Size > int.MaxValue)
            throw new InvalidDataException($"UCP entry {entry.Name} is too large to load into memory.");
        using Stream stream = archive.OpenSource();
        stream.Position = entry.Offset;
        byte[] data = new byte[checked((int)entry.Size)];
        stream.ReadExactly(data);
        return data;
    }

    public string ReadEntryText(UcpArchive archive, UcpEntry entry) => StrictUtf8.GetString(ReadEntry(archive, entry));

    public static UcpEntry? Find(UcpArchive archive, string name) =>
        archive.Entries.FirstOrDefault(entry => string.Equals(entry.Name, name, StringComparison.OrdinalIgnoreCase));
}
