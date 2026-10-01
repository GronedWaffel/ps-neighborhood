using PS5PKGTool.Core.Models;
using PS5PKGTool.Core.Parsers;
using UFS2Tool;

namespace PS5PKGTool.Core.Services;

/// <summary>Reads a PS5 game stored in a raw UFS2 FFPKG image.</summary>
public sealed class FfpkgGameReader
{
    private readonly Ps5ParamReader _paramReader = new();

    public Ps5GameInfo Read(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        string fullPath = Path.GetFullPath(path);
        if (!Path.GetExtension(fullPath).Equals(".ffpkg", StringComparison.OrdinalIgnoreCase))
            throw new NotSupportedException("The selected file is not an FFPKG image.");
        using var volume = new Ufs2Volume(fullPath);
        Ufs2VolumeEntry[] parameters = volume.Entries.Where(entry => !entry.IsDirectory &&
            (entry.Path.Equals("sce_sys/param.json", StringComparison.OrdinalIgnoreCase) ||
             entry.Path.EndsWith("/sce_sys/param.json", StringComparison.OrdinalIgnoreCase))).ToArray();
        if (parameters.Length == 0) throw new InvalidDataException("The FFPKG has no sce_sys/param.json.");
        if (parameters.Length > 1) throw new InvalidDataException("The FFPKG contains multiple PS5 game roots.");
        Ufs2VolumeEntry parameter = parameters[0];
        const string suffix = "sce_sys/param.json";
        string virtualRoot = parameter.Path.Length == suffix.Length
            ? string.Empty
            : parameter.Path[..^(suffix.Length + 1)];
        string raw = volume.ReadAllText(parameter.Path);
        var info = new FileInfo(fullPath);
        Ps5GameInfo game = _paramReader.ReadJson(raw, parameter.Path, fullPath, info.LastWriteTimeUtc);
        game.SourceKind = Ps5SourceKind.Ffpkg;
        game.RootPath = fullPath;
        game.ParamPath = parameter.Path;
        game.VirtualRoot = virtualRoot;
        game.SourceSize = info.Length;
        game.ContainerInnerFileName = info.Name;
        game.ContainerFileLength = info.Length;
        game.ContainerLogicalSize = info.Length; // UFS2 logical length equals the image length
        game.ContainerStoredSize = info.Length;
        return game;
    }

    /// <summary>Structure-only inspection when no single readable sce_sys/param.json exists.</summary>
    public Ps5GameInfo ReadStructure(string path)
    {
        string fullPath = Path.GetFullPath(path);
        using var volume = new Ufs2Volume(fullPath);
        int roots = volume.Entries.Count(entry => !entry.IsDirectory &&
            (entry.Path.Equals("sce_sys/param.json", StringComparison.OrdinalIgnoreCase) ||
             entry.Path.EndsWith("/sce_sys/param.json", StringComparison.OrdinalIgnoreCase)));
        var info = new FileInfo(fullPath);
        return SourceStructure.Build(Ps5SourceKind.Ffpkg, fullPath, info.Name, info.Length, info.Length,
            info.Length, 0, "UFS2 filesystem", roots, info.LastWriteTimeUtc);
    }
}
