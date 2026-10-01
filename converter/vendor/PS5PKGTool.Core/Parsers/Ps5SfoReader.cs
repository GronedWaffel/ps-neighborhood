using System.Buffers.Binary;
using System.Text;

namespace PS5PKGTool.Core.Parsers;

public sealed record Ps5SfoEntry(string Key, string Format, string Value);

/// <summary>Minimal reader for the binary SFO container (magic "\0PSF") used by sce_sys/param.sfo.</summary>
public static class Ps5SfoReader
{
    private const uint Magic = 0x46535000; // bytes 00 50 53 46

    public static IReadOnlyList<Ps5SfoEntry> Read(byte[] data)
    {
        var result = new List<Ps5SfoEntry>();
        if (data.Length < 20 || BinaryPrimitives.ReadUInt32LittleEndian(data) != Magic) return result;

        uint keyTable = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(8));
        uint dataTable = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(12));
        uint count = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(16));

        for (int i = 0; i < count; i++)
        {
            int entryOffset = 20 + i * 16;
            if (entryOffset + 16 > data.Length) break;

            ushort keyOffset = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(entryOffset));
            ushort format = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(entryOffset + 2));
            uint length = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(entryOffset + 4));
            uint dataOffset = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(entryOffset + 12));

            long keyAt = keyTable + keyOffset;
            long dataAt = dataTable + dataOffset;
            if (keyAt < 0 || keyAt >= data.Length || dataAt < 0 || dataAt > data.Length) continue;

            string key = ReadCString(data, (int)keyAt);
            string value = format == 0x0404 && dataAt + 4 <= data.Length
                ? BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan((int)dataAt)).ToString()
                : ReadFixedString(data, (int)dataAt, length);
            result.Add(new Ps5SfoEntry(key, FormatName(format), value));
        }
        return result;
    }

    private static string ReadCString(byte[] data, int offset)
    {
        int end = offset;
        while (end < data.Length && data[end] != 0) end++;
        return Encoding.UTF8.GetString(data, offset, end - offset);
    }

    private static string ReadFixedString(byte[] data, int offset, uint length)
    {
        if (offset >= data.Length) return string.Empty;
        int available = Math.Min((int)Math.Min(length, int.MaxValue), data.Length - offset);
        int end = available;
        while (end > 0 && data[offset + end - 1] == 0) end--;
        return Encoding.UTF8.GetString(data, offset, end);
    }

    private static string FormatName(ushort format) => format switch
    {
        0x0204 => "string",
        0x0404 => "uint32",
        0x0004 => "text",
        _ => $"0x{format:X4}"
    };
}
