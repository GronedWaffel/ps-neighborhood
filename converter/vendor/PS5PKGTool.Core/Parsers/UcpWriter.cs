using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace PS5PKGTool.Core.Parsers;

public sealed record UcpWriteEntry(string Name, byte[] Data);

public static class UcpWriter
{
    private const int HeaderSize = 0x60;
    private const int EntrySize = 0x30;
    private const int HashOffset = 0x1C;
    public static void WriteAtomic(string outputPath, IReadOnlyList<UcpWriteEntry> entries)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        ArgumentNullException.ThrowIfNull(entries);
        if (entries.Count == 0 || entries.Count > 100_000) throw new ArgumentOutOfRangeException(nameof(entries));
        ValidateEntries(entries);
        string destination = Path.GetFullPath(outputPath); string? parent = Path.GetDirectoryName(destination);
        if (string.IsNullOrWhiteSpace(parent)) throw new ArgumentException("Output path has no parent directory.", nameof(outputPath));
        Directory.CreateDirectory(parent);
        string temporary = Path.Combine(parent, "." + Path.GetFileName(destination) + "." + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            long tableSize = checked((long)entries.Count * EntrySize);
            long position = HeaderSize + tableSize;
            long total = checked(position + entries.Sum(entry => (long)entry.Data.Length));
            using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
            {
                byte[] header = new byte[HeaderSize];
                header[0] = 0xB2; header[1] = 0x28; header[2] = 0xC6; header[3] = 0x0A;
                WriteU32(header, 4, 1); WriteU64(header, 8, checked((ulong)total)); WriteU32(header, 16, checked((uint)entries.Count)); WriteU32(header, 20, EntrySize);
                output.Write(header);
                foreach (UcpWriteEntry entry in entries)
                {
                    byte[] record = new byte[EntrySize]; Encoding.UTF8.GetBytes(entry.Name).CopyTo(record, 0);
                    WriteU64(record, 32, checked((ulong)position)); WriteU64(record, 40, checked((ulong)entry.Data.Length));
                    output.Write(record); position += entry.Data.Length;
                }
                foreach (UcpWriteEntry entry in entries) output.Write(entry.Data);
                output.Position = 0; using IncrementalHash sha1 = IncrementalHash.CreateHash(HashAlgorithmName.SHA1);
                byte[] buffer = new byte[1024 * 1024]; long cursor = 0; int read;
                while ((read = output.Read(buffer, 0, buffer.Length)) > 0)
                {
                    long start = Math.Max(HashOffset, cursor); long end = Math.Min(HashOffset + 20, cursor + read);
                    if (start < end) Array.Clear(buffer, checked((int)(start - cursor)), checked((int)(end - start)));
                    sha1.AppendData(buffer, 0, read); cursor += read;
                }
                output.Position = HashOffset; output.Write(sha1.GetHashAndReset()); output.Flush(true);
            }
            File.Move(temporary, destination, true);
        }
        finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch (IOException) { } }
    }
    public static void RepairDigestAtomic(string path)
    {
        UcpArchive archive = new UcpReader().Read(path);
        var entries = archive.Entries.Select(entry => new UcpWriteEntry(entry.Name, new UcpReader().ReadEntry(archive, entry))).ToArray();
        WriteAtomic(path, entries);
    }
    private static void ValidateEntries(IReadOnlyList<UcpWriteEntry> entries)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (UcpWriteEntry entry in entries)
        {
            ArgumentNullException.ThrowIfNull(entry.Data);
            if (string.IsNullOrWhiteSpace(entry.Name) || Encoding.UTF8.GetByteCount(entry.Name) > 31 || entry.Name.Any(char.IsControl) || !names.Add(entry.Name))
                throw new InvalidDataException("UCP entry names must be unique UTF-8 values up to 31 bytes.");
        }
    }
    private static void WriteU32(byte[] data, int offset, uint value) => BinaryPrimitives.WriteUInt32BigEndian(data.AsSpan(offset), value);
    private static void WriteU64(byte[] data, int offset, ulong value) => BinaryPrimitives.WriteUInt64BigEndian(data.AsSpan(offset), value);
}
