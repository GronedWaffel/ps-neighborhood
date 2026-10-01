using System.Buffers.Binary;
using System.Text;

namespace PS5PKGTool.Ffpfsc;

public readonly record struct AmprFileRecord(string RelativePath, long Size, long UnixModifiedTime);
public sealed record AmprIndexInfo(int RecordCount, int HashSlotCount, long PathBlobLength);

/// <summary>Native AMPRIDX3 index builder and structural validator.</summary>
public static class AmprIndex
{
    private const int HeaderSize = 48;
    private const int RecordSize = 24;
    private const int SlotSize = 16;
    private const ulong FnvOffset = 1469598103934665603;
    private const ulong FnvPrime = 1099511628211;

    public static byte[] Build(IEnumerable<AmprFileRecord> sourceFiles)
    {
        ArgumentNullException.ThrowIfNull(sourceFiles);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var rows = sourceFiles
            .Where(file => file.Size >= 0)
            .Select(file => new AmprFileRecord(NormalizeRelativePath(file.RelativePath), file.Size, file.UnixModifiedTime))
            .Where(file => !file.RelativePath.Equals("ampr_emu.index", StringComparison.OrdinalIgnoreCase) &&
                           !file.RelativePath.Equals("ampr_emu.index.tmp", StringComparison.OrdinalIgnoreCase))
            .Where(file => seen.Add(Key("/app0/" + file.RelativePath)))
            .OrderBy(file => Key("/app0/" + file.RelativePath), StringComparer.Ordinal)
            .ToArray();
        if (rows.Length == 0) return [];

        var paths = new List<byte[]>(rows.Length);
        long pathBlobLength = 0;
        foreach (AmprFileRecord row in rows)
        {
            byte[] path = Encoding.UTF8.GetBytes("/app0/" + row.RelativePath);
            if (pathBlobLength > uint.MaxValue)
                throw new InvalidDataException("The AMPR path table exceeds its 32-bit format limit.");
            paths.Add(path);
            pathBlobLength = checked(pathBlobLength + path.Length + 1);
        }

        int slotCount = 2;
        while (slotCount < checked(rows.Length * 2)) slotCount = checked(slotCount * 2);
        long pathEnd = checked(HeaderSize + (long)rows.Length * RecordSize + pathBlobLength);
        long hashOffset = Align(pathEnd, SlotSize);
        long totalLength = checked(hashOffset + (long)slotCount * SlotSize);
        if (totalLength > int.MaxValue) throw new InvalidDataException("The AMPR index is too large to hold in memory.");
        byte[] result = new byte[checked((int)totalLength)];
        "AMPRIDX3"u8.CopyTo(result);
        BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(8, 4), 3);
        BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(12, 4), RecordSize);
        BinaryPrimitives.WriteUInt64LittleEndian(result.AsSpan(16, 8), checked((ulong)rows.Length));
        BinaryPrimitives.WriteUInt64LittleEndian(result.AsSpan(24, 8), checked((ulong)pathBlobLength));
        BinaryPrimitives.WriteUInt64LittleEndian(result.AsSpan(32, 8), checked((ulong)hashOffset));
        BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(40, 4), SlotSize);
        BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(44, 4), checked((uint)slotCount));

        int pathOffset = 0;
        int pathBase = checked(HeaderSize + rows.Length * RecordSize);
        for (int index = 0; index < rows.Length; index++)
        {
            Span<byte> record = result.AsSpan(HeaderSize + index * RecordSize, RecordSize);
            BinaryPrimitives.WriteUInt32LittleEndian(record.Slice(0, 4), checked((uint)pathOffset));
            BinaryPrimitives.WriteUInt32LittleEndian(record.Slice(4, 4), checked((uint)paths[index].Length));
            BinaryPrimitives.WriteUInt64LittleEndian(record.Slice(8, 8), checked((ulong)rows[index].Size));
            BinaryPrimitives.WriteInt64LittleEndian(record.Slice(16, 8), rows[index].UnixModifiedTime);
            paths[index].CopyTo(result, pathBase + pathOffset);
            pathOffset += paths[index].Length + 1;
        }

        int mask = slotCount - 1;
        for (int index = 0; index < rows.Length; index++)
        {
            ulong hash = HashPath("/app0/" + rows[index].RelativePath);
            int position = checked((int)(hash & (uint)mask));
            while (true)
            {
                Span<byte> slot = result.AsSpan(checked((int)hashOffset + position * SlotSize), SlotSize);
                uint existingIndex = BinaryPrimitives.ReadUInt32LittleEndian(slot.Slice(8, 4));
                if (existingIndex == 0)
                {
                    BinaryPrimitives.WriteUInt64LittleEndian(slot.Slice(0, 8), hash);
                    BinaryPrimitives.WriteUInt32LittleEndian(slot.Slice(8, 4), checked((uint)(index + 1)));
                    break;
                }
                if (BinaryPrimitives.ReadUInt64LittleEndian(slot.Slice(0, 8)) == hash)
                    BinaryPrimitives.WriteUInt32LittleEndian(slot.Slice(12, 4), 1);
                position = (position + 1) & mask;
            }
        }
        _ = Inspect(result);
        return result;
    }

    public static AmprIndexInfo Inspect(ReadOnlySpan<byte> data)
    {
        if (data.Length < HeaderSize || !data.Slice(0, 8).SequenceEqual("AMPRIDX3"u8))
            throw new InvalidDataException("AMPRIDX3 magic is missing.");
        uint version = BinaryPrimitives.ReadUInt32LittleEndian(data.Slice(8, 4));
        uint recordSize = BinaryPrimitives.ReadUInt32LittleEndian(data.Slice(12, 4));
        ulong rowCount = BinaryPrimitives.ReadUInt64LittleEndian(data.Slice(16, 8));
        ulong pathLength = BinaryPrimitives.ReadUInt64LittleEndian(data.Slice(24, 8));
        ulong hashOffset = BinaryPrimitives.ReadUInt64LittleEndian(data.Slice(32, 8));
        uint slotSize = BinaryPrimitives.ReadUInt32LittleEndian(data.Slice(40, 4));
        uint slotCount = BinaryPrimitives.ReadUInt32LittleEndian(data.Slice(44, 4));
        if (version != 3 || recordSize != RecordSize || slotSize != SlotSize || rowCount == 0 || slotCount == 0 ||
            (slotCount & (slotCount - 1)) != 0 || rowCount > int.MaxValue || slotCount > int.MaxValue)
            throw new InvalidDataException("The AMPRIDX3 header is invalid.");
        ulong recordsEnd = checked((ulong)HeaderSize + rowCount * recordSize);
        ulong pathEnd = checked(recordsEnd + pathLength);
        ulong expectedEnd = checked(hashOffset + slotCount * slotSize);
        if (hashOffset < pathEnd || hashOffset % slotSize != 0 || expectedEnd != (ulong)data.Length)
            throw new InvalidDataException("The AMPRIDX3 ranges are invalid.");

        for (int index = 0; index < checked((int)rowCount); index++)
        {
            ReadOnlySpan<byte> record = data.Slice(HeaderSize + index * RecordSize, RecordSize);
            uint offset = BinaryPrimitives.ReadUInt32LittleEndian(record.Slice(0, 4));
            uint length = BinaryPrimitives.ReadUInt32LittleEndian(record.Slice(4, 4));
            if ((ulong)offset + length >= pathLength || data[checked((int)(recordsEnd + offset + length))] != 0)
                throw new InvalidDataException("An AMPRIDX3 path record is invalid.");
        }
        return new AmprIndexInfo(checked((int)rowCount), checked((int)slotCount), checked((long)pathLength));
    }

    public static ulong HashPath(string path)
    {
        ulong hash = FnvOffset;
        foreach (Rune value in Key(path).EnumerateRunes())
        {
            hash ^= checked((uint)value.Value);
            hash = unchecked(hash * FnvPrime);
        }
        return hash == 0 ? 1 : hash;
    }

    private static string NormalizeRelativePath(string path)
    {
        string normalized = path.Replace('\\', '/').TrimStart('/');
        if (normalized.Length == 0 || normalized.Split('/').Any(part => part.Length == 0 || part is "." or ".."))
            throw new InvalidDataException($"The AMPR relative path is invalid: {path}");
        return normalized;
    }

    private static string Key(string path) => path.Replace('\\', '/').ToLowerInvariant();
    private static long Align(long value, int alignment) => checked((value + alignment - 1) / alignment * alignment);
}
