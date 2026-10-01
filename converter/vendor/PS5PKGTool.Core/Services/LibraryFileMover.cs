using PS5PKGTool.Core.Tasks;

namespace PS5PKGTool.Core.Services;

/// <summary>
/// Moves files and folders for the library organizer. Same volume is a fast rename; across volumes
/// it copies to a partial path, verifies, moves it into place, and only then deletes the source.
/// A failure or cancellation removes the partial copy and leaves the source intact.
/// </summary>
public static class LibraryFileMover
{
    public static bool SameVolume(string left, string right) =>
        string.Equals(Path.GetPathRoot(Path.GetFullPath(left)), Path.GetPathRoot(Path.GetFullPath(right)),
            StringComparison.OrdinalIgnoreCase);

    public static void Move(string source, string target, CancellationToken cancellationToken,
        IProgress<PackageTaskProgress>? progress = null)
    {
        bool isDirectory = Directory.Exists(source);
        if (SameVolume(source, target))
        {
            if (isDirectory) Directory.Move(source, target);
            else File.Move(source, target);
            return;
        }

        if (isDirectory) MoveDirectoryAcrossVolumes(source, target, cancellationToken, progress);
        else MoveFileAcrossVolumes(source, target);
    }

    public static void CopyDirectory(string source, string destination, CancellationToken cancellationToken,
        IProgress<PackageTaskProgress>? progress = null)
    {
        Directory.CreateDirectory(destination);
        foreach (string file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            cancellationToken.ThrowIfCancellationRequested();
            string relative = Path.GetRelativePath(source, file);
            string target = Path.Combine(destination, relative);
            string? parent = Path.GetDirectoryName(target);
            if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
            File.Copy(file, target, overwrite: false);
            File.SetLastWriteTimeUtc(target, File.GetLastWriteTimeUtc(file));
            progress?.Report(new PackageTaskProgress("Copying", 0, 0, 0, 0, 0, 0, relative));
        }
    }

    private static void MoveFileAcrossVolumes(string source, string target)
    {
        string temporary = target + ".partial-" + Guid.NewGuid().ToString("N");
        try
        {
            File.Copy(source, temporary, overwrite: false);
            if (new FileInfo(temporary).Length != new FileInfo(source).Length)
                throw new IOException("The copied file size does not match the source.");
            File.Move(temporary, target, overwrite: false);
            File.Delete(source);
        }
        catch
        {
            TryDeleteFile(temporary);
            throw;
        }
    }

    private static void MoveDirectoryAcrossVolumes(string source, string target, CancellationToken cancellationToken,
        IProgress<PackageTaskProgress>? progress)
    {
        string temporary = target + ".partial-" + Guid.NewGuid().ToString("N");
        try
        {
            CopyDirectory(source, temporary, cancellationToken, progress);
            Directory.Move(temporary, target);
            Directory.Delete(source, recursive: true);
        }
        catch
        {
            TryDeleteDirectory(temporary);
            throw;
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
