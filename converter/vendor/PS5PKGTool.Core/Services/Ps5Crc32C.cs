namespace PS5PKGTool.Core.Services;

public static class Ps5Crc32C
{
    private static readonly uint[] Table = BuildTable();
    public static uint Compute(ReadOnlySpan<byte> data)
    {
        uint value = 0xFFFFFFFF;
        foreach (byte octet in data) value = Table[(value ^ octet) & 0xFF] ^ (value >> 8);
        return ~value;
    }
    public static uint[] ComputeBlocks(Stream stream, int blockSize = 0x10000)
    {
        if (!stream.CanRead) throw new ArgumentException("The stream must be readable.", nameof(stream));
        if (blockSize <= 0) throw new ArgumentOutOfRangeException(nameof(blockSize));
        byte[] block = new byte[blockSize]; var values = new List<uint>(); int read;
        while ((read = ReadBlock(stream, block)) > 0) values.Add(Compute(block.AsSpan(0, read)));
        return values.ToArray();
    }
    private static int ReadBlock(Stream stream, byte[] data)
    {
        int total = 0; while (total < data.Length) { int read = stream.Read(data, total, data.Length - total); if (read == 0) break; total += read; } return total;
    }
    private static uint[] BuildTable()
    {
        const uint polynomial = 0x82F63B78; var result = new uint[256];
        for (uint index = 0; index < result.Length; index++) { uint value = index; for (int bit = 0; bit < 8; bit++) value = (value & 1) != 0 ? (value >> 1) ^ polynomial : value >> 1; result[index] = value; }
        return result;
    }
}
