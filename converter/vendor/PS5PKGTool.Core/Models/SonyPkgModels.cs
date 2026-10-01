using PS5PKGTool.Core.Parsers;

namespace PS5PKGTool.Core.Models;

public enum SonyPkgKind
{
    MetadataContainer,
    FinalizedDebug,
    FinalizedPatch,
    FinalizedRetail
}

public sealed class SonyPkgSummary
{
    public SonyPkgKind Kind { get; init; }
    public long FileSize { get; init; }
    public byte? SignedByte { get; init; }
    public ushort? FormatVersion { get; init; }
    public ulong PfsImageOffset { get; init; }
    public ulong PfsImageSize { get; init; }
    public ulong PfsSuperblockOffset { get; init; }
    public ulong EmbeddedCntOffset { get; init; }
    public uint HeaderFlags { get; init; }
    public ushort SystemEntryCount { get; init; }
    public ulong BodyOffset { get; init; }
    public ulong BodySize { get; init; }
    public string ContentId { get; init; } = string.Empty;
    public uint DrmType { get; init; }
    public uint ContentType { get; init; }
    public uint ContentFlags { get; init; }
    public IReadOnlyList<SonyPkgEntry> Entries { get; init; } = [];
    public IReadOnlyList<SonyPkgSegment> Segments { get; init; } = [];
    public SonyPfsSummary? NestedPfs { get; init; }

    public int EncryptedEntryCount => Entries.Count(entry => entry.IsEncrypted);
    public string KindDisplayName => Kind switch
    {
        SonyPkgKind.MetadataContainer => "PS5 CNT metadata",
        SonyPkgKind.FinalizedDebug => "FPKG",
        SonyPkgKind.FinalizedPatch => "Patch PKG",
        SonyPkgKind.FinalizedRetail => "Retail PKG",
        _ => "PS5 PKG"
    };
}

public enum SonyPfsAccessState
{
    NotPresent,
    PlaintextIndexed,
    EncryptedKeyRequired,
    UnsupportedLayout,
    Invalid
}

public sealed class SonyPfsSummary
{
    public SonyPfsAccessState AccessState { get; init; }
    public long ImageOffset { get; init; }
    public long ImageSize { get; init; }
    public long Version { get; init; }
    public long Magic { get; init; }
    public ushort Mode { get; init; }
    public uint BlockSize { get; init; }
    public long InodeCount { get; init; }
    public long DataBlockCount { get; init; }
    public bool IsSigned => (Mode & 0x0001) != 0;
    public bool Uses64BitInodes => (Mode & 0x0002) != 0;
    public bool IsEncrypted => (Mode & 0x0004) != 0;
    public string StatusMessage { get; init; } = string.Empty;
    public IReadOnlyList<SonyPfsEntry> Files { get; init; } = [];
    internal SonyPfsCryptoContext? CryptoContext { get; init; }
    internal SonyEnginePackageAccess? EngineAccess { get; init; }
}

public sealed class SonyPfsEntry
{
    public string RelativePath { get; init; } = string.Empty;
    public long Size { get; init; }
    public long StoredSize { get; init; }
    public uint Flags { get; init; }
    public IReadOnlyList<SonyPfsExtent> Extents { get; init; } = [];
    public bool IsCompressed => (Flags & 0x00000001) != 0;
    public bool UsesPlainDataSector { get; init; }
}

public readonly record struct SonyPfsExtent(long Offset, long Length);

internal sealed record SonyPfsCryptoContext(byte[] DataKey, byte[] TweakKey, int BlockSize);

public sealed class SonyPkgEntry
{
    public uint Id { get; init; }
    public uint NameTableOffset { get; init; }
    public uint Flags1 { get; init; }
    public uint Flags2 { get; init; }
    public uint DataOffset { get; init; }
    public uint DataSize { get; init; }
    public string Name { get; internal set; } = string.Empty;

    public bool IsEncrypted => (Flags1 & 0x80000000u) != 0;
    public int KeyIndex => (int)((Flags2 >> 12) & 0x0F);

    /// <summary>Stored size: encrypted payloads are 16-byte padded, plaintext entries are stored as-is.</summary>
    public long StoredSize => IsEncrypted ? (long)((DataSize + 15u) & ~15u) : DataSize;
    public string DisplayName => string.IsNullOrWhiteSpace(Name) ? $"entry_0x{Id:X4}.bin" : Name;
}

public sealed record SonyPkgSegment(string Name, long Offset, long Size);
