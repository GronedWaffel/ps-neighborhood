using System.Buffers.Binary;
using PS5PKGTool.Core.Models;
using ProsperoPkgTool.Containers;

namespace PS5PKGTool.Core.Parsers;

/// <summary>
/// Reads the public CNT/FIH metadata layer of a Sony PS5 package. Parsing is delegated to the
/// vendored, validated <c>ProsperoPkgTool</c> engine; this type only maps the engine inspection
/// onto PS5PKGTool's public package model.
/// </summary>
public sealed class SonyPkgReader
{
    private const int BlockSize = 0x10000;
    private const int CntHeaderSize = 0x5A0;
    private const int FihHeaderProbeSize = 0x60;

    private static ReadOnlySpan<byte> CntMagic => [0x7F, (byte)'C', (byte)'N', (byte)'T'];
    private static ReadOnlySpan<byte> FihMagic => [0x7F, (byte)'F', (byte)'I', (byte)'H'];

    public bool IsSonyPackage(string path)
    {
        try
        {
            using FileStream stream = Open(path);
            Span<byte> magic = stackalloc byte[4];
            if (stream.Length < magic.Length || stream.Read(magic) != magic.Length) return false;
            return magic.SequenceEqual(CntMagic) || magic.SequenceEqual(FihMagic);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return false; }
    }

    public SonyPkgSummary Read(string path) => Read(path, null);

    public SonyPkgSummary Read(string path, string? debugPasscode)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        string fullPath = Path.GetFullPath(path);
        long fileSize = new FileInfo(fullPath).Length;
        if (fileSize < 4) throw new InvalidDataException("The file is too small to be a PS5 package.");

        ProsperoPackageInspection inspection;
        try
        {
            inspection = ProsperoPackageReader.Read(fullPath);
        }
        catch (InvalidDataException)
        {
            // Metadata-less finalized images (CntOffset at/after EOF, e.g. retail disc PKGs) are
            // rejected by the engine inspection; describe them from the FIH header alone.
            if (TryReadHeaderOnly(fullPath, fileSize, out SonyPkgSummary? headerOnly)) return headerOnly!;
            throw;
        }

        SonyEnginePackageAccess access = SonyEnginePackageAccess.FromInspection(fullPath, inspection, debugPasscode);

