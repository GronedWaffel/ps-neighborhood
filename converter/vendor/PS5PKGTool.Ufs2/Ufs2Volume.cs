// PS5-specific bounded read façade for the BSD-licensed UFS2Tool core.
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace UFS2Tool;

public sealed record Ufs2VolumeEntry(
    string Path,
    string Name,
    uint InodeNumber,
    bool IsDirectory,
    bool IsSymlink,
    long Size,
    ushort Mode,
    uint Uid,
    uint Gid,
    long ModifiedTime);

public sealed record Ufs2VerificationResult(
    string ImagePath,
    long ImageSize,
    string Format,
    string VolumeName,
    int BlockSize,
    int FragmentSize,
    int FileCount,
    int DirectoryCount,
    long LogicalFileBytes,
    string ManifestSha256,
    int FsckErrors,
    int FsckWarnings);

public sealed record Ufs2Progress(string Stage, long Completed, long Total, string Unit = "bytes")
{
    public long BytesProcessed => Completed;
    public long TotalBytes => Total;
}

public enum Ufs2EditKind
{
    ReplaceFile,
    AddFile,
    AddDirectory,
    AddDirectoryTree,
    Delete
}

public sealed record Ufs2EditOperation(Ufs2EditKind Kind, string ImagePath, string? SourcePath = null)
{
    public static Ufs2EditOperation Replace(string imagePath, string sourcePath) =>
        new(Ufs2EditKind.ReplaceFile, imagePath, sourcePath);
    public static Ufs2EditOperation AddFile(string imagePath, string sourcePath) =>
        new(Ufs2EditKind.AddFile, imagePath, sourcePath);
    public static Ufs2EditOperation AddDirectory(string imagePath) =>
        new(Ufs2EditKind.AddDirectory, imagePath);
    public static Ufs2EditOperation AddDirectoryTree(string imagePath, string sourcePath) =>
        new(Ufs2EditKind.AddDirectoryTree, imagePath, sourcePath);
    public static Ufs2EditOperation Delete(string imagePath) => new(Ufs2EditKind.Delete, imagePath);
}

public sealed record Ufs2EditResult(Ufs2VerificationResult Verification, int OperationCount);

/// <summary>Read-only, path-safe UFS2 volume with streaming file access.</summary>
public sealed class Ufs2Volume : IDisposable
{
    private const int MaximumEntries = 2_000_000;
    private const int MaximumDepth = 256;
    private readonly Ufs2Image _image;
    private readonly Stream? _stream;
    private readonly object _streamSync = new();
    private readonly Dictionary<string, Ufs2VolumeEntry> _byPath = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<Ufs2VolumeEntry> _entries = [];
    private bool _disposed;

    public Ufs2Volume(string imagePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(imagePath);
        ImagePath = Path.GetFullPath(imagePath);
        _image = new Ufs2Image(ImagePath, readOnly: true);
        try
        {
            if (!_image.Superblock.IsUfs2)
                throw new InvalidDataException("FFPKG requires a UFS2 filesystem; this image is not UFS2.");
            ValidateGeometry(_image.Superblock, new FileInfo(ImagePath).Length);
            var visitedDirectories = new HashSet<uint>();
            ReadDirectory(string.Empty, Ufs2Constants.RootInode, visitedDirectories, 0);
        }
        catch
        {
            _image.Dispose();
            throw;
        }
    }

    public Ufs2Volume(Stream stream, string imageName = "UFS2 stream", bool leaveOpen = false)
    {
        ArgumentNullException.ThrowIfNull(stream);
        ImagePath = imageName;
        _stream = stream;
        _image = new Ufs2Image(stream, imageName, leaveOpen);
        try
        {
            if (!_image.Superblock.IsUfs2)
                throw new InvalidDataException("FFPKG requires a UFS2 filesystem; this image is not UFS2.");
            ValidateGeometry(_image.Superblock, stream.Length);
            var visitedDirectories = new HashSet<uint>();
            ReadDirectory(string.Empty, Ufs2Constants.RootInode, visitedDirectories, 0);
        }
        catch
        {
            _image.Dispose();
            throw;
        }
    }

    public string ImagePath { get; }
    public Ufs2Superblock Superblock => _image.Superblock;
    public IReadOnlyList<Ufs2VolumeEntry> Entries => _entries;

