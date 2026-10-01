using PS5PKGTool.Core.Models;
using PS5PKGTool.Core.Parsers;
using PS5PKGTool.Ffpfsc;

namespace PS5PKGTool.Core.Services;

public sealed class FfpfscGameReader
{
    private readonly Ps5ParamReader _paramReader = new();

    public Ps5GameInfo Read(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        string fullPath = Path.GetFullPath(path);
        using FfpfscVolume volume = FfpfscVolume.Open(fullPath);
        FfpfscVolumeEntry[] parameters = volume.Entries.Where(entry => !entry.IsDirectory &&
            (entry.Path.Equals("sce_sys/param.json", StringComparison.OrdinalIgnoreCase) ||
             entry.Path.EndsWith("/sce_sys/param.json", StringComparison.OrdinalIgnoreCase))).ToArray();
        if (parameters.Length == 0)
            throw new InvalidDataException("The FFPFSC inner filesystem has no sce_sys/param.json.");
        if (parameters.Length > 1)
            throw new InvalidDataException("The FFPFSC image contains multiple PS5 game roots.");

        FfpfscVolumeEntry parameter = parameters[0];
        string suffix = "sce_sys/param.json";
        string virtualRoot = parameter.Path.Length == suffix.Length
            ? string.Empty
            : parameter.Path[..^(suffix.Length + 1)];
        string raw = volume.ReadAllText(parameter.Path);
        Ps5GameInfo game = _paramReader.ReadJson(raw, parameter.Path, fullPath, File.GetLastWriteTimeUtc(fullPath));
        game.SourceKind = Ps5SourceKind.Ffpfsc;
        game.RootPath = fullPath;
        game.ParamPath = parameter.Path;
        game.VirtualRoot = virtualRoot;
        game.SourceSize = new FileInfo(fullPath).Length;
        game.ContainerInnerFileName = volume.Info.InnerFileName;
        game.ContainerFileLength = new FileInfo(fullPath).Length;
        game.ContainerLogicalSize = volume.Info.LogicalLength;
        game.ContainerStoredSize = volume.Info.StoredLength;
        game.ContainerBlockCount = volume.Info.Pfsc.BlockCount;
        return game;
    }

    /// <summary>Structure-only inspection when no single readable sce_sys/param.json exists.</summary>
    public Ps5GameInfo ReadStructure(string path)
    {
        string fullPath = Path.GetFullPath(path);
        using FfpfscVolume volume = FfpfscVolume.Open(fullPath);
        int roots = volume.Entries.Count(entry => !entry.IsDirectory &&
            (entry.Path.Equals("sce_sys/param.json", StringComparison.OrdinalIgnoreCase) ||
             entry.Path.EndsWith("/sce_sys/param.json", StringComparison.OrdinalIgnoreCase)));
        var info = new FileInfo(fullPath);
        return SourceStructure.Build(Ps5SourceKind.Ffpfsc, fullPath, volume.Info.InnerFileName, info.Length,
            volume.Info.LogicalLength, volume.Info.StoredLength, volume.Info.Pfsc.BlockCount,
            "PFSC filesystem", roots, info.LastWriteTimeUtc);
    }
}
