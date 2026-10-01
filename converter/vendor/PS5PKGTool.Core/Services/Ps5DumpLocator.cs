namespace PS5PKGTool.Core.Services;

public sealed class Ps5DumpLocator
{
    /// <summary>All candidate sources discovered in one directory walk, grouped by kind.</summary>
    public sealed class LocatedSources
    {
        public List<string> ParamFiles { get; } = [];
        public List<string> Packages { get; } = [];
        public List<string> Ffpfsc { get; } = [];
        public List<string> FilesystemImages { get; } = [];
        public List<string> Ffpkg { get; } = [];
    }

    /// <summary>
    /// Enumerates <paramref name="selectedPath"/> once and classifies every file by extension
    /// (plus <c>sce_sys/param.json</c> loose dumps). Replaces the per-extension walks so a large
    /// library tree is traversed a single time.
    /// </summary>
    public LocatedSources FindAll(string selectedPath, bool recursive, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(selectedPath);
        var found = new LocatedSources();

        if (File.Exists(selectedPath))
        {
            string full = Path.GetFullPath(selectedPath);
            if (Path.GetFileName(full).Equals("eboot.bin", StringComparison.OrdinalIgnoreCase))
            {
                string paramPath = Path.Combine(Path.GetDirectoryName(full)!, "sce_sys", "param.json");
                if (File.Exists(paramPath)) found.ParamFiles.Add(Path.GetFullPath(paramPath));
            }
            else
            {
                Classify(full, found);
            }

            Normalize(found);
            return found;
        }

        if (!Directory.Exists(selectedPath)) return found;

        // A dump root is identified by sce_sys/param.json directly under it; check this explicitly
        // so non-recursive scans still pick up a dump passed as the selected folder.
        string directParam = Path.Combine(selectedPath, "sce_sys", "param.json");
        if (File.Exists(directParam)) found.ParamFiles.Add(Path.GetFullPath(directParam));

        var options = new EnumerationOptions
        {
            RecurseSubdirectories = recursive,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.ReparsePoint,
            MatchCasing = MatchCasing.CaseInsensitive
        };
        foreach (string path in Directory.EnumerateFiles(selectedPath, "*", options))
        {
            cancellationToken.ThrowIfCancellationRequested();
            Classify(Path.GetFullPath(path), found);
        }

        Normalize(found);
        return found;
    }

    private static void Classify(string fullPath, LocatedSources found)
    {
        string name = Path.GetFileName(fullPath);
        if (name.Equals("param.json", StringComparison.OrdinalIgnoreCase))
        {
            string? sceSys = Path.GetDirectoryName(fullPath);
            if (sceSys is not null && Path.GetFileName(sceSys).Equals("sce_sys", StringComparison.OrdinalIgnoreCase))
                found.ParamFiles.Add(fullPath);
            return;
        }

        string extension = Path.GetExtension(fullPath);
        if (extension.Equals(".pkg", StringComparison.OrdinalIgnoreCase)) found.Packages.Add(fullPath);
        else if (extension.Equals(".ffpfsc", StringComparison.OrdinalIgnoreCase)) found.Ffpfsc.Add(fullPath);
        else if (extension.Equals(".exfat", StringComparison.OrdinalIgnoreCase)) found.FilesystemImages.Add(fullPath);
        else if (extension.Equals(".ffpkg", StringComparison.OrdinalIgnoreCase)) found.Ffpkg.Add(fullPath);
    }

    private static void Normalize(LocatedSources found)
    {
        Deduplicate(found.ParamFiles);
        Deduplicate(found.Packages);
        Deduplicate(found.Ffpfsc);
        Deduplicate(found.FilesystemImages);
        Deduplicate(found.Ffpkg);
    }

    private static void Deduplicate(List<string> paths)
    {
        if (paths.Count < 2) return;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        paths.RemoveAll(path => !seen.Add(path));
        paths.Sort(StringComparer.OrdinalIgnoreCase);
    }