    public Ufs2VolumeEntry? Find(string path)
    {
        ThrowIfDisposed();
        _byPath.TryGetValue(NormalizePath(path), out Ufs2VolumeEntry? entry);
        return entry;
    }

    public Stream OpenFile(string path)
    {
        Ufs2VolumeEntry entry = Find(path) ?? throw new FileNotFoundException("The UFS2 file was not found.", path);
        if (entry.IsDirectory) throw new IOException("The requested UFS2 entry is a directory.");
        Ufs2Inode inode = _image.ReadInode(entry.InodeNumber);
        if (inode.IsSymlink && inode.Size <= 1024 * 1024)
            return new MemoryStream(_image.ReadFile(entry.InodeNumber), writable: false);
        if (!inode.IsRegularFile) throw new NotSupportedException("Only regular UFS2 files can be streamed.");
        return _stream is null
            ? new Ufs2FileStream(ImagePath, Superblock, inode)
            : new Ufs2FileStream(_stream, Superblock, inode, _streamSync, leaveOpen: true);
    }

    public byte[] ReadAllBytes(string path, int maximumBytes = 256 * 1024 * 1024)
    {
        Ufs2VolumeEntry entry = Find(path) ?? throw new FileNotFoundException("The UFS2 file was not found.", path);
        if (entry.IsDirectory) throw new IOException("The requested UFS2 entry is a directory.");
        if (entry.Size < 0 || entry.Size > maximumBytes || entry.Size > int.MaxValue)
            throw new IOException($"The UFS2 file is too large to load into memory: {entry.Path}");
        using Stream input = OpenFile(path);
        byte[] result = new byte[checked((int)entry.Size)];
        input.ReadExactly(result);
        return result;
    }

    public string ReadAllText(string path, Encoding? encoding = null, int maximumBytes = 16 * 1024 * 1024) =>
        (encoding ?? new UTF8Encoding(false, true)).GetString(ReadAllBytes(path, maximumBytes));

    private void ReadDirectory(string parent, uint inodeNumber, HashSet<uint> visited, int depth)
    {
        if (depth > MaximumDepth) throw new InvalidDataException("The UFS2 directory depth exceeds the safety limit.");
        if (!visited.Add(inodeNumber)) throw new InvalidDataException("The UFS2 directory graph contains a cycle.");
        foreach (Ufs2DirectoryEntry child in _image.ListDirectory(inodeNumber))
        {
            if (child.Name is "." or "..") continue;
            ValidateName(child.Name);
            Ufs2Inode inode = _image.ReadInode(child.Inode);
            bool isDirectory = inode.IsDirectory;
            bool isSymlink = inode.IsSymlink;
            if (!isDirectory && !inode.IsRegularFile && !isSymlink) continue;
            if (inode.Size < 0) throw new InvalidDataException("A UFS2 inode has a negative size.");
            string path = parent.Length == 0 ? child.Name : parent + '/' + child.Name;
            var entry = new Ufs2VolumeEntry(path, child.Name, child.Inode, isDirectory, isSymlink, inode.Size,
                inode.Mode, inode.Uid, inode.Gid, inode.ModTime);
            if (!_byPath.TryAdd(path, entry)) throw new InvalidDataException($"Duplicate UFS2 path: {path}");
            _entries.Add(entry);
            if (_entries.Count > MaximumEntries) throw new InvalidDataException("The UFS2 entry count exceeds the safety limit.");
            if (isDirectory) ReadDirectory(path, child.Inode, visited, depth + 1);
        }
    }

    private static void ValidateGeometry(Ufs2Superblock sb, long imageLength)
    {
        if (sb.BSize is < 4096 or > 65536 || (sb.BSize & (sb.BSize - 1)) != 0 ||
            sb.FSize < 512 || sb.FSize > sb.BSize || (sb.FSize & (sb.FSize - 1)) != 0 ||
            sb.FragsPerBlock != sb.BSize / sb.FSize || sb.NumCylGroups <= 0 || sb.InodesPerGroup <= 0 ||
            sb.TotalBlocks <= 0 || sb.TotalBlocks > imageLength / sb.FSize)
            throw new InvalidDataException("The UFS2 superblock geometry is invalid.");
    }

