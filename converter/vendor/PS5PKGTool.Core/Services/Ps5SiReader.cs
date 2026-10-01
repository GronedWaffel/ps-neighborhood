using System.IO.Compression;

namespace PS5PKGTool.Core.Services;

public sealed record Ps5SiMember(string Name, long Size);

/// <summary>
/// Lists the members of a package's plaintext SI (system information) segment, which is a ZIP
/// archive holding metadata such as pfsimage.xml and npbind.dat.
/// </summary>
public static class Ps5SiReader
{
    private const int MaximumSiBytes = 64 * 1024 * 1024;

    public static IReadOnlyList<Ps5SiMember> List(string packagePath, long offset, long size)
    {
        if (string.IsNullOrWhiteSpace(packagePath) || offset < 0 || size <= 0 || size > MaximumSiBytes) return [];
        try
        {
            using var zip = Open(packagePath, offset, size);
            if (zip is null) return [];
            return zip.Entries
                .Select(entry => new Ps5SiMember(entry.FullName, entry.Length))
                .OrderBy(member => member.Name, StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    /// <summary>Reads a single SI member's bytes by path (case-insensitive suffix match).</summary>
    public static byte[]? ReadMember(string packagePath, long offset, long size, string memberName)
    {
        if (string.IsNullOrWhiteSpace(packagePath) || offset < 0 || size <= 0 || size > MaximumSiBytes) return null;
        try
        {
            using var zip = Open(packagePath, offset, size);
            if (zip is null) return null;
            ZipArchiveEntry? entry = zip.Entries.FirstOrDefault(candidate =>
                candidate.FullName.Equals(memberName, StringComparison.OrdinalIgnoreCase) ||
                candidate.FullName.EndsWith("/" + memberName, StringComparison.OrdinalIgnoreCase) ||
                Path.GetFileName(candidate.FullName).Equals(memberName, StringComparison.OrdinalIgnoreCase));
            if (entry is null) return null;
            using Stream stream = entry.Open();
            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            return memory.ToArray();
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static ZipArchive? Open(string packagePath, long offset, long size)
    {
        var bytes = new byte[checked((int)size)];
        using (var stream = new FileStream(Path.GetFullPath(packagePath), FileMode.Open, FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete))
        {
            stream.Position = offset;
            stream.ReadExactly(bytes);
        }
        var memory = new MemoryStream(bytes, writable: false);
        return new ZipArchive(memory, ZipArchiveMode.Read);
    }
}
