using PS5PKGTool.Core.Models;

namespace PS5PKGTool.Core.Services;

/// <summary>
/// Builds a structure-only game record for a source that has no single readable
/// <c>sce_sys/param.json</c> (missing, or multiple roots). It describes the container/filesystem
/// as observed and records warnings, without inventing game metadata.
/// </summary>
internal static class SourceStructure
{
    public static Ps5GameInfo Build(Ps5SourceKind kind, string fullPath, string innerName, long fileLength,
        long logicalLength, long storedLength, int blockCount, string label, int roots, DateTime lastWriteUtc)
    {
        var game = new Ps5GameInfo
        {
            SourceKind = kind,
            RootPath = fullPath,
            ParamPath = string.Empty,
            VirtualRoot = string.Empty,
            Title = Path.GetFileNameWithoutExtension(fullPath),
            SourceSize = fileLength,
            ContainerInnerFileName = innerName,
            ContainerFileLength = fileLength,
            ContainerLogicalSize = logicalLength,
            ContainerStoredSize = storedLength,
            ContainerBlockCount = blockCount,
            LastWriteTimeUtc = lastWriteUtc
        };
        game.DataWarnings.Add(roots switch
        {
            0 => $"No sce_sys/param.json was found; showing {label} structure only.",
            1 => $"No readable sce_sys/param.json was found; showing {label} structure only.",
            _ => $"{roots} PS5 game roots were found; showing {label} structure only. Select one game root to read its metadata."
        });
        return game;
    }

    /// <summary>
    /// A record for a source that could not be read at all (for example a malformed package), so it
    /// stays visible in the library with its path and error instead of being dropped.
    /// </summary>
    public static Ps5GameInfo Unreadable(Ps5SourceKind kind, string fullPath, string label, string error)
    {
        var file = new FileInfo(fullPath);
        var game = new Ps5GameInfo
        {
            SourceKind = kind,
            RootPath = fullPath,
            Title = Path.GetFileNameWithoutExtension(fullPath),
            SourceSize = file.Exists ? file.Length : 0,
            ContainerFileLength = file.Exists ? file.Length : 0,
            LastWriteTimeUtc = file.Exists ? file.LastWriteTimeUtc : DateTime.MinValue
        };
        game.DataWarnings.Add($"The {label} could not be read: {error}");
        return game;
    }
}
