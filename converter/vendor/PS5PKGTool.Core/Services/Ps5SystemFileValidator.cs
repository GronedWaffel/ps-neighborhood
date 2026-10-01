using System.Text;

namespace PS5PKGTool.Core.Services;

public sealed record Ps5SystemFileValidation(string FileName, bool IsValid, string Identifier, string Message);
public static class Ps5SystemFileValidator
{
    public static Ps5SystemFileValidation Validate(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        return Validate(Path.GetFileName(path), File.ReadAllBytes(path));
    }

    public static Ps5SystemFileValidation Validate(string fileName, ReadOnlySpan<byte> bytes)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(fileName);
        string name = Path.GetFileName(fileName);
        if (name.Equals("npbind.dat", StringComparison.OrdinalIgnoreCase))
        {
            bool magic = bytes.Length >= 4 && bytes[0] == 0x18 && bytes[1] == 0xA0 && bytes[2] == 0x94 && bytes[3] == 0xD2;
            string id = FindNpwr(bytes);
            return new(name, magic && id.Length > 0, id, magic ? (id.Length > 0 ? "NP Communication ID found." : "No NP Communication ID was found.") : "npbind.dat magic is invalid.");
        }
        if (name.Equals("nptitle.dat", StringComparison.OrdinalIgnoreCase))
        {
            bool magic = bytes.Length >= 4 && Encoding.ASCII.GetString(bytes[..4]) == "NPTD";
            string id = FindAscii(bytes, "PPSA", 9);
            return new(name, magic, id, magic ? "nptitle.dat header is valid." : "nptitle.dat magic is invalid.");
        }
        return new(name, bytes.Length > 0, string.Empty, bytes.Length > 0 ? "Non-empty system file." : "The system file is empty.");
    }
    private static string FindNpwr(ReadOnlySpan<byte> bytes) => FindAscii(bytes, "NPWR", 12);
    private static string FindAscii(ReadOnlySpan<byte> bytes, string prefix, int length)
    {
        byte[] marker = Encoding.ASCII.GetBytes(prefix);
        for (int offset = 0; offset <= bytes.Length - marker.Length; offset++)
        {
            if (!bytes.Slice(offset, marker.Length).SequenceEqual(marker)) continue;
            int available = Math.Min(length, bytes.Length - offset);
            string candidate = Encoding.ASCII.GetString(bytes.Slice(offset, available)).TrimEnd('\0');
            if (candidate.All(character => character is >= 'A' and <= 'Z' or >= '0' and <= '9' or '_')) return candidate;
        }
        return string.Empty;
    }
}