    public IReadOnlyList<string> FindFfpfscFiles(string selectedPath, bool recursive,
        CancellationToken cancellationToken = default) => FindFiles(selectedPath, recursive, ".ffpfsc", cancellationToken);

    public IReadOnlyList<string> FindFilesystemImageFiles(string selectedPath, bool recursive,
        CancellationToken cancellationToken = default) => FindFiles(selectedPath, recursive, ".exfat", cancellationToken);

    public IReadOnlyList<string> FindFfpkgFiles(string selectedPath, bool recursive,
        CancellationToken cancellationToken = default) => FindFiles(selectedPath, recursive, ".ffpkg", cancellationToken);

    public IReadOnlyList<string> FindPackageFiles(string selectedPath, bool recursive, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(selectedPath);
        if (File.Exists(selectedPath))
            return Path.GetExtension(selectedPath).Equals(".pkg", StringComparison.OrdinalIgnoreCase)
                ? [Path.GetFullPath(selectedPath)]
                : [];
        if (!Directory.Exists(selectedPath)) return [];

        var options = new EnumerationOptions
        {
            RecurseSubdirectories = recursive,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.ReparsePoint,
            MatchCasing = MatchCasing.CaseInsensitive
        };
        var results = new List<string>();
        foreach (string path in Directory.EnumerateFiles(selectedPath, "*.pkg", options))
        {
            cancellationToken.ThrowIfCancellationRequested();
            results.Add(Path.GetFullPath(path));
        }
        results.Sort(StringComparer.OrdinalIgnoreCase);
        return results;
    }

    private static IReadOnlyList<string> FindFiles(string selectedPath, bool recursive, string extension,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(selectedPath);
        if (File.Exists(selectedPath))
            return Path.GetExtension(selectedPath).Equals(extension, StringComparison.OrdinalIgnoreCase)
                ? [Path.GetFullPath(selectedPath)]
                : [];
        if (!Directory.Exists(selectedPath)) return [];
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = recursive,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.ReparsePoint,
            MatchCasing = MatchCasing.CaseInsensitive
        };
        var results = new List<string>();
        foreach (string path in Directory.EnumerateFiles(selectedPath, "*" + extension, options))
        {
            cancellationToken.ThrowIfCancellationRequested();
            results.Add(Path.GetFullPath(path));
        }
        results.Sort(StringComparer.OrdinalIgnoreCase);
        return results;
    }

    public IReadOnlyList<string> FindParamFiles(string selectedPath, bool recursive, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(selectedPath);
        var results = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (File.Exists(selectedPath))
        {
            string fileName = Path.GetFileName(selectedPath);
            string? parentDirectory = Path.GetDirectoryName(selectedPath);
            if (fileName.Equals("param.json", StringComparison.OrdinalIgnoreCase) &&
                parentDirectory is not null &&
                Path.GetFileName(parentDirectory).Equals("sce_sys", StringComparison.OrdinalIgnoreCase))
                results.Add(Path.GetFullPath(selectedPath));
            else if (fileName.Equals("eboot.bin", StringComparison.OrdinalIgnoreCase))
                AddDirect(parentDirectory!, results);
            return results.ToArray();
        }
        if (!Directory.Exists(selectedPath)) return [];

        AddDirect(selectedPath, results);
        if (!recursive || results.Count > 0) return results.ToArray();

        var options = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.ReparsePoint,
            MatchCasing = MatchCasing.CaseInsensitive
        };
        foreach (string file in Directory.EnumerateFiles(selectedPath, "param.json", options))
        {
            cancellationToken.ThrowIfCancellationRequested();
            string? parentDirectory = Path.GetDirectoryName(file);
            if (parentDirectory is not null &&
                Path.GetFileName(parentDirectory).Equals("sce_sys", StringComparison.OrdinalIgnoreCase))
                results.Add(Path.GetFullPath(file));
        }
        return results.Order(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static void AddDirect(string root, HashSet<string> results)
    {
        string paramPath = Path.Combine(root, "sce_sys", "param.json");
        if (File.Exists(paramPath)) results.Add(Path.GetFullPath(paramPath));
    }
}
