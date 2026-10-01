using PS5PKGTool.Core.Models;
using PS5PKGTool.Core.Parsers;
using PS5PKGTool.Ffpfsc;
using ProsperoPkgTool.Containers;
using UFS2Tool;

namespace PS5PKGTool.Core.Services;

public sealed record GameFileRecord(string RelativePath, long Size, string Origin = "");
public sealed record GameFileChunk(byte[] Data, long Offset, long FileSize)
{
    public bool HasPrevious => Offset > 0;
    public bool HasNext => Offset + Data.LongLength < FileSize;
}

public interface IReadOnlyGameFileSystem : IDisposable
{
    IReadOnlyList<GameFileRecord> Files { get; }
    bool FileExists(string relativePath);
    Stream OpenRead(string relativePath);
}

public static class GameFileSystem
{
    public static IReadOnlyGameFileSystem Open(Ps5GameInfo game, CancellationToken cancellationToken = default) =>
        game.SourceKind switch
        {
            Ps5SourceKind.Ffpfsc => new FfpfscGameFileSystem(game.RootPath, game.VirtualRoot),
            Ps5SourceKind.FilesystemImage => new FilesystemImageGameFileSystem(game.RootPath, game.VirtualRoot),
            Ps5SourceKind.Ffpkg => new FfpkgGameFileSystem(game.RootPath, game.VirtualRoot),
            Ps5SourceKind.SonyPackage => new SonyPackageGameFileSystem(game),
            _ => new LocalGameFileSystem(game.RootPath, cancellationToken)
        };

    public static string NormalizePath(string path) => path.Replace('\\', '/').Trim('/');
    public static string Combine(params string[] segments) =>
        string.Join('/', segments.Select(NormalizePath).Where(segment => segment.Length > 0));

    public static async Task ExtractFileAsync(Ps5GameInfo game, string relativePath, string outputPath,
        IProgress<long>? progress = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(game);
        ArgumentException.ThrowIfNullOrWhiteSpace(relativePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        string normalized = NormalizePath(relativePath);
        string fullOutputPath = Path.GetFullPath(outputPath);
        if (string.Equals(fullOutputPath, game.RootPath, StringComparison.OrdinalIgnoreCase))
            throw new IOException("The extraction output cannot replace the source container.");
        string? outputDirectory = Path.GetDirectoryName(fullOutputPath);
        if (string.IsNullOrEmpty(outputDirectory)) throw new IOException("The extraction output has no directory.");
        Directory.CreateDirectory(outputDirectory);
        string temporaryPath = fullOutputPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using IReadOnlyGameFileSystem files = Open(game, cancellationToken);
            if (!files.FileExists(normalized)) throw new FileNotFoundException("The selected game file was not found.", normalized);
            await using Stream input = files.OpenRead(normalized);
            await using var output = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                1024 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
            byte[] buffer = new byte[1024 * 1024];
            long copied = 0;
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                int read = await input.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (read == 0) break;
                await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                copied += read;
                progress?.Report(copied);
            }
            await output.FlushAsync(cancellationToken).ConfigureAwait(false);
            output.Close();
            File.Move(temporaryPath, fullOutputPath, true);
        }
        catch
        {
            try { File.Delete(temporaryPath); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            throw;
        }
    }

