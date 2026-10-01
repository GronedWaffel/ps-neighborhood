using System.Text;
using UFS2Tool;

namespace PS5PKGTool.Ffpfsc;

public enum FfpfscInnerFilesystemKind
{
    Exfat,
    Ufs2,
    /// <summary>The inner payload is itself a PFS container (nested FFPFSC/FFPFS).</summary>
    Pfs
}

public sealed record FfpfscVolumeEntry(string Path, bool IsDirectory, long Size);

/// <summary>
/// Opens the inner payload of an FFPFSC image without extracting it. The inner filesystem is
/// detected by signature (exFAT, UFS2) so wrapped payloads do not depend on the inner file name.
/// Nested PFS payloads are exposed through <see cref="PayloadStream"/> for recursive unwrapping.
/// </summary>
public sealed class FfpfscVolume : IDisposable
{
    private readonly Stream _container;
    private readonly PfscReadStream _decoded;
    private readonly ExfatVolume? _exfat;
    private readonly Ufs2Volume? _ufs2;
    private readonly bool _leaveContainerOpen;
    private bool _disposed;

    private FfpfscVolume(string path)
        : this(new FileStream(System.IO.Path.GetFullPath(path), FileMode.Open, FileAccess.Read, FileShare.Read,
            1024 * 1024, FileOptions.RandomAccess), System.IO.Path.GetFullPath(path), leaveContainerOpen: false)
    {
    }

    private FfpfscVolume(Stream container, string displayPath, bool leaveContainerOpen)
    {
        ArgumentNullException.ThrowIfNull(container);
        Path = displayPath;
        _container = container;
        _leaveContainerOpen = leaveContainerOpen;
        try
        {
            Info = FfpfscImage.Inspect(_container);
            _decoded = new PfscReadStream(_container, Info.Pfsc, Info.PayloadOffset, Info.LogicalLength, leaveOpen: true);

            Ps5ImageFormat format = Ps5ImageFormatProbe.Detect(_decoded);
            switch (format)
            {
                case Ps5ImageFormat.Ufs2:
                    _ufs2 = new Ufs2Volume(_decoded, Path + "!" + Info.InnerFileName, leaveOpen: true);
                    InnerFilesystemKind = FfpfscInnerFilesystemKind.Ufs2;
                    Entries = _ufs2.Entries
                        .Select(entry => new FfpfscVolumeEntry(entry.Path, entry.IsDirectory, entry.Size))
                        .ToArray();
                    break;
                case Ps5ImageFormat.Pfs:
                    InnerFilesystemKind = FfpfscInnerFilesystemKind.Pfs;
                    Entries = [new FfpfscVolumeEntry(Info.InnerFileName, false, Info.LogicalLength)];
                    break;
                case Ps5ImageFormat.Exfat:
                    _exfat = new ExfatVolume(_decoded, leaveOpen: true);
                    InnerFilesystemKind = FfpfscInnerFilesystemKind.Exfat;
                    Entries = _exfat.Entries
                        .Select(entry => new FfpfscVolumeEntry(entry.Path, entry.IsDirectory, entry.Size))
                        .ToArray();
                    break;
                default:
                    throw new InvalidDataException(
                        "The FFPFSC inner payload is not a recognised filesystem (exFAT, UFS2, or PFS).");
            }
        }
        catch
        {
            _ufs2?.Dispose();
            _exfat?.Dispose();
            _decoded?.Dispose();
            if (!leaveContainerOpen) _container.Dispose();
            throw;
        }
    }

    public string Path { get; }
    public FfpfscInfo Info { get; }
    public FfpfscInnerFilesystemKind InnerFilesystemKind { get; }
    public IReadOnlyList<FfpfscVolumeEntry> Entries { get; } = [];
    public ExfatVolume FileSystem => _exfat ?? throw new InvalidOperationException("The inner filesystem is not exFAT.");

    /// <summary>The decoded inner payload stream (seekable). Used to unwrap nested PFS containers.</summary>
    public Stream PayloadStream => _decoded;

    public static FfpfscVolume Open(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        return new FfpfscVolume(path);
    }

    public static FfpfscVolume Open(Stream container, string displayPath, bool leaveOpen = false)
    {
        ArgumentNullException.ThrowIfNull(container);
        return new FfpfscVolume(container, displayPath, leaveOpen);
    }

    public FfpfscVolumeEntry? Find(string path)
    {
        string normalized = path.Replace('\\', '/').Trim('/');
        return Entries.FirstOrDefault(entry => entry.Path.Equals(normalized, StringComparison.OrdinalIgnoreCase));
    }

    public Stream OpenFile(string path)
    {
        if (_ufs2 is not null) return _ufs2.OpenFile(path);
        if (_exfat is not null) return _exfat.OpenFile(path);
        throw new InvalidOperationException(
            "The FFPFSC inner payload is a nested PFS container, not a file tree.");
    }

    public byte[] ReadAllBytes(string path, int maximumBytes = 256 * 1024 * 1024)
    {
        FfpfscVolumeEntry entry = Find(path) ?? throw new FileNotFoundException("The file was not found in FFPFSC.", path);
        if (entry.IsDirectory) throw new IOException("The requested FFPFSC entry is a directory.");
        if (entry.Size < 0 || entry.Size > maximumBytes || entry.Size > int.MaxValue)
            throw new IOException($"The FFPFSC file is too large to load into memory: {entry.Path}");
        using Stream input = OpenFile(entry.Path);
        byte[] result = new byte[checked((int)entry.Size)];
        input.ReadExactly(result);
        return result;
    }

    public string ReadAllText(string path, Encoding? encoding = null, int maximumBytes = 16 * 1024 * 1024) =>
        (encoding ?? new UTF8Encoding(false, true)).GetString(ReadAllBytes(path, maximumBytes));

    public void Dispose()
    {
        if (_disposed) return;
        _exfat?.Dispose();
        _ufs2?.Dispose();
        _decoded.Dispose();
        if (!_leaveContainerOpen) _container.Dispose();
        _disposed = true;
    }
}
