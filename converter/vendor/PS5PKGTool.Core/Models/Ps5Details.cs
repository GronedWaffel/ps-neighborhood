namespace PS5PKGTool.Core.Models;

public sealed class Ps5GameDetails
{
    public Ps5TrophySet? TrophySet { get; init; }
    public Ps5UdsSummary? Uds { get; init; }
    public Ps5SelfInfo? Executable { get; init; }
    public Ps5FileInventory Files { get; init; } = new();
    public Ps5ImageData? Icon { get; init; }
    public Ps5ImageData? Background { get; init; }
    public Ps5ImageData? Background1 { get; init; }
    public Ps5ImageData? Background2 { get; init; }
    public List<string> Errors { get; init; } = [];
    /// <summary>Per-section state and origin, so an empty section can be distinguished from a failure.</summary>
    public IReadOnlyDictionary<string, SectionStatus> Sections { get; init; } =
        new Dictionary<string, SectionStatus>(StringComparer.OrdinalIgnoreCase);
}

/// <summary>
/// A progressive artwork snapshot. The loader reports the icon first (cheap PNG) so it can be shown
/// immediately, then reports again with the background art once the heavier DDS images are decoded.
/// </summary>
public sealed record Ps5Artwork(Ps5ImageData? Icon, Ps5ImageData? Background, Ps5ImageData? Background1, Ps5ImageData? Background2);

/// <summary>
/// Decoded artwork pixels. PNG entries keep their encoded bytes; DDS entries are decoded once to
/// raw RGBA (with dimensions) so the UI can build a bitmap directly instead of round-tripping the
/// texture through a re-encoded PNG.
/// </summary>
public sealed record Ps5ImageData(byte[] Bytes, int Width, int Height, bool IsRgba)
{
    public bool IsEmpty => Bytes.Length == 0;
    public static Ps5ImageData FromPng(byte[] bytes)
    {
        // Read the IHDR dimensions from a plain PNG so the UI can show them without decoding pixels
        // (PNG signature 8 bytes, then a 4-byte length and the "IHDR" tag, then big-endian width/height).
        int width = 0, height = 0;
        if (bytes.Length >= 24 && bytes[12] == 'I' && bytes[13] == 'H' && bytes[14] == 'D' && bytes[15] == 'R')
        {
            width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
            height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
        }
        return new Ps5ImageData(bytes, width, height, false);
    }
    public static Ps5ImageData FromRgba(byte[] bytes, int width, int height) => new(bytes, width, height, true);
}

public sealed class Ps5TrophySet
{
    public string NpCommunicationId { get; init; } = string.Empty;
    public string Title { get; init; } = string.Empty;
    public string TrophySetVersion { get; init; } = string.Empty;
    public string SelectedLanguage { get; init; } = string.Empty;
    public IReadOnlyList<string> Languages { get; init; } = [];
    public IReadOnlyList<Ps5Trophy> Trophies { get; init; } = [];
    public bool IntegrityValid { get; init; }
}

public sealed class Ps5Trophy
{
    public int Id { get; init; }
    public string Grade { get; init; } = string.Empty;
    public bool Hidden { get; init; }
    public bool HasReward { get; init; }
    public string Name { get; init; } = string.Empty;
    public string Description { get; init; } = string.Empty;
    public string PlatinumTrophyId { get; init; } = string.Empty;
    public string UnlockCondition { get; init; } = string.Empty;
    /// <summary>UDS stat this trophy unlocks from (when the condition references one).</summary>
    public int? UdsStatId { get; init; }
    /// <summary>Pre-scaled trophy icon (40x40 RGBA) decoded on the background thread.</summary>
    public Ps5ImageData? Icon { get; init; }
    /// <summary>The original full-resolution icon PNG, kept for export.</summary>
    public byte[]? IconPng { get; init; }
}

public sealed class Ps5UdsSummary
{
    public string NpCommunicationId { get; init; } = string.Empty;
    public int EnumGroupCount { get; init; }
    public int EventCount { get; init; }
    public int StatCount { get; init; }
    public int ExtractionRuleCount { get; init; }
    public IReadOnlyList<Ps5UdsEvent> Events { get; init; } = [];
    public IReadOnlyList<Ps5UdsStat> Stats { get; init; } = [];
    public IReadOnlyList<Ps5UdsEnumGroup> EnumGroups { get; init; } = [];
    public IReadOnlyList<Ps5UdsRule> Rules { get; init; } = [];
    public bool IntegrityValid { get; init; }
}

public sealed class Ps5UdsProperty
{
    public string Path { get; init; } = string.Empty;
    public string DataType { get; init; } = string.Empty;
    public string ItemType { get; init; } = string.Empty;
    public string MappedProperty { get; init; } = string.Empty;
}

public sealed class Ps5UdsEvent
{
    public string Name { get; init; } = string.Empty;
    public string Type { get; init; } = string.Empty;
    public string DefinitionGroup { get; init; } = string.Empty;
    public IReadOnlyList<Ps5UdsProperty> Properties { get; init; } = [];
    public int PropertyCount => Properties.Count;
}

public sealed class Ps5UdsStat
{
    public int StatId { get; init; }
    public string Name { get; init; } = string.Empty;
    public string DefinitionGroup { get; init; } = string.Empty;
    public string Origin { get; init; } = string.Empty;
    public string DataType { get; init; } = string.Empty;
    public string Aggregation { get; init; } = string.Empty;
    public string SourceId { get; init; } = string.Empty;
    public int EnumId { get; init; }
    public string MinValue { get; init; } = string.Empty;
    public string MaxValue { get; init; } = string.Empty;
    public string InitialValue { get; init; } = string.Empty;
}