    private static string NormalizePath(string path) => path.Replace('\\', '/').Trim('/');
    private static void ValidateName(string name)
    {
        if (string.IsNullOrEmpty(name) || name.Length > Ufs2Constants.MaxNameLen || name.Contains('/') ||
            name.Contains('\\') || name.IndexOf('\0') >= 0)
            throw new InvalidDataException("A UFS2 directory contains an unsafe filename.");
    }
    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);
    public void Dispose()
    {
        if (_disposed) return;
        _image.Dispose();
        _disposed = true;
    }
}

public static class Ufs2Operations
{
    private const int BufferSize = 1024 * 1024;

    public static Task<Ufs2VerificationResult> VerifyAsync(string imagePath,
        IProgress<Ufs2Progress>? progress = null, CancellationToken cancellationToken = default) =>
        Task.Run(() => Verify(imagePath, progress, cancellationToken), cancellationToken);

    public static async Task ExtractAsync(string imagePath, string outputDirectory,
        IProgress<Ufs2Progress>? progress = null, CancellationToken cancellationToken = default)
    {
        string destination = Path.GetFullPath(outputDirectory);
        if (Directory.Exists(destination) || File.Exists(destination))
            throw new IOException($"The extraction destination already exists: {destination}");
        string temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            Directory.CreateDirectory(temporary);
            using var volume = new Ufs2Volume(imagePath);
            foreach (Ufs2VolumeEntry directory in volume.Entries.Where(entry => entry.IsDirectory)
                         .OrderBy(entry => entry.Path.Count(value => value == '/')))
                Directory.CreateDirectory(ResolveOutput(temporary, directory.Path));
            Ufs2VolumeEntry[] files = volume.Entries.Where(entry => !entry.IsDirectory)
                .OrderBy(entry => entry.Path, StringComparer.OrdinalIgnoreCase).ToArray();
            long total = files.Sum(entry => entry.Size);
            long copied = 0;
            byte[] buffer = new byte[BufferSize];
            foreach (Ufs2VolumeEntry file in files)
            {
                cancellationToken.ThrowIfCancellationRequested();
                string target = ResolveOutput(temporary, file.Path);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                using Stream input = volume.OpenFile(file.Path);
                await using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                    BufferSize, FileOptions.Asynchronous | FileOptions.SequentialScan);
                while (true)
                {
                    int read = await input.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                    if (read == 0) break;
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                    copied += read;
                    progress?.Report(new Ufs2Progress("Extracting FFPKG", copied, total));
                }
            }
            Directory.Move(temporary, destination);
        }
        catch
        {
            TryDeleteDirectory(temporary);
            throw;
        }
    }

    public static async Task<Ufs2VerificationResult> CreateFromDirectoryAsync(string sourceDirectory,
        string outputPath, string? volumeName = null, IProgress<Ufs2Progress>? progress = null,
        CancellationToken cancellationToken = default, int blockSize = 32768, int fragmentSize = 4096,
        int bytesPerInode = 262144, int minFreePercent = 0)
    {
        string source = Path.GetFullPath(sourceDirectory);
        string output = Path.GetFullPath(outputPath);
        if (!Directory.Exists(source)) throw new DirectoryNotFoundException(source);
        if (File.Exists(output)) throw new IOException($"The output file already exists: {output}");
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        string temporary = output + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            progress?.Report(new Ufs2Progress("Creating UFS2 FFPKG", 0, 1));
            await Task.Run(() =>
            {
                cancellationToken.ThrowIfCancellationRequested();
                var diagnostics = new StringWriter();
                var creator = new Ufs2ImageCreator
                {
                    FilesystemFormat = 2,
                    SectorSize = 4096,
                    BlockSize = blockSize,
                    FragmentSize = fragmentSize,
                    BytesPerInode = bytesPerInode,
                    SizeSlackPercent = 2.0,
                    SizeSlackBytes = 2 * 1024 * 1024,
                    MinFreePercent = minFreePercent,
                    SoftUpdates = false,
                    SoftUpdatesJournal = false,
                    OptimizationPreference = "space",
                    NoSnapDir = true,
                    VolumeName = SanitizeVolumeName(volumeName),
                    Output = diagnostics,
                    ErrorOutput = diagnostics,
                    CancellationToken = cancellationToken,
                    Progress = (stage, completed, total, unit) =>
                        progress?.Report(new Ufs2Progress(stage, completed, total, unit))
                };
                try
                {
                    creator.CreateImageFromDirectory(temporary, source);
                }
                catch (InvalidOperationException ex) when (IsImageTooSmall(ex))
                {
                    // The auto-size estimate can fall short of the real per-cylinder-group metadata
                    // overhead on large trees, so retry with progressively larger images instead of
                    // failing a long conversion. The size escalates by 25% per attempt, up to 3 times.
                    var (_, diskSize, entries) = Ufs2ImageCreator.CalculateDirectorySizes(
                        source, creator.BlockSize, creator.FragmentSize, creator.FilesystemFormat);
                    long size = creator.CalculateImageSizeWithCgOverhead(diskSize, entries);
                    bool succeeded = false;
                    for (int attempt = 0; attempt < 3 && !succeeded; attempt++)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        // Grow 25% and keep the size a whole number of fragments (CreateImage requires it).
                        long grown = size * 5 / 4;
                        size = (grown + creator.FragmentSize - 1) / creator.FragmentSize * creator.FragmentSize;
                        progress?.Report(new Ufs2Progress("Retrying FFPKG with a larger image", 0, 1));
                        TryDeleteFile(temporary);
                        try
                        {
                            creator.CreateImageFromDirectory(temporary, source, size);
                            succeeded = true;
                        }
                        catch (InvalidOperationException retryEx) when (IsImageTooSmall(retryEx))
                        {
                            // Try again with a larger image.
                        }
                    }
                    if (!succeeded)
                        throw new InvalidOperationException(
                            ex.Message + Environment.NewLine +
                            "FFPKG creation still ran out of space after retrying with larger images." +
                            Environment.NewLine + diagnostics, ex);
                }
                cancellationToken.ThrowIfCancellationRequested();
            }, cancellationToken).ConfigureAwait(false);
            Ufs2VerificationResult verification = await VerifyAsync(temporary, progress, cancellationToken)
                .ConfigureAwait(false);
            await VerifySourceMatchesImageAsync(source, temporary, verification, progress, cancellationToken)
                .ConfigureAwait(false);
            File.Move(temporary, output);
            return verification with { ImagePath = output };
        }
        catch
        {
            TryDeleteFile(temporary);
            throw;
        }
    }

    /// <summary>True when the UFS2 creator ran out of cylinder groups or inodes (image too small).</summary>
    private static bool IsImageTooSmall(Exception exception) =>
        exception is InvalidOperationException &&
        exception.Message.Contains("Image is too small", StringComparison.Ordinal);

    public static async Task<Ufs2VerificationResult> RebuildWithEditsAsync(string imagePath,
        Action<string> editStaging, IProgress<Ufs2Progress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(editStaging);
        return await RebuildWithEditsAsync(imagePath, (staging, token) =>
        {
            token.ThrowIfCancellationRequested();
            editStaging(staging);
            token.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        }, progress, cancellationToken).ConfigureAwait(false);
    }

    public static async Task<Ufs2VerificationResult> RebuildWithEditsAsync(string imagePath,
        Func<string, CancellationToken, Task> editStaging, IProgress<Ufs2Progress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(editStaging);
        string image = Path.GetFullPath(imagePath);
        string parent = Path.GetDirectoryName(image) ?? throw new IOException("The FFPKG has no parent directory.");
        string token = Guid.NewGuid().ToString("N");
        string staging = Path.Combine(parent, ".PS5PKGTool-ffpkg-edit-" + token);
        string replacement = image + "." + token + ".rebuild";
        string backup = image + "." + token + ".backup";
        string volumeName;
        using (var volume = new Ufs2Volume(image)) volumeName = volume.Superblock.VolumeName;
        try
        {
            await ExtractAsync(image, staging, progress, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            await editStaging(staging, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            _ = await CreateFromDirectoryAsync(staging, replacement, volumeName, progress, cancellationToken)
                .ConfigureAwait(false);
            File.Move(image, backup);
            try
            {
                File.Move(replacement, image);
                Ufs2VerificationResult verified = await VerifyAsync(image, progress, cancellationToken)
                    .ConfigureAwait(false);
                TryDeleteFile(backup);
                return verified;
            }
            catch
            {
                if (File.Exists(image)) File.Delete(image);
                if (File.Exists(backup)) File.Move(backup, image);
                throw;
            }
        }
        finally
        {
            TryDeleteDirectory(staging);
            TryDeleteFile(replacement);
        }
    }

    public static async Task<Ufs2EditResult> ApplyEditsAsync(string imagePath,
        IReadOnlyList<Ufs2EditOperation> operations, IProgress<Ufs2Progress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(operations);
        if (operations.Count == 0) throw new ArgumentException("At least one FFPKG edit is required.", nameof(operations));
        ValidateEditSources(operations);
        Ufs2VerificationResult verification = await RebuildWithEditsAsync(imagePath,
            (staging, token) => ApplyStagedEditsAsync(staging, operations, progress, token), progress,
            cancellationToken).ConfigureAwait(false);
        return new Ufs2EditResult(verification, operations.Count);
    }

    public static string NormalizeImagePath(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        string normalized = path.Replace('\\', '/').Trim('/');
        string[] components = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (components.Length == 0 || components.Any(component => component is "." or ".." ||
                component.IndexOf('\0') >= 0 || component.Length > Ufs2Constants.MaxNameLen))
            throw new ArgumentException("The FFPKG path is empty or unsafe.", nameof(path));
        return string.Join('/', components);
    }

    private static void ValidateEditSources(IReadOnlyList<Ufs2EditOperation> operations)
    {
        foreach (Ufs2EditOperation operation in operations)
        {
            _ = NormalizeImagePath(operation.ImagePath);
            if (operation.Kind is Ufs2EditKind.AddFile or Ufs2EditKind.ReplaceFile)
            {
                if (string.IsNullOrWhiteSpace(operation.SourcePath) || !File.Exists(operation.SourcePath))
                    throw new FileNotFoundException("The FFPKG edit source file does not exist.", operation.SourcePath);
            }
            else if (operation.Kind == Ufs2EditKind.AddDirectoryTree &&
                     (string.IsNullOrWhiteSpace(operation.SourcePath) || !Directory.Exists(operation.SourcePath)))
                throw new DirectoryNotFoundException(operation.SourcePath);
        }
    }

    private static async Task ApplyStagedEditsAsync(string staging,
        IReadOnlyList<Ufs2EditOperation> operations, IProgress<Ufs2Progress>? progress,
        CancellationToken cancellationToken)
    {
        for (int index = 0; index < operations.Count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Ufs2EditOperation operation = operations[index];
            string target = ResolveOutput(staging, NormalizeImagePath(operation.ImagePath));
            progress?.Report(new Ufs2Progress($"Applying FFPKG edit {index + 1:N0} of {operations.Count:N0}",
                index, operations.Count, "operations"));
            switch (operation.Kind)
            {
                case Ufs2EditKind.ReplaceFile:
                    if (!File.Exists(target)) throw new FileNotFoundException("The file to replace is not in the FFPKG.", operation.ImagePath);
                    await CopyFileAtomicAsync(operation.SourcePath!, target, overwrite: true, cancellationToken)
                        .ConfigureAwait(false);
                    break;
                case Ufs2EditKind.AddFile:
                    if (File.Exists(target) || Directory.Exists(target))
                        throw new IOException($"The FFPKG target already exists: {operation.ImagePath}");
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    await CopyFileAtomicAsync(operation.SourcePath!, target, overwrite: false, cancellationToken)
                        .ConfigureAwait(false);
                    break;
                case Ufs2EditKind.AddDirectory:
                    if (File.Exists(target)) throw new IOException($"A file already occupies: {operation.ImagePath}");
                    Directory.CreateDirectory(target);
                    break;
                case Ufs2EditKind.AddDirectoryTree:
                    if (File.Exists(target) || Directory.Exists(target))
                        throw new IOException($"The FFPKG target already exists: {operation.ImagePath}");
                    await CopyDirectoryTreeAsync(operation.SourcePath!, target, cancellationToken).ConfigureAwait(false);
                    break;
                case Ufs2EditKind.Delete:
                    if (File.Exists(target)) File.Delete(target);
                    else if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
                    else throw new FileNotFoundException("The FFPKG entry to delete was not found.", operation.ImagePath);
                    break;
                default:
                    throw new ArgumentOutOfRangeException(nameof(operation.Kind));
            }
        }
    }

    private static async Task CopyFileAtomicAsync(string source, string target, bool overwrite,
        CancellationToken cancellationToken)
    {
        string temporary = target + "." + Guid.NewGuid().ToString("N") + ".copy";
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        try
        {
            await using (var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read,
                             BufferSize, FileOptions.Asynchronous | FileOptions.SequentialScan))
            await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                             BufferSize, FileOptions.Asynchronous | FileOptions.SequentialScan))
                await input.CopyToAsync(output, BufferSize, cancellationToken).ConfigureAwait(false);
            File.Move(temporary, target, overwrite);
        }
        finally
        {
            TryDeleteFile(temporary);
        }
    }

    private static async Task CopyDirectoryTreeAsync(string source, string target,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(target);
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = false,
            AttributesToSkip = FileAttributes.ReparsePoint,
            ReturnSpecialDirectories = false
        };
        foreach (string directory in Directory.EnumerateDirectories(source, "*", options))
        {
            cancellationToken.ThrowIfCancellationRequested();
            Directory.CreateDirectory(Path.Combine(target, Path.GetRelativePath(source, directory)));
        }
        foreach (string file in Directory.EnumerateFiles(source, "*", options))
        {
            cancellationToken.ThrowIfCancellationRequested();
            string destination = Path.Combine(target, Path.GetRelativePath(source, file));
            await CopyFileAtomicAsync(file, destination, overwrite: false, cancellationToken).ConfigureAwait(false);
        }
    }

    private static Ufs2VerificationResult Verify(string imagePath, IProgress<Ufs2Progress>? progress,
        CancellationToken cancellationToken)
    {
        string fullPath = Path.GetFullPath(imagePath);
        using var volume = new Ufs2Volume(fullPath);
        Ufs2VolumeEntry[] files = volume.Entries.Where(entry => !entry.IsDirectory)
            .OrderBy(entry => entry.Path, StringComparer.Ordinal).ToArray();
        long total = files.Sum(entry => entry.Size);
        long copied = 0;
        using IncrementalHash manifest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        byte[] buffer = new byte[BufferSize];
        byte[] size = new byte[8];
        foreach (Ufs2VolumeEntry file in files)
        {
            cancellationToken.ThrowIfCancellationRequested();
            manifest.AppendData(Encoding.UTF8.GetBytes(file.Path));
            manifest.AppendData([0]);
            BinaryPrimitives.WriteInt64LittleEndian(size, file.Size);
            manifest.AppendData(size);
            using Stream input = volume.OpenFile(file.Path);
            while (true)
            {
                int read = input.Read(buffer, 0, buffer.Length);
                if (read == 0) break;
                manifest.AppendData(buffer, 0, read);
                copied += read;
                progress?.Report(new Ufs2Progress("Verifying FFPKG", copied, total));
                cancellationToken.ThrowIfCancellationRequested();
            }
        }
        using var fsckImage = new Ufs2Image(fullPath, readOnly: true);
        Ufs2Image.FsckResult fsck = fsckImage.FsckUfs(preen: false, debug: false);
        int errors = fsck.Errors.Count;
        int warnings = fsck.Warnings.Count;
        if (errors > 0) throw new InvalidDataException($"UFS2 fsck reported {errors:N0} error(s).");
        Ufs2Superblock sb = volume.Superblock;
        return new Ufs2VerificationResult(fullPath, new FileInfo(fullPath).Length, "UFS2", sb.VolumeName,
            sb.BSize, sb.FSize, files.Length, volume.Entries.Count(entry => entry.IsDirectory) + 1, total,
            Convert.ToHexString(manifest.GetHashAndReset()).ToLowerInvariant(), errors, warnings);
    }

    private static async Task VerifySourceMatchesImageAsync(string sourceDirectory, string imagePath,
        Ufs2VerificationResult imageVerification, IProgress<Ufs2Progress>? progress,
        CancellationToken cancellationToken)
    {
        string source = Path.GetFullPath(sourceDirectory);
        var sourceFiles = new List<(string Path, string FullPath, long Size)>();
        var sourceDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pending = new Stack<string>();
        pending.Push(source);
        while (pending.Count > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string directory = pending.Pop();
            foreach (FileSystemInfo entry in new DirectoryInfo(directory).EnumerateFileSystemInfos("*",
                         SearchOption.TopDirectoryOnly))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if ((entry.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new IOException($"The source dump contains an unsupported reparse point: {entry.FullName}");
                string relative = NormalizeManifestPath(Path.GetRelativePath(source, entry.FullName));
                if (entry is DirectoryInfo child)
                {
                    if (!sourceDirectories.Add(relative))
                        throw new IOException($"The source dump contains a duplicate directory path: {relative}");
                    pending.Push(child.FullName);
                }
                else if (entry is FileInfo file)
                {
                    sourceFiles.Add((relative, file.FullName, file.Length));
                    if (sourceFiles.Count > 2_000_000)
                        throw new IOException("The source dump exceeds the supported file-count limit.");
                }
            }
        }

        using (var volume = new Ufs2Volume(imagePath))
        {
            var imageFiles = volume.Entries.Where(entry => !entry.IsDirectory)
                .ToDictionary(entry => entry.Path, StringComparer.OrdinalIgnoreCase);
            var imageDirectories = volume.Entries.Where(entry => entry.IsDirectory)
                .Select(entry => entry.Path).ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (imageFiles.Count != sourceFiles.Count)
                throw new InvalidDataException(
                    $"Source comparison failed: the dump has {sourceFiles.Count:N0} files but the FFPKG has {imageFiles.Count:N0}.");
            if (!sourceDirectories.SetEquals(imageDirectories))
                throw new InvalidDataException("Source comparison failed: the FFPKG directory paths differ from the dump.");
            foreach ((string path, _, long size) in sourceFiles)
            {
                if (!imageFiles.TryGetValue(path, out Ufs2VolumeEntry? entry))
                    throw new InvalidDataException($"Source comparison failed: the FFPKG is missing {path}.");
                if (entry.Size != size)
                    throw new InvalidDataException(
                        $"Source comparison failed: {path} is {size:N0} bytes in the dump and {entry.Size:N0} bytes in the FFPKG.");
            }
        }

        sourceFiles.Sort((left, right) => StringComparer.Ordinal.Compare(left.Path, right.Path));
        long total = sourceFiles.Sum(file => file.Size);
        long hashed = 0;
        byte[] buffer = new byte[BufferSize];
        byte[] sizeBytes = new byte[8];
        using IncrementalHash manifest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach ((string path, string fullPath, long size) in sourceFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            manifest.AppendData(Encoding.UTF8.GetBytes(path));
            manifest.AppendData([0]);
            BinaryPrimitives.WriteInt64LittleEndian(sizeBytes, size);
            manifest.AppendData(sizeBytes);
            await using var input = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read,
                BufferSize, FileOptions.Asynchronous | FileOptions.SequentialScan);
            while (true)
            {
                int read = await input.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (read == 0) break;
                manifest.AppendData(buffer, 0, read);
                hashed += read;
                progress?.Report(new Ufs2Progress("Comparing source with FFPKG", hashed, total));
            }
        }
        string sourceManifest = Convert.ToHexString(manifest.GetHashAndReset()).ToLowerInvariant();
        if (!sourceManifest.Equals(imageVerification.ManifestSha256, StringComparison.Ordinal))
            throw new InvalidDataException("Source comparison failed: at least one FFPKG file differs from the dump.");
        progress?.Report(new Ufs2Progress("Source and FFPKG match", total, total));
    }

    private static string NormalizeManifestPath(string path) => path.Replace('\\', '/').Trim('/');

    private static string ResolveOutput(string root, string relativePath)
    {
        string full = Path.GetFullPath(Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar)));
        string prefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("A UFS2 extraction path leaves the destination.");
        return full;
    }
    private static string SanitizeVolumeName(string? value)
    {
        string result = new((value ?? string.Empty).Where(character => character is >= ' ' and <= '~').Take(31).ToArray());
        return result;
    }
    private static void TryDeleteFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