        return new SonyPkgSummary
        {
            Kind = MapKind(inspection.Kind),
            FileSize = fileSize,
            SignedByte = inspection.Fih?.SignedByte,
            FormatVersion = inspection.Fih?.FormatVersion,
            PfsImageOffset = inspection.Fih?.PfsOffset ?? 0,
            PfsImageSize = inspection.Fih?.PfsSize ?? 0,
            EmbeddedCntOffset = inspection.Fih?.CntOffset ?? 0,
            HeaderFlags = inspection.Cnt.Flags,
            SystemEntryCount = inspection.Cnt.ScEntryCount,
            BodyOffset = inspection.Cnt.BodyOffset,
            BodySize = inspection.Cnt.BodySize,
            ContentId = inspection.Cnt.ContentId ?? string.Empty,
            DrmType = inspection.Cnt.DrmType,
            ContentType = inspection.Cnt.ContentType,
            ContentFlags = inspection.Cnt.ContentFlags,
            Entries = inspection.Entries.Select(MapEntry).ToArray(),
            Segments = inspection.Segments.Select(segment => new SonyPkgSegment(segment.Name, segment.Offset, segment.Size)).ToArray(),
            NestedPfs = BuildNestedPfs(access)
        };
    }

    /// <summary>Returns the entry count the engine indexed inside the reconstructed inner image.</summary>
    public int CountIndexedFiles(string path, string? debugPasscode = null)
    {
        using SonyEnginePackageAccess access = SonyEnginePackageAccess.Open(Path.GetFullPath(path), debugPasscode);
        return access.Files.Count();
    }

    public byte[] ReadEntryBytes(string path, SonyPkgSummary package, SonyPkgEntry entry, int maximumBytes)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        ArgumentNullException.ThrowIfNull(package);
        ArgumentNullException.ThrowIfNull(entry);
        if (maximumBytes < 0) throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        if (entry.IsEncrypted)
            throw new InvalidDataException($"PKG entry 0x{entry.Id:X4} is encrypted (key index {entry.KeyIndex}).");
        if (entry.DataSize > maximumBytes)
            throw new InvalidDataException($"PKG entry 0x{entry.Id:X4} is larger than the {maximumBytes:N0}-byte read limit.");

        string fullPath = Path.GetFullPath(path);
        ProsperoPackageInspection inspection = ProsperoPackageReader.Read(fullPath);
        ProsperoCntEntry cntEntry = inspection.Entries.FirstOrDefault(candidate => candidate.Id == entry.Id)
            ?? throw new InvalidDataException($"PKG entry 0x{entry.Id:X4} is not present in the CNT metadata.");
        return ProsperoPackageContent.ReadCntEntry(fullPath, inspection, cntEntry, entry.DataSize);
    }

    private static bool TryReadHeaderOnly(string fullPath, long fileSize, out SonyPkgSummary? summary)
    {
        summary = null;
        if (fileSize < FihHeaderProbeSize) return false;

        byte[] header = new byte[FihHeaderProbeSize];
        using (FileStream stream = Open(fullPath))
        {
            if (stream.Length < header.Length) return false;
            stream.ReadExactly(header);
        }

        if (!header.AsSpan(0, 4).SequenceEqual(FihMagic)) return false;
        ulong cntOffset = BinaryPrimitives.ReadUInt64LittleEndian(header.AsSpan(0x58, 8));
        // Only the metadata-less layout (no embedded CNT header before EOF) is describable from the
        // FIH alone; a compact CNT that simply does not fit is treated the same way, matching the
        // reference reader's bound check.
        if (cntOffset <= (ulong)Math.Max(0, fileSize - CntHeaderSize)) return false;

        byte signedByte = header[0x05];
        SonyPkgKind kind = signedByte switch
        {
            0x00 => SonyPkgKind.FinalizedDebug,
            0x80 => SonyPkgKind.FinalizedRetail,
            _ => throw new InvalidDataException($"Unknown PS5 FIH signed byte 0x{signedByte:X2}.")
        };
        ushort formatVersion = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(0x06, 2));
        ulong pfsOffset = BinaryPrimitives.ReadUInt64LittleEndian(header.AsSpan(0x10, 8));
        ulong pfsSize = BinaryPrimitives.ReadUInt64LittleEndian(header.AsSpan(0x18, 8));
        ulong superblockOffset = BinaryPrimitives.ReadUInt64LittleEndian(header.AsSpan(0x20, 8));

        summary = new SonyPkgSummary
        {
            Kind = kind,
            FileSize = fileSize,
            SignedByte = signedByte,
            FormatVersion = formatVersion,
            PfsImageOffset = pfsOffset,
            PfsImageSize = pfsSize,
            PfsSuperblockOffset = superblockOffset,
            EmbeddedCntOffset = cntOffset,
            Entries = [],
            NestedPfs = pfsSize > 0
                ? new SonyPfsSummary
                {
                    AccessState = kind == SonyPkgKind.FinalizedRetail
                        ? SonyPfsAccessState.EncryptedKeyRequired
                        : SonyPfsAccessState.UnsupportedLayout,
                    ImageOffset = (long)pfsOffset,
                    ImageSize = (long)pfsSize,
                    BlockSize = BlockSize,
                    StatusMessage = "The package has no embedded CNT metadata; the PFS image cannot be read on PC without the matching key."
                }
                : null
        };
        return true;
    }

    private static SonyPfsSummary BuildNestedPfs(SonyEnginePackageAccess access)
    {
        ProsperoFihHeader? fih = access.Inspection.Fih;
        long imageOffset = (long)(fih?.PfsOffset ?? 0);
        long imageSize = (long)(fih?.PfsSize ?? 0);
        if (fih is null || imageSize <= 0)
        {
            return new SonyPfsSummary
            {
                AccessState = SonyPfsAccessState.NotPresent,
                EngineAccess = access,
                StatusMessage = "The package has no embedded PFS image."
            };
        }

        // The inner image is decoded lazily by the engine accessor. Scanning only parses the CNT,
        // so this summary stays cheap and the real state/file list is materialized on selection.
        return new SonyPfsSummary
        {
            AccessState = SonyPfsAccessState.PlaintextIndexed,
            ImageOffset = imageOffset,
            ImageSize = imageSize,
            BlockSize = BlockSize,
            EngineAccess = access,
            StatusMessage = "Inner image, trophies, activities, and files load when the game is selected."
        };
    }

    private static SonyPkgKind MapKind(ProsperoPackageKind kind) => kind switch
    {
        ProsperoPackageKind.MetadataContainer => SonyPkgKind.MetadataContainer,
        ProsperoPackageKind.FinalizedPatchDebug => SonyPkgKind.FinalizedPatch,
        ProsperoPackageKind.FinalizedRetail => SonyPkgKind.FinalizedRetail,
        _ => SonyPkgKind.FinalizedDebug
    };

    private static SonyPkgEntry MapEntry(ProsperoCntEntry entry) => new()
    {
        Id = entry.Id,
        NameTableOffset = entry.NameOffset,
        Flags1 = entry.Flags1,
        Flags2 = entry.Flags2,
        DataOffset = entry.DataOffset,
        DataSize = entry.DataSize,
        Name = entry.DisplayName
    };

    internal static FileStream Open(string path) => new(path, FileMode.Open, FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete, 64 * 1024, FileOptions.RandomAccess);
}