    public static GameFileChunk ReadFileChunk(Ps5GameInfo game, string relativePath, long offset, int count,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(game);
        ArgumentException.ThrowIfNullOrWhiteSpace(relativePath);
        if (offset < 0) throw new ArgumentOutOfRangeException(nameof(offset));
        if (count < 0) throw new ArgumentOutOfRangeException(nameof(count));
        string normalized = NormalizePath(relativePath);
        using IReadOnlyGameFileSystem files = Open(game, cancellationToken);
        if (!files.FileExists(normalized)) throw new FileNotFoundException("The selected game file was not found.", normalized);
        using Stream input = files.OpenRead(normalized);
        if (offset > input.Length) throw new ArgumentOutOfRangeException(nameof(offset));
        input.Position = offset;
        int wanted = checked((int)Math.Min(count, input.Length - offset));
        byte[] data = new byte[wanted];
        int total = 0;
        while (total < wanted)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int read = input.Read(data, total, wanted - total);
            if (read == 0) throw new EndOfStreamException("The selected file ended unexpectedly.");
            total += read;
        }
        return new GameFileChunk(data, offset, input.Length);
    }

    private sealed class SonyPackageGameFileSystem : IReadOnlyGameFileSystem
    {
        private readonly string _path;
        private readonly Dictionary<string, Segment[]> _segments;
        private readonly SonyPfsCryptoContext? _cryptoContext;
        private readonly SonyEnginePackageAccess? _engine;
        private readonly Dictionary<string, (uint Id, long Size)>? _cntEntries;

        public SonyPackageGameFileSystem(Ps5GameInfo game)
        {
            _path = Path.GetFullPath(game.RootPath);
            SonyPkgSummary package = ResolveSonyPackage(game, _path);
            _segments = new Dictionary<string, Segment[]>(StringComparer.OrdinalIgnoreCase);

            if (package.NestedPfs?.EngineAccess is { } engine)
            {
                _engine = engine;

                // Always expose the plaintext CNT content entries (param.json, param.sfo, artwork,
                // trophies, activities...). Real packages keep these in the CNT container rather than
                // the inner PFS, so hiding them whenever the inner image decodes would drop metadata,
                // artwork, and trophies. The inner PFS wins for any path present in both.
                ProsperoInnerPfsReader.Entry[] innerFiles = engine.Files.ToArray();
                if (engine.DecodeError is { } decodeError)
                    throw new InvalidDataException(engine.DecodeUnsupported
                        ? $"This package uses a format this build does not support yet: {decodeError}"
                        : $"Package contents could not be decoded: {decodeError}");
                bool hasInnerTree = innerFiles.Length > 0;

                _cntEntries = new Dictionary<string, (uint Id, long Size)>(StringComparer.OrdinalIgnoreCase);
                foreach ((uint id, string path, long size) in engine.ListReadableEntries())
                {
                    string relative = NormalizePath(path);
                    if (relative.Length == 0) continue;
                    // When a real inner tree is present, merge only logical content paths (for example
                    // sce_sys/...); the container's internal bookkeeping entries (digests, entry-keys,
                    // image-key, metas...) are not files a user browses. Without an inner tree the CNT
                    // is the only source, so everything readable is kept.
                    if (hasInnerTree && !relative.Contains('/')) continue;
                    _cntEntries[relative] = (id, size);
                }

                var records = new Dictionary<string, (long Size, string Origin)>(StringComparer.OrdinalIgnoreCase);
                foreach (ProsperoInnerPfsReader.Entry file in innerFiles)
                {
                    string relative = NormalizePath(engine.ToRelativePath(file));
                    if (relative.Length > 0) records[relative] = (file.Size, "PFS");
                }
                foreach (KeyValuePair<string, (uint Id, long Size)> pair in _cntEntries)
                    records.TryAdd(pair.Key, (pair.Value.Size, "CNT"));

                Files = records
                    .Select(pair => new GameFileRecord(pair.Key, pair.Value.Size, pair.Value.Origin))
                    .OrderBy(file => file.RelativePath, StringComparer.OrdinalIgnoreCase)
                    .ToArray();
                return;
            }

            if (package.NestedPfs?.AccessState == SonyPfsAccessState.PlaintextIndexed)
            {
                _cryptoContext = package.NestedPfs.CryptoContext;
                foreach (SonyPfsEntry file in package.NestedPfs.Files)
                {
                    string path = NormalizePath(file.RelativePath);
                    if (path.Length == 0 || file.Extents.Count == 0 || _segments.ContainsKey(path)) continue;
                    _segments[path] = file.Extents.Select(extent => new Segment(
                        checked((long)package.PfsImageOffset + extent.Offset), extent.Length,
                        package.NestedPfs.BlockSize == 0 ? 0 : checked((int)(extent.Offset / package.NestedPfs.BlockSize)),
                        !file.UsesPlainDataSector,
                        package.NestedPfs.BlockSize == 0 ? 0 : checked((int)(extent.Offset % package.NestedPfs.BlockSize)))).ToArray();
                }
            }
            else
            {
                foreach (SonyPkgEntry entry in package.Entries.Where(entry => !entry.IsEncrypted))
                {
                    string path = NormalizePath(entry.DisplayName);
                    if (path.Length == 0 || _segments.ContainsKey(path)) continue;
                    _segments[path] = [new Segment(checked((long)package.EmbeddedCntOffset + entry.DataOffset), entry.DataSize)];
                }
            }

            Files = _segments.Select(pair => new GameFileRecord(pair.Key, pair.Value.Sum(segment => segment.Length), "CNT"))
                .OrderBy(file => file.RelativePath, StringComparer.OrdinalIgnoreCase).ToArray();
        }

        private static SonyPkgSummary ResolveSonyPackage(Ps5GameInfo game, string path)
        {
            // A manifest-restored package has no live engine access, so re-open it for inner reads.
            SonyPkgSummary? cached = game.Package;
            if (cached is not null && (cached.NestedPfs is null || cached.NestedPfs.EngineAccess is not null))
                return cached;
            SonyPkgSummary fresh = new Parsers.SonyPkgReader().Read(path);
            game.Package = fresh;
            return fresh;
        }

        public IReadOnlyList<GameFileRecord> Files { get; }
        public bool FileExists(string relativePath)
        {
            string normalized = NormalizePath(relativePath);
            if (_engine is not null && _engine.TryFindFile(normalized, out _)) return true;
            if (_cntEntries is not null && _cntEntries.ContainsKey(normalized)) return true;
            return _segments.ContainsKey(normalized);
        }

        public Stream OpenRead(string relativePath)
        {
            string normalized = NormalizePath(relativePath);
            if (_engine is not null)
            {
                if (_engine.TryFindFile(normalized, out ProsperoInnerPfsReader.Entry entry))
                    return _engine.OpenInnerFile(entry);
                if (_cntEntries is not null && _cntEntries.TryGetValue(normalized, out (uint Id, long Size) info))
                    return new MemoryStream(_engine.ReadCntEntry(info.Id), writable: false);
                throw new FileNotFoundException("The selected package file was not found or is encrypted.", normalized);
            }
            if (!_segments.TryGetValue(normalized, out Segment[]? segments))
                throw new FileNotFoundException("The selected package file was not found or is encrypted.", normalized);
            var source = new FileStream(_path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete, 1024 * 1024, FileOptions.RandomAccess);
            return new SegmentedReadStream(source, segments, _cryptoContext);
        }

        // The engine access is shared/cached, so it is not disposed here; releasing its file handle
        // lets another process replace the package while this app is not actively reading it.
        public void Dispose() => _engine?.ReleaseHandles();
    }

    private readonly record struct Segment(long Offset, long Length, int BlockIndex = 0,
        bool SignedDomain = false, int BlockInnerOffset = 0);

    private sealed class SegmentedReadStream : Stream
    {
        private readonly Stream _source;
        private readonly Segment[] _segments;
        private readonly long[] _starts;
        private readonly SonyPfsCryptoContext? _cryptoContext;
        private byte[]? _decryptedBlock;
        private int _cachedSegmentIndex = -1;
        private long _position;

        public SegmentedReadStream(Stream source, Segment[] segments, SonyPfsCryptoContext? cryptoContext = null)
        {
            _source = source;
            _segments = segments;
            _cryptoContext = cryptoContext;
            _starts = new long[segments.Length];
            long length = 0;
            for (int index = 0; index < segments.Length; index++)
            {
                if (segments[index].Offset < 0 || segments[index].Length < 0)
                    throw new InvalidDataException("A package file extent is invalid.");
                _starts[index] = length;
                length = checked(length + segments[index].Length);
            }
            Length = length;
        }

        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length { get; }
        public override long Position { get => _position; set => Seek(value, SeekOrigin.Begin); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

        public override int Read(Span<byte> buffer)
        {
            if (_position >= Length || buffer.Length == 0) return 0;
            int total = 0;
            while (total < buffer.Length && _position < Length)
            {
                int index = FindSegment(_position);
                Segment segment = _segments[index];
                long within = _position - _starts[index];
                int wanted = checked((int)Math.Min(buffer.Length - total, segment.Length - within));
                int read;
                if (_cryptoContext is null)
                {
                    _source.Position = checked(segment.Offset + within);
                    read = _source.Read(buffer.Slice(total, wanted));
                    if (read == 0) throw new EndOfStreamException("The package file extent ended unexpectedly.");
                }
                else
                {
                    EnsureDecrypted(index);
                    _decryptedBlock!.AsSpan(checked(segment.BlockInnerOffset + (int)within), wanted)
                        .CopyTo(buffer.Slice(total, wanted));
                    read = wanted;
                }
                total += read;
                _position += read;
            }
            return total;
        }

        private void EnsureDecrypted(int segmentIndex)
        {
            if (_cryptoContext is null || _cachedSegmentIndex == segmentIndex) return;
            _decryptedBlock ??= new byte[_cryptoContext.BlockSize];
            Segment segment = _segments[segmentIndex];
            _source.Position = checked(segment.Offset - segment.BlockInnerOffset);
            _source.ReadExactly(_decryptedBlock);
            SonyPfsCrypto.DecryptBlock(_decryptedBlock, _cryptoContext,
                checked((ulong)segment.BlockIndex), segment.SignedDomain);
            _cachedSegmentIndex = segmentIndex;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long value = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => checked(_position + offset),
                SeekOrigin.End => checked(Length + offset),
                _ => throw new ArgumentOutOfRangeException(nameof(origin))
            };
            if (value < 0) throw new IOException("Cannot seek before the start of the package file.");
            _position = value;
            return value;
        }

        private int FindSegment(long position)
        {
            int index = Array.BinarySearch(_starts, position);
            return index >= 0 ? index : ~index - 1;
        }

        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) _source.Dispose(); base.Dispose(disposing); }
    }

    private sealed class LocalGameFileSystem : IReadOnlyGameFileSystem
    {
        private readonly string _root;
        private readonly CancellationToken _cancellationToken;
        private IReadOnlyList<GameFileRecord>? _files;

        public LocalGameFileSystem(string root, CancellationToken cancellationToken)
        {
            _root = Path.GetFullPath(root);
            _cancellationToken = cancellationToken;
        }

        // The inventory is built lazily: FileExists/OpenRead resolve the path directly, so reading a
        // single icon or preview no longer walks the whole dump first.
        public IReadOnlyList<GameFileRecord> Files => _files ??= EnumerateFiles();

        private IReadOnlyList<GameFileRecord> EnumerateFiles()
        {
            var files = new List<GameFileRecord>();
            var options = new EnumerationOptions
            {
                RecurseSubdirectories = true,
                IgnoreInaccessible = true,
                AttributesToSkip = FileAttributes.ReparsePoint
            };
            foreach (string path in Directory.EnumerateFiles(_root, "*", options))
            {
                _cancellationToken.ThrowIfCancellationRequested();
                try { files.Add(new GameFileRecord(NormalizePath(Path.GetRelativePath(_root, path)), new FileInfo(path).Length, "Host")); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
            }
            return files;
        }

        public bool FileExists(string relativePath) => File.Exists(Resolve(relativePath));
        public Stream OpenRead(string relativePath) => new FileStream(Resolve(relativePath), FileMode.Open,
            FileAccess.Read, FileShare.Read, 1024 * 1024, FileOptions.RandomAccess);
        private string Resolve(string relativePath)
        {
            string fullPath = Path.GetFullPath(Path.Combine(_root,
                NormalizePath(relativePath).Replace('/', Path.DirectorySeparatorChar)));
            string prefix = _root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!fullPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                throw new IOException("The requested path leaves the game root.");
            return fullPath;
        }
        public void Dispose() { }
    }

    private sealed class FfpfscGameFileSystem : IReadOnlyGameFileSystem
    {
        private readonly FfpfscVolume _volume;
        private readonly string _prefix;
        private readonly Dictionary<string, string> _volumePaths = new(StringComparer.OrdinalIgnoreCase);

        public FfpfscGameFileSystem(string path, string virtualRoot)
        {
            _volume = FfpfscVolume.Open(path);
            _prefix = NormalizePath(virtualRoot);
            var files = new List<GameFileRecord>();
            foreach (FfpfscVolumeEntry entry in _volume.Entries.Where(entry => !entry.IsDirectory))
            {
                string relative;
                if (_prefix.Length == 0) relative = entry.Path;
                else if (entry.Path.StartsWith(_prefix + '/', StringComparison.OrdinalIgnoreCase))
                    relative = entry.Path[(_prefix.Length + 1)..];
                else continue;
                relative = NormalizePath(relative);
                files.Add(new GameFileRecord(relative, entry.Size, "PFSC"));
                _volumePaths.TryAdd(relative, entry.Path);
            }
            Files = files;
        }
        public IReadOnlyList<GameFileRecord> Files { get; }
        public bool FileExists(string relativePath) => _volumePaths.ContainsKey(NormalizePath(relativePath));
        public Stream OpenRead(string relativePath)
        {
            string normalized = NormalizePath(relativePath);
            if (!_volumePaths.TryGetValue(normalized, out string? volumePath))
                throw new FileNotFoundException("The file was not found in the FFPFSC image.", normalized);
            return _volume.OpenFile(volumePath);
        }
        public void Dispose() => _volume.Dispose();
    }

    private sealed class FilesystemImageGameFileSystem : IReadOnlyGameFileSystem
    {
        private readonly FileStream _image;
        private readonly ExfatVolume _volume;
        private readonly Dictionary<string, string> _volumePaths = new(StringComparer.OrdinalIgnoreCase);

        public FilesystemImageGameFileSystem(string path, string virtualRoot)
        {
            _image = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
                1024 * 1024, FileOptions.RandomAccess);
            try
            {
                _volume = new ExfatVolume(_image, leaveOpen: true);
                string prefix = NormalizePath(virtualRoot);
                var files = new List<GameFileRecord>();
                foreach (ExfatEntry entry in _volume.Entries.Where(entry => !entry.IsDirectory))
                {
                    string relative;
                    if (prefix.Length == 0) relative = entry.Path;
                    else if (entry.Path.StartsWith(prefix + '/', StringComparison.OrdinalIgnoreCase))
                        relative = entry.Path[(prefix.Length + 1)..];
                    else continue;
                    relative = NormalizePath(relative);
                    files.Add(new GameFileRecord(relative, entry.Size, "exFAT"));
                    _volumePaths.TryAdd(relative, entry.Path);
                }
                Files = files;
            }
            catch
            {
                _image.Dispose();
                throw;
            }
        }

        public IReadOnlyList<GameFileRecord> Files { get; }
        public bool FileExists(string relativePath) => _volumePaths.ContainsKey(NormalizePath(relativePath));
        public Stream OpenRead(string relativePath)
        {
            string normalized = NormalizePath(relativePath);
            if (!_volumePaths.TryGetValue(normalized, out string? volumePath))
                throw new FileNotFoundException("The file was not found in the filesystem image.", normalized);
            return _volume.OpenFile(volumePath);
        }

        public void Dispose()
        {
            _volume.Dispose();
            _image.Dispose();
        }
    }

    private sealed class FfpkgGameFileSystem : IReadOnlyGameFileSystem
    {
        private readonly Ufs2Volume _volume;
        private readonly Dictionary<string, string> _volumePaths = new(StringComparer.OrdinalIgnoreCase);

        public FfpkgGameFileSystem(string path, string virtualRoot)
        {
            _volume = new Ufs2Volume(path);
            string prefix = NormalizePath(virtualRoot);
            var files = new List<GameFileRecord>();
            foreach (Ufs2VolumeEntry entry in _volume.Entries.Where(entry => !entry.IsDirectory))
            {
                string relative;
                if (prefix.Length == 0) relative = entry.Path;
                else if (entry.Path.StartsWith(prefix + '/', StringComparison.OrdinalIgnoreCase))
                    relative = entry.Path[(prefix.Length + 1)..];
                else continue;
                relative = NormalizePath(relative);
                files.Add(new GameFileRecord(relative, entry.Size, "UFS2"));
                _volumePaths.TryAdd(relative, entry.Path);
            }
            Files = files;
        }

        public IReadOnlyList<GameFileRecord> Files { get; }
        public bool FileExists(string relativePath) => _volumePaths.ContainsKey(NormalizePath(relativePath));
        public Stream OpenRead(string relativePath)
        {
            string normalized = NormalizePath(relativePath);
            if (!_volumePaths.TryGetValue(normalized, out string? volumePath))
                throw new FileNotFoundException("The file was not found in the FFPKG image.", normalized);
            return _volume.OpenFile(volumePath);
        }
        public void Dispose() => _volume.Dispose();
    }
}
