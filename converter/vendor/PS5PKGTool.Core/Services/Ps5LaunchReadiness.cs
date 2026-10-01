using System.Buffers.Binary;

namespace PS5PKGTool.Core.Services;

public enum Ps5ModuleAuthority { Unknown, Elf, Self }
public sealed record Ps5LaunchModule(string RelativePath, Ps5ModuleAuthority Authority, string Message);
public sealed class Ps5LaunchReadinessReport
{
    public required bool IsReady { get; init; }
    public required IReadOnlyList<string> Errors { get; init; }
    public required IReadOnlyList<string> Warnings { get; init; }
    public required IReadOnlyList<Ps5LaunchModule> Modules { get; init; }
}

public static class Ps5LaunchReadiness
{
    public static Ps5LaunchReadinessReport Inspect(string gameDirectory)
    {
        string root = Path.GetFullPath(gameDirectory);
        if (!Directory.Exists(root)) throw new DirectoryNotFoundException(root);
        var errors = new List<string>(); var warnings = new List<string>(); var modules = new List<Ps5LaunchModule>();
        if (!File.Exists(Path.Combine(root, "sce_sys", "param.json"))) errors.Add("sce_sys/param.json is missing.");
        if (File.Exists(Path.Combine(root, "sce_sys", "param.sfo"))) warnings.Add("param.sfo is present; PS5 debug packages use param.json.");
        string eboot = Path.Combine(root, "eboot.bin");
        if (!File.Exists(eboot)) errors.Add("eboot.bin is missing.");
        foreach (string path in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
                     .Where(path => new[] { ".bin", ".elf", ".prx", ".sprx", ".self" }.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase)))
        {
            string relative = Path.GetRelativePath(root, path).Replace('\\', '/');
            Ps5ModuleAuthority authority = Detect(path);
            string message = authority switch { Ps5ModuleAuthority.Elf => "Plain ELF requires fake SELF conversion for launch.", Ps5ModuleAuthority.Self => "SELF container detected.", _ => "Unknown executable container." };
            modules.Add(new Ps5LaunchModule(relative, authority, message));
            if (authority == Ps5ModuleAuthority.Elf) warnings.Add(relative + " is a plain ELF.");
            if (authority == Ps5ModuleAuthority.Unknown && (relative.Equals("eboot.bin", StringComparison.OrdinalIgnoreCase) || Path.GetExtension(relative) != ".bin")) errors.Add(relative + " has an unknown executable container.");
        }
        return new Ps5LaunchReadinessReport { IsReady = errors.Count == 0 && modules.All(module => module.Authority == Ps5ModuleAuthority.Self), Errors = errors, Warnings = warnings, Modules = modules };
    }
    private static Ps5ModuleAuthority Detect(string path)
    {
        Span<byte> header = stackalloc byte[4];
        using var stream = File.OpenRead(path); if (stream.Read(header) != 4) return Ps5ModuleAuthority.Unknown;
        if (header[0] == 0x7F && header[1] == 0x45 && header[2] == 0x4C && header[3] == 0x46) return Ps5ModuleAuthority.Elf;
        return BinaryPrimitives.ReadUInt32BigEndian(header) is 0x4F154C06 or 0x4F154C07 ? Ps5ModuleAuthority.Self : Ps5ModuleAuthority.Unknown;
    }
}
