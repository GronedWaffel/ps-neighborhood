using PS5PKGTool.Core.Models;
using PS5PKGTool.Core.Parsers;
using PS5PKGTool.Ffpfsc;

namespace PS5PKGTool.Core.Services;

/// <summary>Reads an unpacked PS5 game stored in a raw exFAT filesystem image.</summary>
public sealed class FilesystemImageGameReader
{
    private readonly Ps5ParamReader _paramReader = new();

    public Ps5GameInfo Read(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        string fullPath = Path.GetFullPath(path);
        if (!Path.GetExtension(fullPath).Equals(".exfat", StringComparison.OrdinalIgnoreCase))
            throw new NotSupportedException("This reader accepts raw exFAT images; use FfpkgGameReader for FFPKG images.");
        using var image = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read,
            1024 * 1024, FileOptions.RandomAccess);
        using var volume = new ExfatVolume(image, leaveOpen: true);
        ExfatEntry[] parameters = volume.Entries.Where(entry => !entry.IsDirectory &&
            (entry.Path.Equals("sce_sys/param.json", StringComparison.OrdinalIgnoreCase) ||
             entry.Path.EndsWith("/sce_sys/param.json", StringComparison.OrdinalIgnoreCase))).ToArray();
        if (parameters.Length == 0)
            throw new InvalidDataException("The filesystem image has no sce_sys/param.json.");
        if (parameters.Length > 1)
            throw new InvalidDataException("The filesystem image contains multiple PS5 game roots.");

        ExfatEntry parameter = parameters[0];
        const string suffix = "sce_sys/param.json";
        string virtualRoot = parameter.Path.Length == suffix.Length
            ? string.Empty
            : parameter.Path[..^(suffix.Length + 1)];
        string raw = volume.ReadAllText(parameter.Path);
        var fileInfo = new FileInfo(fullPath);
        Ps5GameInfo game = _paramReader.ReadJson(raw, parameter.Path, fullPath, fileInfo.LastWriteTimeUtc);
        game.SourceKind = Ps5SourceKind.FilesystemImage;
        game.RootPath = fullPath;
        game.ParamPath = parameter.Path;
        game.VirtualRoot = virtualRoot;
        game.SourceSize = fileInfo.Length;
        game.ContainerInnerFileName = fileInfo.Name;
        game.ContainerFileLength = fileInfo.Length;
        game.ContainerLogicalSize = fileInfo.Length; // exFAT logical length equals the image length
        game.ContainerStoredSize = fileInfo.Length;
        return game;
    }

    /// <summary>
    /// Structural inspection that does not require a single readable <c>sce_sys/param.json</c>: returns
    /// the volume metadata and a filename-derived title with warnings. Use only when <see cref="Read"/>
    /// cannot produce a game record, so an unreadable source can still be inspected without inventing
    /// a game.
    /// </summary>
    public Ps5GameInfo ReadStructure(string path)
    {
        string fullPath = Path.GetFullPath(path);
        using var image = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read,
            1024 * 1024, FileOptions.RandomAccess);
        using var volume = new ExfatVolume(image, leaveOpen: true);
        int roots = volume.Entries.Count(entry => !entry.IsDirectory &&
            (entry.Path.Equals("sce_sys/param.json", StringComparison.OrdinalIgnoreCase) ||
             entry.Path.EndsWith("/sce_sys/param.json", StringComparison.OrdinalIgnoreCase)));
        var fileInfo = new FileInfo(fullPath);
        return SourceStructure.Build(Ps5SourceKind.FilesystemImage, fullPath, fileInfo.Name, fileInfo.Length,
            fileInfo.Length, fileInfo.Length, 0, "exFAT filesystem", roots, fileInfo.LastWriteTimeUtc);
    }
}
