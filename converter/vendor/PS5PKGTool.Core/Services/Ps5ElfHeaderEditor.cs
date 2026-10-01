using System.Buffers.Binary;

namespace PS5PKGTool.Core.Services;

public sealed class Ps5ElfHeaderInfo
{
    public required long ElfOffset { get; init; }
    public required byte ElfClass { get; init; }
    public required byte OsAbi { get; init; }
    public required ushort Type { get; init; }
    public required ushort Machine { get; init; }
}

public static class Ps5ElfHeaderEditor
{
    public static Ps5ElfHeaderInfo Read(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        byte[] head = new byte[Math.Min(4096, checked((int)Math.Min(stream.Length, 4096)))]; stream.ReadExactly(head);
        int offset = FindElf(head); if (offset < 0 || offset + 64 > head.Length) throw new InvalidDataException("No complete ELF header was found in the first 4 KiB.");
        ReadOnlySpan<byte> elf = head.AsSpan(offset);
        if (elf[5] != 1) throw new InvalidDataException("Only little-endian ELF headers are supported.");
        return new Ps5ElfHeaderInfo { ElfOffset = offset, ElfClass = elf[4], OsAbi = elf[7], Type = BinaryPrimitives.ReadUInt16LittleEndian(elf[16..]), Machine = BinaryPrimitives.ReadUInt16LittleEndian(elf[18..]) };
    }
    public static void EditAtomic(string path, byte? osAbi = null, ushort? type = null, ushort? machine = null)
    {
        Ps5ElfHeaderInfo info = Read(path); string source = Path.GetFullPath(path); string? parent = Path.GetDirectoryName(source);
        string temporary = Path.Combine(parent!, "." + Path.GetFileName(source) + "." + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            File.Copy(source, temporary);
            using (var stream = new FileStream(temporary, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                if (osAbi is byte abi) { stream.Position = info.ElfOffset + 7; stream.WriteByte(abi); }
                if (type is ushort elfType) { Span<byte> value = stackalloc byte[2]; BinaryPrimitives.WriteUInt16LittleEndian(value, elfType); stream.Position = info.ElfOffset + 16; stream.Write(value); }
                if (machine is ushort elfMachine) { Span<byte> value = stackalloc byte[2]; BinaryPrimitives.WriteUInt16LittleEndian(value, elfMachine); stream.Position = info.ElfOffset + 18; stream.Write(value); }
                stream.Flush(true);
            }
            File.Move(temporary, source, true);
        }
        finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch (IOException) { } }
    }
    private static int FindElf(ReadOnlySpan<byte> data)
    {
        for (int index = 0; index <= data.Length - 4; index++) if (data[index] == 0x7F && data[index + 1] == 0x45 && data[index + 2] == 0x4C && data[index + 3] == 0x46) return index;
        return -1;
    }
}
