using System.Buffers.Binary;
using PS5PKGTool.Core.Models;
using PS5PKGTool.Core.Services;

namespace PS5PKGTool.Core.Parsers;

public sealed class Ps5SelfReader
{
    private static readonly byte[] ElfMagic = [0x7F, 0x45, 0x4C, 0x46];

    private const uint SelfMagicFself = 0xEEF51454; // fake-self / genuine SELF container magic
    private const uint SelfMagicSelf = 0x1D3D154F;  // alternate SELF container magic
    private const int ElfHeaderSize = 64;
    private const long MaximumHeaderWindow = 4 * 1024 * 1024; // caps the extended header read

    public Ps5SelfInfo? Read(string gameRoot, CancellationToken cancellationToken = default)
    {
        string ebootPath = Path.Combine(gameRoot, "eboot.bin");
        if (!File.Exists(ebootPath)) return null;
        using FileStream stream = new(ebootPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        IReadOnlyList<Ps5ModuleInfo> modules = ReadModules(gameRoot, cancellationToken);
        return ReadStream(stream, modules);
    }

    public Ps5SelfInfo? Read(IReadOnlyGameFileSystem files, CancellationToken cancellationToken = default)
    {
        const string path = "eboot.bin";
        if (!files.FileExists(path)) return null;
        using Stream stream = files.OpenRead(path);
        IReadOnlyList<Ps5ModuleInfo> modules = files.Files
            .Where(file => Path.GetExtension(file.RelativePath) is string extension &&
                           (extension.Equals(".prx", StringComparison.OrdinalIgnoreCase) ||
                            extension.Equals(".sprx", StringComparison.OrdinalIgnoreCase)))
            .Select(file => new Ps5ModuleInfo
            {
                Name = Path.GetFileName(file.RelativePath),
                RelativePath = file.RelativePath.Replace('/', Path.DirectorySeparatorChar),
                Size = file.Size,
                Kind = Path.GetExtension(file.RelativePath).TrimStart('.').ToUpperInvariant()
            }).OrderBy(module => module.Name, StringComparer.OrdinalIgnoreCase).ToArray();
        cancellationToken.ThrowIfCancellationRequested();
        return ReadStream(stream, modules);
    }

    private static Ps5SelfInfo ReadStream(Stream stream, IReadOnlyList<Ps5ModuleInfo> modules)
    {
        long fileSize = stream.Length;
        if (fileSize < 4)
            throw new InvalidDataException("eboot.bin is too small to contain an ELF header.");

        // The embedded ELF sits after the 0x20-byte SELF container header and a 0x20-byte table
        // entry per segment, so a module with many segments (for example a genuine game eboot)
        // places the ELF well past the first 4 KiB. Read a 64 KiB window and extend it as needed.
        byte[] buffer = ReadWindow(stream, 0x10000);
        uint magic = buffer.Length >= 4 ? BinaryPrimitives.ReadUInt32LittleEndian(buffer) : 0u;
        bool isSelf = buffer.Length >= 0x20 && (magic == SelfMagicFself || magic == SelfMagicSelf);

        byte selfVersion = 0;
        uint selfProgramType = 0;
        ushort selfHeaderSize = 0, selfMetaSize = 0, selfSegmentCount = 0, selfFlags = 0;
        ulong selfDeclaredSize = 0;
        var selfSegments = new List<Ps5SelfSegment>();
        if (isSelf)
        {
            selfVersion = buffer[4];
            selfProgramType = BinaryPrimitives.ReadUInt32LittleEndian(buffer.AsSpan(0x08, 4));
            selfHeaderSize = BinaryPrimitives.ReadUInt16LittleEndian(buffer.AsSpan(0x0C, 2));
            selfMetaSize = BinaryPrimitives.ReadUInt16LittleEndian(buffer.AsSpan(0x0E, 2));
            selfDeclaredSize = BinaryPrimitives.ReadUInt64LittleEndian(buffer.AsSpan(0x10, 8));
            selfSegmentCount = BinaryPrimitives.ReadUInt16LittleEndian(buffer.AsSpan(0x18, 2));
            selfFlags = BinaryPrimitives.ReadUInt16LittleEndian(buffer.AsSpan(0x1A, 2));

            buffer = EnsureWindow(stream, buffer, 0x20L + (long)selfSegmentCount * 0x20);
            for (int i = 0; i < selfSegmentCount; i++)
            {
                int entry = 0x20 + i * 0x20;
                if (entry + 0x20 > buffer.Length) break;
                selfSegments.Add(new Ps5SelfSegment
                {
                    Index = i,
                    Flags = BinaryPrimitives.ReadUInt64LittleEndian(buffer.AsSpan(entry, 8)),
                    FileOffset = (long)BinaryPrimitives.ReadUInt64LittleEndian(buffer.AsSpan(entry + 0x08, 8)),
                    FileSize = (long)BinaryPrimitives.ReadUInt64LittleEndian(buffer.AsSpan(entry + 0x10, 8)),
                    MemorySize = (long)BinaryPrimitives.ReadUInt64LittleEndian(buffer.AsSpan(entry + 0x18, 8))
                });
            }
        }

        int elfOffset = -1;
        if (isSelf)
        {
            long elfStart = 0x20L + (long)selfSegmentCount * 0x20;
            if (elfStart >= 0 && elfStart + ElfHeaderSize <= fileSize && elfStart + ElfHeaderSize <= MaximumHeaderWindow)
            {
                buffer = EnsureWindow(stream, buffer, elfStart + ElfHeaderSize);
                if (elfStart + 4 <= buffer.Length && IsElfMagic(buffer.AsSpan((int)elfStart, 4)))
                    elfOffset = (int)elfStart;
            }
        }

        if (elfOffset < 0)
            elfOffset = Find(buffer, ElfMagic);
        if (elfOffset < 0 || elfOffset + ElfHeaderSize > buffer.Length)
            throw new InvalidDataException(isSelf
                ? "eboot.bin is a SELF container, but its embedded ELF header could not be located (the module may be genuine/encrypted)."
                : "No embedded ELF header was found in eboot.bin.");

        ReadOnlySpan<byte> elf = buffer.AsSpan(elfOffset, ElfHeaderSize);
        if (elf[5] != 1) throw new InvalidDataException("Only little-endian PS5 ELF files are currently supported.");

        long phoff = (long)BinaryPrimitives.ReadUInt64LittleEndian(elf.Slice(0x20, 8));
        int phentsize = BinaryPrimitives.ReadUInt16LittleEndian(elf.Slice(0x36, 2));
        int phnum = BinaryPrimitives.ReadUInt16LittleEndian(elf.Slice(0x38, 2));
        long shoff = (long)BinaryPrimitives.ReadUInt64LittleEndian(elf.Slice(0x28, 8));
        int shentsize = BinaryPrimitives.ReadUInt16LittleEndian(elf.Slice(0x3A, 2));
        int shnum = BinaryPrimitives.ReadUInt16LittleEndian(elf.Slice(0x3C, 2));

        var programHeaders = new List<Ps5ElfProgramHeader>();
        if (phnum > 0 && phentsize >= 56)
        {
            buffer = EnsureWindow(stream, buffer, (long)elfOffset + phoff + (long)phnum * phentsize);
            for (int i = 0; i < phnum; i++)
            {
                long at = (long)elfOffset + phoff + (long)i * phentsize;
                if (at < 0 || at + 56 > buffer.Length) break;
                ReadOnlySpan<byte> p = buffer.AsSpan((int)at, 56);
                programHeaders.Add(new Ps5ElfProgramHeader
                {
                    Index = i,
                    Type = BinaryPrimitives.ReadUInt32LittleEndian(p),
                    Flags = BinaryPrimitives.ReadUInt32LittleEndian(p.Slice(4)),
                    Offset = (long)BinaryPrimitives.ReadUInt64LittleEndian(p.Slice(0x08)),
                    VirtualAddress = BinaryPrimitives.ReadUInt64LittleEndian(p.Slice(0x10)),
                    PhysicalAddress = BinaryPrimitives.ReadUInt64LittleEndian(p.Slice(0x18)),
                    FileSize = (long)BinaryPrimitives.ReadUInt64LittleEndian(p.Slice(0x20)),
                    MemorySize = (long)BinaryPrimitives.ReadUInt64LittleEndian(p.Slice(0x28)),
                    Align = BinaryPrimitives.ReadUInt64LittleEndian(p.Slice(0x30))
                });
            }
        }

        var sectionHeaders = new List<Ps5ElfSectionHeader>();
        if (shnum > 0 && shentsize >= 64)
        {
            buffer = EnsureWindow(stream, buffer, (long)elfOffset + shoff + (long)shnum * shentsize);
            for (int i = 0; i < shnum; i++)
            {
                long at = (long)elfOffset + shoff + (long)i * shentsize;
                if (at < 0 || at + 64 > buffer.Length) break;
                ReadOnlySpan<byte> s = buffer.AsSpan((int)at, 64);
                sectionHeaders.Add(new Ps5ElfSectionHeader
                {
                    Index = i,
                    Name = BinaryPrimitives.ReadUInt32LittleEndian(s),
                    Type = BinaryPrimitives.ReadUInt32LittleEndian(s.Slice(4)),
                    Flags = BinaryPrimitives.ReadUInt64LittleEndian(s.Slice(8)),
                    Address = BinaryPrimitives.ReadUInt64LittleEndian(s.Slice(0x10)),
                    Offset = (long)BinaryPrimitives.ReadUInt64LittleEndian(s.Slice(0x18)),
                    Size = (long)BinaryPrimitives.ReadUInt64LittleEndian(s.Slice(0x20))
                });
            }
        }

        return new Ps5SelfInfo
        {
            IsSelf = isSelf,
            SelfMagic = Convert.ToHexString(buffer.AsSpan(0, 4)),
            FileSize = stream.Length,
            ElfOffset = elfOffset,
            ElfClass = elf[4],
            Endianness = elf[5],
            ElfType = BinaryPrimitives.ReadUInt16LittleEndian(elf.Slice(16, 2)),
            Machine = BinaryPrimitives.ReadUInt16LittleEndian(elf.Slice(18, 2)),
            EntryPoint = BinaryPrimitives.ReadUInt64LittleEndian(elf.Slice(24, 8)),
            ProgramHeaderCount = (ushort)phnum,
            SectionHeaderCount = (ushort)shnum,
            Modules = modules,
            SelfVersion = selfVersion,
            SelfProgramType = selfProgramType,
            SelfHeaderSize = selfHeaderSize,
            SelfMetadataSize = selfMetaSize,
            SelfDeclaredFileSize = selfDeclaredSize,
            SelfSegmentCount = selfSegmentCount,
            SelfFlags = selfFlags,
            SelfSegments = selfSegments,
            ProgramHeaders = programHeaders,
            SectionHeaders = sectionHeaders
        };
    }

    // Extends the read window to cover <paramref name="required"/> bytes (capped by the file size
    // and MaximumHeaderWindow). Returns the existing buffer when it already covers the range.
    private static byte[] EnsureWindow(Stream stream, byte[] buffer, long required)
    {
        long capped = Math.Min(required, Math.Min(stream.Length, MaximumHeaderWindow));
        if (capped <= buffer.Length) return buffer;
        return ReadWindow(stream, checked((int)capped));
    }

    private static byte[] ReadWindow(Stream stream, int count)
    {
        int length = checked((int)Math.Min(stream.Length, count));
        byte[] buffer = new byte[length];
        stream.Position = 0;
        int read = 0;
        while (read < length)
        {
            int chunk = stream.Read(buffer, read, length - read);
            if (chunk <= 0) throw new EndOfStreamException("eboot.bin ended unexpectedly while reading its header.");
            read += chunk;
        }
        return buffer;
    }

    private static bool IsElfMagic(ReadOnlySpan<byte> data) =>
        data.Length >= 4 && data[0] == 0x7F && data[1] == 0x45 && data[2] == 0x4C && data[3] == 0x46;

    private static IReadOnlyList<Ps5ModuleInfo> ReadModules(string gameRoot, CancellationToken cancellationToken)
    {
        var modules = new List<Ps5ModuleInfo>();
        foreach (string file in SafeFiles(gameRoot))
        {
            cancellationToken.ThrowIfCancellationRequested();
            string extension = Path.GetExtension(file);
            if (!extension.Equals(".prx", StringComparison.OrdinalIgnoreCase) &&
                !extension.Equals(".sprx", StringComparison.OrdinalIgnoreCase)) continue;
            var info = new FileInfo(file);
            modules.Add(new Ps5ModuleInfo
            {
                Name = info.Name,
                RelativePath = Path.GetRelativePath(gameRoot, file),
                Size = info.Length,
                Kind = extension.TrimStart('.').ToUpperInvariant()
            });
        }
        return modules.OrderBy(module => module.Name, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static IEnumerable<string> SafeFiles(string root)
    {
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.ReparsePoint
        };
        return Directory.EnumerateFiles(root, "*", options);
    }

    private static int Find(ReadOnlySpan<byte> data, ReadOnlySpan<byte> pattern)
    {
        for (int index = 0; index <= data.Length - pattern.Length; index++)
            if (data.Slice(index, pattern.Length).SequenceEqual(pattern)) return index;
        return -1;
    }
}
