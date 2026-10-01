using System.Buffers.Binary;
using PS5PKGTool.Core.Builders;
using ProsperoPkgTool.Containers;
using ProsperoPkgTool.Crypto;

namespace PS5PKGTool.Core.Parsers;

/// <summary>
/// Adapts the vendored, validated <c>ProsperoPkgTool</c> engine to PS5PKGTool's package model.
/// The engine owns every byte of PS5 PKG/NAPS/PFS/CNT/FIH parsing, reconstruction and decryption;
/// this type only exposes the decoded inner image to the existing model layer.
/// </summary>
internal sealed class SonyEnginePackageAccess : IDisposable
{
    private readonly string _passcode;
    private readonly string _contentId;
    private IReadOnlyList<ProsperoInnerPfsReader.Entry>? _entries;
    private ProsperoDecodedPackage? _decoded;
    private ProsperoFileBackedPackage? _fileBacked;
    private string? _decodeError;
    private bool _decodeUnsupported;
    private bool _decodeAttempted;
    private bool _disposed;
    private bool _usedFileBacked;
    private int _openMounts;
    private bool _releasePending;
    private readonly object _mountGate = new();

    private SonyEnginePackageAccess(string packagePath, ProsperoPackageInspection inspection, string? passcode,
        string? contentId)
    {
        PackagePath = packagePath;
        Inspection = inspection;
        _passcode = passcode ?? string.Empty;
        _contentId = contentId ?? string.Empty;
    }

    public string PackagePath { get; }
    public ProsperoPackageInspection Inspection { get; }

    /// <summary>
    /// Reconstructed inner-image entries. Accessing this performs the expensive outer PFS/NAPS/Kraken
    /// decode on first use, so scanning a package stays cheap until details are actually requested.
    /// </summary>
    public IReadOnlyList<ProsperoInnerPfsReader.Entry> Entries
    {
        get { EnsureDecoded(); return _entries!; }
    }

    public string? DecodeError
    {
        get { EnsureDecoded(); return _decodeError; }
    }

    /// <summary>
    /// True when <see cref="DecodeError"/> is an unsupported format/layout rather than a wrong key or
    /// corruption, so the UI can report the real cause instead of blaming the passcode.
    /// </summary>
    public bool DecodeUnsupported
    {
        get { EnsureDecoded(); return _decodeUnsupported; }
    }

    public IEnumerable<ProsperoInnerPfsReader.Entry> Files => Entries.Where(entry => !entry.IsDirectory);

    /// <summary>Parses the CNT/FIH metadata only. The inner image is decoded lazily on first use.</summary>
    public static SonyEnginePackageAccess Open(string packagePath, string? passcode)
    {
        string fullPath = Path.GetFullPath(packagePath);
        ProsperoPackageInspection inspection = ProsperoPackageReader.Read(fullPath);
        return FromInspection(fullPath, inspection, passcode);
    }

    /// <summary>
    /// Creates an accessor from an inspection the caller has already parsed, so the package
    /// header/CNT is not parsed a second time during a scan.
    /// </summary>
    internal static SonyEnginePackageAccess FromInspection(string packagePath, ProsperoPackageInspection inspection,
        string? passcode) => new(Path.GetFullPath(packagePath), inspection, passcode, inspection.Cnt.ContentId);

