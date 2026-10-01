using ProsperoPkgTool.Containers;

namespace PS5PKGTool.Core.Services;

/// <summary>Outcome of opening a package with the canonical reader.</summary>
public sealed record PackageReaderVerificationResult(int FileCount, string? EbootPath)
{
    public bool HasEboot => EbootPath is not null;
}

/// <summary>
/// Opens a package with the one canonical engine reader (the same reader used to browse and extract
/// packages) so both builders are held to a single acceptance criterion.
/// </summary>
public static class PackageReaderVerification
{
    /// <summary>
    /// Reconstructs the inner filesystem index and reports the file count plus the path of
    /// <c>eboot.bin</c> when present. Throws when the package cannot be decoded at all.
    /// </summary>
    public static PackageReaderVerificationResult Inspect(string packagePath, string? passcode)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packagePath);
        using ProsperoFileBackedPackage package =
            ProsperoPackageContent.ReadFileBacked(packagePath, string.IsNullOrEmpty(passcode) ? null : passcode);

        int fileCount = 0;
        string? ebootPath = null;
        foreach (ProsperoInnerPfsReader.Entry entry in package.Entries)
        {
            if (entry.IsDirectory)
                continue;
            fileCount++;
            if (ebootPath is not null)
                continue;
            string path = entry.Path.Replace('\\', '/').TrimStart('/');
            if (path.Equals("eboot.bin", StringComparison.OrdinalIgnoreCase) ||
                path.EndsWith("/eboot.bin", StringComparison.OrdinalIgnoreCase))
                ebootPath = entry.Path;
        }
        return new PackageReaderVerificationResult(fileCount, ebootPath);
    }
}