internal sealed class Ufs2FileStream : Stream
{
    private readonly Stream _image;
    private readonly Ufs2Superblock _superblock;
    private readonly Ufs2Inode _inode;
    private readonly object _sync;
    private readonly bool _leaveOpen;
    private readonly Dictionary<long, byte[]> _pointerBlocks = [];
    private long _position;

    public Ufs2FileStream(string imagePath, Ufs2Superblock superblock, Ufs2Inode inode)
    {
        _image = new FileStream(imagePath, FileMode.Open, FileAccess.Read, FileShare.Read,
            1024 * 1024, FileOptions.RandomAccess);
        _superblock = superblock;
        _inode = inode;
        _sync = new object();
    }
    public Ufs2FileStream(Stream image, Ufs2Superblock superblock, Ufs2Inode inode, object sync,
        bool leaveOpen)
    {
        _image = image;
        _superblock = superblock;
        _inode = inode;
        _sync = sync;
        _leaveOpen = leaveOpen;
    }
    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => _inode.Size;
    public override long Position
    {
        get => _position;
        set
        {
            if (value < 0 || value > Length) throw new ArgumentOutOfRangeException(nameof(value));
            _position = value;
        }
    }
    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
    public override int Read(Span<byte> destination)
    {
        int total = checked((int)Math.Min(destination.Length, Length - _position));
        int copied = 0;
        while (copied < total)
        {
            long logicalBlock = _position / _superblock.BSize;
            int withinBlock = checked((int)(_position % _superblock.BSize));
            int count = Math.Min(total - copied, _superblock.BSize - withinBlock);
            long fragment = ResolveDataFragment(logicalBlock);
            if (fragment == 0) destination.Slice(copied, count).Clear();
            else
            {
                long imageOffset = checked(fragment * _superblock.FSize + withinBlock);
                if (imageOffset < 0 || imageOffset + count > _image.Length)
                    throw new InvalidDataException("A UFS2 data pointer leaves the image.");
                lock (_sync)
                {
                    _image.Position = imageOffset;
                    _image.ReadExactly(destination.Slice(copied, count));
                }
            }
            copied += count;
            _position += count;
        }
        return copied;
    }
    private long ResolveDataFragment(long logicalBlock)
    {
        if (logicalBlock < Ufs2Constants.NDirect) return _inode.DirectBlocks[logicalBlock];
        long index = logicalBlock - Ufs2Constants.NDirect;
        int pointers = _superblock.BSize / (_superblock.IsUfs1 ? 4 : 8);
        if (index < pointers) return ReadPointer(_inode.IndirectBlocks[0], index);
        index -= pointers;
        long doubleCapacity = checked((long)pointers * pointers);
        if (index < doubleCapacity)
        {
            long first = ReadPointer(_inode.IndirectBlocks[1], index / pointers);
            return ReadPointer(first, index % pointers);
        }
        index -= doubleCapacity;
        long tripleCapacity = checked(doubleCapacity * pointers);
        if (index >= tripleCapacity) throw new IOException("The UFS2 file exceeds triple-indirect addressing.");
        long firstLevel = ReadPointer(_inode.IndirectBlocks[2], index / doubleCapacity);
        long remainder = index % doubleCapacity;
        long secondLevel = ReadPointer(firstLevel, remainder / pointers);
        return ReadPointer(secondLevel, remainder % pointers);
    }
    private long ReadPointer(long fragment, long index)
    {
        if (fragment == 0) return 0;
        if (!_pointerBlocks.TryGetValue(fragment, out byte[]? block))
        {
            long offset = checked(fragment * _superblock.FSize);
            if (offset < 0 || offset + _superblock.BSize > _image.Length)
                throw new InvalidDataException("A UFS2 indirect block leaves the image.");
            block = new byte[_superblock.BSize];
            lock (_sync)
            {
                _image.Position = offset;
                _image.ReadExactly(block);
            }
            if (_pointerBlocks.Count >= 64) _pointerBlocks.Remove(_pointerBlocks.Keys.First());
            _pointerBlocks[fragment] = block;
        }
        int pointerSize = _superblock.IsUfs1 ? 4 : 8;
        int offsetInBlock = checked((int)index * pointerSize);
        if (offsetInBlock < 0 || offsetInBlock + pointerSize > block.Length)
            throw new InvalidDataException("A UFS2 indirect pointer index is invalid.");
        return pointerSize == 4
            ? BinaryPrimitives.ReadInt32LittleEndian(block.AsSpan(offsetInBlock, 4))
            : BinaryPrimitives.ReadInt64LittleEndian(block.AsSpan(offsetInBlock, 8));
    }
    public override long Seek(long offset, SeekOrigin origin)
    {
        long target = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => checked(_position + offset),
            SeekOrigin.End => checked(Length + offset),
            _ => throw new ArgumentOutOfRangeException(nameof(origin))
        };
        Position = target;
        return target;
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing && !_leaveOpen) _image.Dispose();
        base.Dispose(disposing);
    }
    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