    private void EnsureDecoded()
    {
        if (_decodeAttempted) return;
        _decodeAttempted = true;

        ProsperoFihHeader? fih = Inspection.Fih;
        bool isDebug = Inspection.Kind is ProsperoPackageKind.FinalizedDebug or ProsperoPackageKind.FinalizedPatchDebug;
        if (fih is null || fih.PfsSize == 0 || !isDebug)
        {
            _entries = [];
            return;
        }

        try
        {
            string? passcode = _passcode.Length == 0 ? null : _passcode;
            if (ProsperoPackageContent.RequiresFileBacked(PackagePath, passcode))
            {
                _usedFileBacked = true;
                _fileBacked = ProsperoPackageContent.ReadFileBacked(PackagePath, passcode);
                _entries = _fileBacked.Entries;
            }
            else
            {
                _decoded = ProsperoPackageContent.Read(PackagePath, passcode);
                _entries = ProsperoInnerPfsReader.Enumerate(_decoded.Mount);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _entries = [];
            _decodeError = ex.Message;
            _decodeUnsupported = ProsperoErrorInfo.IsUnsupported(ex);
        }
    }

    public byte[] ReadCntEntry(uint id, long? length = null)
    {
        ProsperoCntEntry entry = Inspection.Entries.FirstOrDefault(candidate => candidate.Id == id)
            ?? throw new InvalidDataException($"CNT entry 0x{id:X4} is not present.");
        return entry.IsEncrypted
            ? ReadProtectedCntEntry(entry)
            : ProsperoPackageContent.ReadCntEntry(PackagePath, Inspection, entry, length);
    }

    /// <summary>
    /// Decrypts a protected CNT entry (the <c>0x80000000</c> flag). The stored body is AES-128-CBC
    /// over the payload zero-padded to a 16-byte boundary; the key/IV seed binds the finalized entry
    /// meta row, the package content id and the passcode. Requires the 32-character passcode and the
    /// package content id (both known for debug packages). The PS5 publisher profile (SHA3) is tried
    /// first, then the legacy SHA-256 profile; a known-magic check guards against a wrong passcode.
    /// </summary>
    private byte[] ReadProtectedCntEntry(ProsperoCntEntry entry)
    {
        string passcode = _passcode.Length == 0 ? SonyDebugPackageCredentials.DefaultPasscode : _passcode;
        if (passcode.Length != 32)
            throw new InvalidDataException(
                $"CNT entry 0x{entry.Id:X8} is encrypted and needs the 32-character passcode.");
        if (string.IsNullOrWhiteSpace(_contentId))
            throw new InvalidDataException(
                $"CNT entry 0x{entry.Id:X8} is encrypted but the package content id is unavailable.");

        long padded = ProsperoEntryCipher.PaddedLength(checked((int)entry.DataSize));
        byte[] ciphertext = ProsperoPackageContent.ReadCntEntry(PackagePath, Inspection, entry, padded);
        byte[] metaRow = BuildMetaRow(entry);
        uint keyIndex = (entry.Flags2 >> 12) & 0xF;

        foreach (bool ps5Profile in new[] { true, false })
        {
            byte[] plain;
            try
            {
                plain = ProsperoEntryCipher.Decrypt(ciphertext, metaRow, _contentId, passcode, keyIndex, ps5Profile);
            }
            catch (Exception ex) when (ex is ArgumentException or System.Security.Cryptography.CryptographicException)
            {
                continue;
            }
            if (plain.Length >= entry.DataSize && IsRecognizedProtectedEntry(entry.Id, plain))
                return plain[..(int)entry.DataSize];
        }

        throw new InvalidDataException(
            $"CNT entry 0x{entry.Id:X8} is encrypted and could not be decrypted with the supplied " +
            "passcode, or it uses an encryption profile this build does not support yet.");
    }

    /// <summary>The 32-byte finalized entry meta row the key seed is bound to (six big-endian fields, then 8 zero bytes).</summary>
    private static byte[] BuildMetaRow(ProsperoCntEntry entry)
    {
        byte[] row = new byte[ProsperoEntryCipher.MetaRowSize];
        BinaryPrimitives.WriteUInt32BigEndian(row.AsSpan(0), entry.Id);
        BinaryPrimitives.WriteUInt32BigEndian(row.AsSpan(4), entry.NameOffset);
        BinaryPrimitives.WriteUInt32BigEndian(row.AsSpan(8), entry.Flags1);
        BinaryPrimitives.WriteUInt32BigEndian(row.AsSpan(12), entry.Flags2);
        BinaryPrimitives.WriteUInt32BigEndian(row.AsSpan(16), entry.DataOffset);
        BinaryPrimitives.WriteUInt32BigEndian(row.AsSpan(20), entry.DataSize);
        return row;
    }

    /// <summary>Known plaintext magics for protected entries, so a wrong passcode is rejected rather
    /// than returning garbage. Unknown ids are accepted as-is.</summary>
    private static bool IsRecognizedProtectedEntry(uint id, byte[] plain) => id switch
    {
        0x0402 => plain.Length >= 4 && plain[0] == (byte)'N' && plain[1] == (byte)'P' &&
                  plain[2] == (byte)'T' && plain[3] == (byte)'D',
        0x2020 or 0x2021 or 0x0403 => plain.Length >= 4 && plain[0] == 0xD2 && plain[1] == 0x94 &&
                                      plain[2] == 0xA0 && plain[3] == 0x18,
        _ => true
    };

    /// <summary>
    /// Plaintext CNT content entries exposed under the same relative paths used inside the inner
    /// image, so the metadata/artwork/trophy/UDS readers work even when the inner PFS needs a key.
    /// </summary>
    private static readonly (uint Id, string Path)[] ContentEntries =
    [
        (0x0402, "sce_sys/nptitle.dat"),
        (0x0403, "sce_sys/npbind.dat"),
        (0x040A, "sce_sys/imagedigs.dat"),
        (0x1000, "sce_sys/param.sfo"),
        (0x1001, "sce_sys/playgo-chunk.dat"),
        (0x1200, "sce_sys/icon0.png"),
        (0x1220, "sce_sys/pic0.png"),
        (0x1240, "sce_sys/snd0.at9"),
        (0x1280, "sce_sys/icon0.dds"),
        (0x12A0, "sce_sys/pic0.dds"),
        (0x12C0, "sce_sys/pic1.dds"),
        (0x1480, "sce_sys/trophy2/trophy00.ucp"),
        (0x14A0, "sce_sys/uds/uds00.ucp"),
        (0x2000, "sce_sys/param.json"),
        (0x2010, "sce_sys/playgo-hash-table.dat"),
        (0x2011, "sce_sys/playgo-ficm.dat"),
        (0x2020, "sce_sys/uds/npbind.dat"),
        (0x2021, "sce_sys/trophy2/npbind.dat"),
        (0x2060, "sce_sys/pic2.dds")
    ];

    public IEnumerable<(uint Id, string Path, long Size)> ContentFileEntries()
    {
        foreach ((uint id, string path) in ContentEntries)
        {
            ProsperoCntEntry? entry = Inspection.Entries.FirstOrDefault(candidate => candidate.Id == id);
            if (entry is null) continue;
            yield return (id, path, entry.DataSize);
        }
    }

    /// <summary>
    /// Every CNT entry, mirroring the engine's structural file listing. Known content IDs are mapped
    /// to their inner-image paths; the rest keep the engine name. Protected entries are listed too
    /// and decrypted on read when a passcode is available. This is used when the inner PFS cannot be
    /// decoded (for example a package that needs a custom passcode) so the file browser still shows
    /// what the package exposes.
    /// </summary>
    public IEnumerable<(uint Id, string Path, long Size)> ListReadableEntries()
    {
        foreach (ProsperoCntEntry entry in Inspection.Entries)
        {
            string? mapped = null;
            foreach ((uint id, string path) in ContentEntries)
                if (id == entry.Id) { mapped = path; break; }
            string name = mapped
                ?? (!string.IsNullOrWhiteSpace(entry.Name) ? entry.Name
                    : !string.IsNullOrWhiteSpace(entry.DisplayName) && entry.DisplayName != "(unnamed)"
                        ? entry.DisplayName
                        : $"entry_0x{entry.Id:X4}.bin");
            yield return (entry.Id, name, entry.DataSize);
        }
    }

    public string ToRelativePath(ProsperoInnerPfsReader.Entry entry) => Normalize(entry.Path);

    public bool TryFindFile(string relativePath, out ProsperoInnerPfsReader.Entry entry)
    {
        string key = Normalize(relativePath);
        foreach (ProsperoInnerPfsReader.Entry candidate in Entries)
        {
            if (!candidate.IsDirectory &&
                string.Equals(Normalize(candidate.Path), key, StringComparison.OrdinalIgnoreCase))
            {
                entry = candidate;
                return true;
            }
        }

        entry = null!;
        return false;
    }

    public byte[] ReadFile(ProsperoInnerPfsReader.Entry entry)
    {
        if (entry.Size is < 0 or > int.MaxValue)
            throw new InvalidDataException($"The inner PFS file '{entry.Path}' is too large to read into memory.");
        using Stream mount = OpenMount();
        using var buffer = new MemoryStream(checked((int)entry.Size));
        ProsperoInnerPfsReader.ExtractFile(mount, entry, buffer);
        return buffer.ToArray();
    }

    public byte[] ReadFile(string relativePath)
    {
        if (!TryFindFile(relativePath, out ProsperoInnerPfsReader.Entry entry))
            throw new InvalidDataException($"The inner PFS file '{relativePath}' is not present in the reconstructed image.");
        return ReadFile(entry);
    }

    public byte[] ReadFileRange(ProsperoInnerPfsReader.Entry entry, long offset, int count)
    {
        if (entry.IsDirectory) throw new InvalidDataException($"'{entry.Path}' is a directory.");
        if (offset < 0 || count < 0 || offset > entry.Size || count > entry.Size - offset)
            throw new ArgumentOutOfRangeException(nameof(offset));
        using Stream mount = OpenMount();
        using var range = new BoundedStream(mount, checked(entry.LogicalOffset + offset), count);
        byte[] result = new byte[count];
        range.ReadExactly(result);
        return result;
    }

    public Stream OpenInnerFile(ProsperoInnerPfsReader.Entry entry)
    {
        if (entry.IsDirectory) throw new InvalidDataException($"'{entry.Path}' is a directory.");
        return new BoundedStream(OpenMount(), entry.LogicalOffset, entry.Size);
    }

    private Stream OpenMount()
    {
        EnsureDecoded();
        if (_decodeError is not null)
            throw new InvalidDataException($"Package contents could not be decoded: {_decodeError}");
        Stream inner;
        if (_fileBacked is not null)
        {
            inner = _fileBacked.OpenMount();
        }
        else if (_usedFileBacked)
        {
            _fileBacked = ReopenFileBacked();
            inner = _fileBacked.OpenMount();
        }
        else
        {
            inner = new MemoryStream(_decoded!.Mount, writable: false);
        }

        Interlocked.Increment(ref _openMounts);
        return new MountLease(inner, OnMountClosed);
    }

    private ProsperoFileBackedPackage ReopenFileBacked() =>
        ProsperoPackageContent.ReadFileBacked(PackagePath, _passcode.Length == 0 ? null : _passcode);

    private void OnMountClosed()
    {
        if (Interlocked.Decrement(ref _openMounts) != 0) return;
        lock (_mountGate)
        {
            if (_openMounts != 0 || !_releasePending) return;
            _releasePending = false;
            ProsperoFileBackedPackage? fileBacked = _fileBacked;
            _fileBacked = null;
            fileBacked?.Dispose();
        }
    }

    /// <summary>
    /// Releases the package file handle held by a large, lazily-decoded image without discarding the
    /// already-decoded entry list. The handle is reopened on the next file read, so another process
    /// can replace or delete the package while this app is not actively reading it.
    /// </summary>
    public void ReleaseHandles()
    {
        lock (_mountGate)
        {
            if (_openMounts > 0)
            {
                _releasePending = true;
                return;
            }

            ProsperoFileBackedPackage? fileBacked = _fileBacked;
            _fileBacked = null;
            fileBacked?.Dispose();
        }
    }

    private static string Normalize(string path)
    {
        string value = path.Replace('\\', '/').TrimStart('/');
        if (value.StartsWith("uroot/", StringComparison.OrdinalIgnoreCase)) value = value[6..];
        else if (string.Equals(value, "uroot", StringComparison.OrdinalIgnoreCase)) value = string.Empty;
        return value;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _fileBacked?.Dispose();
        GC.SuppressFinalize(this);
    }

    ~SonyEnginePackageAccess() => Dispose();

    /// <summary>Delegating stream that notifies its owner once, when disposed, so the shared package
    /// handle can be released after the last concurrent reader finishes.</summary>
    private sealed class MountLease : Stream
    {
        private readonly Stream _inner;
        private readonly Action _onDispose;
        private bool _disposed;

        public MountLease(Stream inner, Action onDispose)
        {
            _inner = inner;
            _onDispose = onDispose;
        }

        public override bool CanRead => _inner.CanRead;
        public override bool CanSeek => _inner.CanSeek;
        public override bool CanWrite => _inner.CanWrite;
        public override long Length => _inner.Length;
        public override long Position { get => _inner.Position; set => _inner.Position = value; }
        public override void Flush() => _inner.Flush();
        public override int Read(byte[] buffer, int offset, int count) => _inner.Read(buffer, offset, count);
        public override int Read(Span<byte> buffer) => _inner.Read(buffer);
        public override long Seek(long offset, SeekOrigin origin) => _inner.Seek(offset, origin);
        public override void SetLength(long value) => _inner.SetLength(value);
        public override void Write(byte[] buffer, int offset, int count) => _inner.Write(buffer, offset, count);

        protected override void Dispose(bool disposing)
        {
            if (disposing && !_disposed)
            {
                _disposed = true;
                _inner.Dispose();
                _onDispose();
            }

            base.Dispose(disposing);
        }
    }

    private sealed class BoundedStream : Stream
    {
        private readonly Stream _inner;
        private readonly long _start;
        private readonly long _length;
        private long _position;

        public BoundedStream(Stream inner, long start, long length)
        {
            if (start < 0 || length < 0) throw new ArgumentOutOfRangeException(nameof(start));
            _inner = inner;
            _start = start;
            _length = length;
        }

        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => _length;
        public override long Position { get => _position; set => Seek(value, SeekOrigin.Begin); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

        public override int Read(Span<byte> buffer)
        {
            long remaining = _length - _position;
            if (remaining <= 0 || buffer.Length == 0) return 0;
            int wanted = (int)Math.Min(buffer.Length, remaining);
            _inner.Position = _start + _position;
            int read = _inner.Read(buffer[..wanted]);
            _position += read;
            return read;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long value = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => _position + offset,
                SeekOrigin.End => _length + offset,
                _ => throw new ArgumentOutOfRangeException(nameof(origin))
            };
            if (value < 0) throw new IOException("Cannot seek before the start of the stream.");
            _position = value;
            return _position;
        }

        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) _inner.Dispose(); base.Dispose(disposing); }
    }
}
