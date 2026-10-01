using System.Buffers.Binary;

namespace PS5PKGTool.Ffpfsc;

/// <summary>Recognised top-level PS5 image container formats.</summary>
public enum Ps5ImageFormat
{
    Unknown,
    Exfat,
    Pfs,
    Ufs2
}

/// <summary>
/// Detects a PS5 image container by its on-disk signature rather than by file extension, so
/// wrapped or renamed payloads (for example a UFS2 payload named without <c>.ffpkg</c>) are still
/// identified correctly.
/// </summary>
public static class Ps5ImageFormatProbe
{
    public const long PfsMagic = 20130315;
    public const uint Ufs2Magic = 0x19540119;
    public const long Ufs2SuperblockOffset = 65536;
    public const int Ufs2MagicOffset = 0x55C;

    public static Ps5ImageFormat Detect(Stream stream)
    {
        ArgumentNullException.ThrowIfNull(stream);
        if (!stream.CanRead || !stream.CanSeek) return Ps5ImageFormat.Unknown;

        long position = stream.Position;
        try
        {
            Span<byte> header = stackalloc byte[16];
            if (stream.Length >= header.Length)
            {
                stream.Position = 0;
                stream.ReadExactly(header);
                if (header[3] == (byte)'E' && header[4] == (byte)'X' && header[5] == (byte)'F' &&
                    header[6] == (byte)'A' && header[7] == (byte)'T')
                    return Ps5ImageFormat.Exfat;
                if (BinaryPrimitives.ReadInt64LittleEndian(header.Slice(8, 8)) == PfsMagic)
                    return Ps5ImageFormat.Pfs;
            }

            Span<byte> magic = stackalloc byte[4];
            long magicOffset = Ufs2SuperblockOffset + Ufs2MagicOffset;
            if (stream.Length >= magicOffset + magic.Length)
            {
                stream.Position = magicOffset;
                stream.ReadExactly(magic);
                if (BinaryPrimitives.ReadUInt32LittleEndian(magic) == Ufs2Magic)
                    return Ps5ImageFormat.Ufs2;
            }

            return Ps5ImageFormat.Unknown;
        }
        finally
        {
            stream.Position = position;
        }
    }

    public static Ps5ImageFormat Detect(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        using var stream = new FileStream(Path.GetFullPath(path), FileMode.Open, FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete);
        return Detect(stream);
    }
}
