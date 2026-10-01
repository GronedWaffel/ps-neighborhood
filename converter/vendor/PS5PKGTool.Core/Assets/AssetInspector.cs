using System.Buffers.Binary;
using System.Text;

namespace PS5PKGTool.Core.Assets;

public enum AssetCategory
{
    Unknown,
    Image,
    Text,
    Audio,
    Video
}

public readonly record struct AssetMetadata(string Name, string Value);

public sealed record AssetInspection(
    AssetCategory Category,
    string Format,
    string Description,
    IReadOnlyList<AssetMetadata> Metadata)
{
    public static AssetInspection Unknown(string description) =>
        new(AssetCategory.Unknown, "Binary", description, []);
}

/// <summary>
/// Clean-room, dependency-free asset sniffing for the file browser: identifies common image, audio,
/// text, and video payloads from their magic bytes (falling back to the extension) and extracts a
/// few cheap metadata fields. PS5-specific compressed texture formats are intentionally left as raw.
/// </summary>
public static class AssetInspector
{
    public static AssetInspection Inspect(string fileName, ReadOnlySpan<byte> head)
    {
        string extension = Path.GetExtension(fileName).ToLowerInvariant();

        if (StartsWith(head, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) && head.Length >= 24)
            return Image("PNG", head, BinaryPrimitives.ReadUInt32BigEndian(head[16..20]),
                BinaryPrimitives.ReadUInt32BigEndian(head[20..24]));
        if (StartsWith(head, [0xFF, 0xD8, 0xFF]))
            return Image("JPEG", head, 0, 0);
        if (StartsWith(head, "GIF87a"u8) || StartsWith(head, "GIF89a"u8))
            return Image("GIF", head, 0, 0);
        if (StartsWith(head, "BM"u8) && head.Length >= 26)
        {
            int width = BinaryPrimitives.ReadInt32LittleEndian(head[18..22]);
            int height = BinaryPrimitives.ReadInt32LittleEndian(head[22..26]);
            return Image("BMP", head, (uint)Math.Max(0, width), (uint)Math.Max(0, height));
        }
        if (StartsWith(head, "DDS "u8) && head.Length >= 20)
        {
            uint height = BinaryPrimitives.ReadUInt32LittleEndian(head[12..16]);
            uint width = BinaryPrimitives.ReadUInt32LittleEndian(head[16..20]);
            string fourCc = head.Length >= 88 ? Encoding.ASCII.GetString(head[84..88]).Trim('\0', ' ') : string.Empty;
            var metadata = new List<AssetMetadata>
            {
                new("Width", width.ToString()),
                new("Height", height.ToString())
            };
            if (fourCc.Length > 0) metadata.Add(new("Format", fourCc));
            return new AssetInspection(AssetCategory.Image, "DDS", "DirectDraw surface", metadata);
        }
        if (StartsWith(head, "RIFF"u8) && head.Length >= 12 && StartsWith(head[8..], "WAVE"u8))
        {
            var metadata = new List<AssetMetadata>();
            if (head.Length >= 28)
            {
                metadata.Add(new("Channels", BinaryPrimitives.ReadUInt16LittleEndian(head[22..24]).ToString()));
                metadata.Add(new("Sample rate", BinaryPrimitives.ReadUInt32LittleEndian(head[24..28]).ToString()));
            }
            if (head.Length >= 36) metadata.Add(new("Bits", BinaryPrimitives.ReadUInt16LittleEndian(head[34..36]).ToString()));
            return new AssetInspection(AssetCategory.Audio, "WAV", "Waveform audio", metadata);
        }
        if (StartsWith(head, "OggS"u8))
            return new AssetInspection(AssetCategory.Audio, "OGG", "Ogg audio", []);
        if (extension == ".at9")
            return new AssetInspection(AssetCategory.Audio, "AT9", "ATRAC9 audio", []);
        if (StartsWith(head, "ID3"u8) || StartsWith(head, [0xFF, 0xFB]))
            return new AssetInspection(AssetCategory.Audio, "MP3", "MPEG audio", []);

        if (LooksLikeText(extension, head))
        {
            string format = extension switch
            {
                ".json" => "JSON",
                ".xml" => "XML",
                ".txt" => "Text",
                ".ini" => "INI",
                ".csv" => "CSV",
                ".sfo" => "SFO",
                _ => "Text"
            };
            return new AssetInspection(AssetCategory.Text, format, "Text document", []);
        }

        return AssetInspection.Unknown(string.IsNullOrEmpty(extension) ? "Binary file" : extension.TrimStart('.').ToUpperInvariant() + " file");
    }

    private static AssetInspection Image(string format, ReadOnlySpan<byte> head, uint width, uint height)
    {
        var metadata = new List<AssetMetadata>();
        if (width > 0) metadata.Add(new("Width", width.ToString()));
        if (height > 0) metadata.Add(new("Height", height.ToString()));
        return new AssetInspection(AssetCategory.Image, format, format + " image", metadata);
    }

    private static bool LooksLikeText(string extension, ReadOnlySpan<byte> head)
    {
        if (extension is ".json" or ".xml" or ".txt" or ".ini" or ".cfg" or ".csv" or ".log" or ".md" or ".sfo" or ".yml" or ".yaml")
            return true;
        if (head.Length == 0) return false;
        int printable = 0;
        int inspected = Math.Min(head.Length, 512);
        for (int index = 0; index < inspected; index++)
        {
            byte value = head[index];
            if (value is 0x09 or 0x0A or 0x0D || value is >= 0x20 and < 0x7F || value >= 0x80) printable++;
            else if (value == 0) return false;
        }
        return printable >= inspected * 0.9;
    }

    private static bool StartsWith(ReadOnlySpan<byte> source, ReadOnlySpan<byte> prefix) =>
        source.Length >= prefix.Length && source[..prefix.Length].SequenceEqual(prefix);
}