public sealed class Ps5UdsEnumGroup
{
    public int EnumId { get; init; }
    public string DefinitionGroup { get; init; } = string.Empty;
    public string SourceId { get; init; } = string.Empty;
    public IReadOnlyList<string> Values { get; init; } = [];
    public int ValueCount => Values.Count;
}

public sealed class Ps5UdsRule
{
    public int RuleId { get; init; }
    public string DefinitionGroup { get; init; } = string.Empty;
    public string SourceId { get; init; } = string.Empty;
    public string EventName { get; init; } = string.Empty;
    public string Condition { get; init; } = string.Empty;
    public string Input { get; init; } = string.Empty;
    public string Convert { get; init; } = string.Empty;
    public int OutputStatId { get; init; }
    public string OutputStatName { get; init; } = string.Empty;
}

public sealed class Ps5PlayGoSummary
{
    public string ContentId { get; init; } = string.Empty;
    public int DefaultScenarioId { get; init; }
    public int HeaderFlags { get; init; }
    public int VersionMajor { get; init; }
    public int VersionMinor { get; init; }

    /// <summary>Diagnostics from the engine reader when its strict parse was rejected (empty when clean).</summary>
    public string Notice { get; init; } = string.Empty;
    public IReadOnlyList<Ps5PlayGoChunk> Chunks { get; init; } = [];
    public IReadOnlyList<Ps5PlayGoScenario> Scenarios { get; init; } = [];
    public IReadOnlyList<Ps5PlayGoFileChunk> Files { get; init; } = [];
}

public sealed class Ps5PlayGoChunk
{
    public int Id { get; init; }
    public string Label { get; init; } = string.Empty;
    public ulong LanguageMask { get; init; }
    public int ExtentCount { get; init; }
    public long TotalBytes { get; init; }
}

public sealed class Ps5PlayGoScenario
{
    public int Id { get; init; }
    public string Label { get; init; } = string.Empty;
    public int InitialChunkCount { get; init; }
    public IReadOnlyList<int> Chunks { get; init; } = [];
}

public sealed class Ps5PlayGoFileChunk
{
    public ulong PathHash { get; init; }
    public string Path { get; init; } = string.Empty;
    public int ChunkId { get; init; }
}

public sealed class Ps5SelfInfo
{
    /// <summary>True when eboot.bin is a SELF/FSELF container; false for a plain ELF file.</summary>
    public bool IsSelf { get; init; }
    public string SelfMagic { get; init; } = string.Empty;
    public long FileSize { get; init; }
    public long ElfOffset { get; init; }
    public byte ElfClass { get; init; }
    public byte Endianness { get; init; }
    public ushort ElfType { get; init; }
    public ushort Machine { get; init; }
    public ulong EntryPoint { get; init; }
    public ushort ProgramHeaderCount { get; init; }
    public ushort SectionHeaderCount { get; init; }
    public IReadOnlyList<Ps5ModuleInfo> Modules { get; init; } = [];

    // SELF container header (present when eboot.bin is a SELF).
    public byte SelfVersion { get; init; }
    public uint SelfProgramType { get; init; }
    public ushort SelfHeaderSize { get; init; }
    public ushort SelfMetadataSize { get; init; }
    public ulong SelfDeclaredFileSize { get; init; }
    public ushort SelfSegmentCount { get; init; }
    public ushort SelfFlags { get; init; }
    public IReadOnlyList<Ps5SelfSegment> SelfSegments { get; init; } = [];
    public IReadOnlyList<Ps5ElfProgramHeader> ProgramHeaders { get; init; } = [];
    public IReadOnlyList<Ps5ElfSectionHeader> SectionHeaders { get; init; } = [];
}

public sealed class Ps5SelfSegment
{
    public int Index { get; init; }
    public ulong Flags { get; init; }
    public long FileOffset { get; init; }
    public long FileSize { get; init; }
    public long MemorySize { get; init; }
}

public sealed class Ps5ElfProgramHeader
{
    public int Index { get; init; }
    public uint Type { get; init; }
    public uint Flags { get; init; }
    public long Offset { get; init; }
    public ulong VirtualAddress { get; init; }
    public ulong PhysicalAddress { get; init; }
    public long FileSize { get; init; }
    public long MemorySize { get; init; }
    public ulong Align { get; init; }
}

public sealed class Ps5ElfSectionHeader
{
    public int Index { get; init; }
    public uint Name { get; init; }
    public uint Type { get; init; }
    public ulong Flags { get; init; }
    public ulong Address { get; init; }
    public long Offset { get; init; }
    public long Size { get; init; }
}

public sealed class Ps5ModuleInfo
{
    public string Name { get; init; } = string.Empty;
    public string RelativePath { get; init; } = string.Empty;
    public long Size { get; init; }
    public string Kind { get; init; } = string.Empty;
}

public sealed class Ps5FileInventory
{
    public long TotalSize { get; init; }
    public int FileCount { get; init; }
    public IReadOnlyList<Ps5FileInfo> Files { get; init; } = [];
    public IReadOnlyList<Ps5FileInfo> LargestFiles { get; init; } = [];
}

public sealed class Ps5FileInfo
{
    public string RelativePath { get; init; } = string.Empty;
    public string Extension { get; init; } = string.Empty;
    /// <summary>Where the file came from: PFS, CNT, Host, exFAT, UFS2 or PFSC.</summary>
    public string Origin { get; init; } = string.Empty;
    public long Size { get; init; }
    public long Offset { get; init; }
    public uint? PackageEntryId { get; init; }
    public bool IsEncrypted { get; init; }
}
