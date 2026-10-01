namespace PS5PKGTool.Ffpfsc;

/// <summary>Seekable, read-only view of a PFSC payload which decodes blocks on demand.</summary>
public sealed class PfscReadStream : Stream
{
    private const int CacheCapacity = 16;
    private readonly Stream _source;
    private readonly PfscInfo _info;
    private readonly long _baseOffset;
    private readonly long _length;
    private readonly bool _leaveOpen;
    private readonly object _sync = new();
    private readonly Dictionary<int, (byte[] Data, LinkedListNode<int> Node)> _cache = [];
    private readonly LinkedList<int> _lru = [];
    private long _position;
    private bool _disposed;

    public PfscReadStream(Stream source, PfscInfo info, long baseOffset, long contentLength, bool leaveOpen = false)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(info);
        if (!source.CanRead || !source.CanSeek)
            throw new ArgumentException("The PFSC source must be readable and seekable.", nameof(source));
        if (baseOffset < 0) throw new ArgumentOutOfRangeException(nameof(baseOffset));
        if (contentLength < 0 || contentLength > info.PaddedLogicalLength)
            throw new ArgumentOutOfRangeException(nameof(contentLength));
        _source = source;
        _info = info;
        _baseOffset = baseOffset;
        _length = contentLength;
        _leaveOpen = leaveOpen;
    }

    public override bool CanRead => !_disposed;
    public override bool CanSeek => !_disposed;
    public override bool CanWrite => false;
    public override long Length { get { ThrowIfDisposed(); return _length; } }
    public override long Position
    {
        get { ThrowIfDisposed(); return _position; }
        set
        {
            ThrowIfDisposed();
            if (value < 0 || value > _length) throw new ArgumentOutOfRangeException(nameof(value));
            _position = value;
        }
    }

    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

    public override int Read(Span<byte> destination)
    {
        ThrowIfDisposed();
        int total = checked((int)Math.Min(destination.Length, _length - _position));
        int written = 0;
        while (written < total)
        {
            int blockIndex = checked((int)(_position / _info.LogicalBlockSize));
            int blockOffset = checked((int)(_position % _info.LogicalBlockSize));
            byte[] block = GetBlock(blockIndex);
            int count = Math.Min(total - written, block.Length - blockOffset);
            block.AsSpan(blockOffset, count).CopyTo(destination.Slice(written, count));
            written += count;
            _position += count;
        }
        return written;
    }

    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(Read(buffer.Span));
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        ThrowIfDisposed();
        long position = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => checked(_position + offset),
            SeekOrigin.End => checked(_length + offset),
            _ => throw new ArgumentOutOfRangeException(nameof(origin))
        };
        if (position < 0 || position > _length) throw new IOException("Attempted to seek outside the PFSC content.");
        _position = position;
        return position;
    }

    private byte[] GetBlock(int blockIndex)
    {
        lock (_sync)
        {
            if (_cache.TryGetValue(blockIndex, out var cached))
            {
                _lru.Remove(cached.Node);
                _lru.AddFirst(cached.Node);
                return cached.Data;
            }
            byte[] data = PfscCodec.ReadBlock(_source, _info, blockIndex, _baseOffset);
            LinkedListNode<int> node = _lru.AddFirst(blockIndex);
            _cache.Add(blockIndex, (data, node));
            if (_cache.Count > CacheCapacity)
            {
                LinkedListNode<int> last = _lru.Last!;
                _lru.RemoveLast();
                _cache.Remove(last.Value);
            }
            return data;
        }
    }

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);

    protected override void Dispose(bool disposing)
    {
        if (!_disposed && disposing && !_leaveOpen) _source.Dispose();
        _disposed = true;
        base.Dispose(disposing);
    }

    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
