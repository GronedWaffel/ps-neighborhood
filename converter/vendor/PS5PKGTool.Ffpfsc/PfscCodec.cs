using System.Buffers.Binary;
using System.IO.Compression;

namespace PS5PKGTool.Ffpfsc;

/// <summary>
/// Native streaming codec for the PFSC block container used inside FFPFSC images.
/// It keeps one 64 KiB logical block in memory and stores only the offset table.
/// </summary>
public static class PfscCodec
{
    public const uint Magic = 0x43534650;
    public const int VersionField = 6;
    public const int LogicalBlockSize = 0x10000;
    public const int HeaderRecordSize = 0x30;
    public const int OffsetTableOffset = 0x400;
    public const int InitialDataOffset = 0x10000;
    private const int OffsetEntrySize = 8;
    private const int CopyBufferSize = 0x10000;
    private const int MaximumBlockCount = 16_777_216;

    public static async Task<PfscWriteResult> EncodeAsync(Stream source, long sourceLength, Stream destination,
        PfscCompressionOptions? options = null, IProgress<PfscProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(destination);
        if (!source.CanRead) throw new ArgumentException("Source stream must be readable.", nameof(source));
        if (!destination.CanWrite || !destination.CanSeek)
            throw new ArgumentException("Destination stream must be writable and seekable.", nameof(destination));
        if (sourceLength < 0) throw new ArgumentOutOfRangeException(nameof(sourceLength));
        options ??= new PfscCompressionOptions();
        options.Validate();

        long blockCountValue = DivideRoundUp(sourceLength, LogicalBlockSize);
        if (blockCountValue > MaximumBlockCount)
            throw new InvalidDataException($"PFSC block count {blockCountValue:N0} exceeds the safety limit.");
        int blockCount = checked((int)blockCountValue);
        long headerSize = CalculateHeaderSize(blockCount);
        long start = destination.Position;
        destination.SetLength(checked(start + headerSize));
        destination.Position = checked(start + headerSize);

        var offsets = new long[blockCount + 1];
        offsets[0] = headerSize;
        byte[] rawBlock = new byte[LogicalBlockSize];
        using var compressedBuffer = new MemoryStream(LogicalBlockSize);
        int compressedBlockCount = 0;
        long processed = 0;
        long lastProgress = 0;

        const int batchBlocks = 128;
        byte[] batch = new byte[batchBlocks * LogicalBlockSize];
        for (int batchStart = 0; batchStart < blockCount; batchStart += batchBlocks)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int count = Math.Min(batchBlocks, blockCount - batchStart);
            int wanted = checked((int)Math.Min((long)count * LogicalBlockSize, sourceLength - processed));
            Array.Clear(batch);
            int read = await ReadExactlyOrEndAsync(source, batch, wanted, cancellationToken).ConfigureAwait(false);
            if (read != wanted) throw new EndOfStreamException("The PFSC source ended before its declared length.");
            byte[]?[] encoded = new byte[count][];
            Parallel.For(0, count, new ParallelOptions { MaxDegreeOfParallelism = Math.Min(8, Environment.ProcessorCount), CancellationToken = cancellationToken }, slot =>
            {
                using var buffer = new MemoryStream(LogicalBlockSize);
                using (var zlib = new ZLibStream(buffer, new ZLibCompressionOptions { CompressionLevel = options.CompressionLevel, CompressionStrategy = ZLibCompressionStrategy.Default }, leaveOpen: true))
                    zlib.Write(batch.AsSpan(slot * LogicalBlockSize, LogicalBlockSize));
                int length = checked((int)buffer.Length);
                double gain = (LogicalBlockSize - length) * 100.0 / LogicalBlockSize;
                if (length < LogicalBlockSize && gain >= options.MinimumGainPercent) encoded[slot] = buffer.ToArray();
            });
            for (int slot = 0; slot < count; slot++)
            {
                ReadOnlyMemory<byte> selected = encoded[slot] is { } compressed ? compressed : batch.AsMemory(slot * LogicalBlockSize, LogicalBlockSize);
                await destination.WriteAsync(selected, cancellationToken).ConfigureAwait(false);
                if (encoded[slot] is not null) compressedBlockCount++;
                offsets[batchStart + slot + 1] = checked(destination.Position - start);
            }
            processed += wanted;
            if (processed - lastProgress >= 8L * 1024 * 1024 || batchStart + count == blockCount)
            {
                lastProgress = processed;
                progress?.Report(new PfscProgress(processed, sourceLength, batchStart + count, blockCount));
            }
        }

        long storedLength = checked(destination.Position - start);
        await WriteHeaderAsync(destination, start, offsets, headerSize, blockCount, cancellationToken).ConfigureAwait(false);
        destination.Position = checked(start + storedLength);
        return new PfscWriteResult
        {
            SourceLength = sourceLength,
            PaddedLogicalLength = checked((long)blockCount * LogicalBlockSize),
            StoredLength = storedLength,
            BlockCount = blockCount,
            CompressedBlockCount = compressedBlockCount,
            HeaderSize = headerSize
        };
    }

    public static PfscInfo Inspect(Stream source, long baseOffset = 0, long? storedLength = null)
    {
        ArgumentNullException.ThrowIfNull(source);
        if (!source.CanRead || !source.CanSeek)
            throw new ArgumentException("PFSC source must be readable and seekable.", nameof(source));
        if (baseOffset < 0 || baseOffset > source.Length) throw new ArgumentOutOfRangeException(nameof(baseOffset));
        long available = storedLength ?? source.Length - baseOffset;
        if (available < HeaderRecordSize || available > source.Length - baseOffset)
            throw new InvalidDataException("The PFSC stored range is outside the source stream.");

        byte[] header = ReadAt(source, baseOffset, HeaderRecordSize);
        uint magic = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(0x00, 4));
        int zero = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(0x04, 4));
        int version = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(0x08, 4));
        int blockSize = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(0x0C, 4));
        long blockSizeMirror = BinaryPrimitives.ReadInt64LittleEndian(header.AsSpan(0x10, 8));
        long tableOffset = BinaryPrimitives.ReadInt64LittleEndian(header.AsSpan(0x18, 8));
        ulong dataOffsetValue = BinaryPrimitives.ReadUInt64LittleEndian(header.AsSpan(0x20, 8));
        long logicalLength = BinaryPrimitives.ReadInt64LittleEndian(header.AsSpan(0x28, 8));

        if (magic != Magic) throw new InvalidDataException("PFSC magic is missing.");
        if (zero != 0 || version != VersionField) throw new InvalidDataException("Unsupported PFSC header version.");
        if (blockSize != LogicalBlockSize || blockSizeMirror != LogicalBlockSize)
            throw new InvalidDataException("Unsupported or mismatched PFSC logical block size.");
        if (tableOffset < HeaderRecordSize || tableOffset > available)
            throw new InvalidDataException("PFSC offset table is outside the stored payload.");
        if (dataOffsetValue > long.MaxValue) throw new InvalidDataException("PFSC data offset is too large.");
        long dataOffset = (long)dataOffsetValue;
        if (dataOffset < InitialDataOffset || dataOffset > available || dataOffset % LogicalBlockSize != 0)
            throw new InvalidDataException("PFSC data offset is invalid.");
        if (logicalLength < 0 || logicalLength % LogicalBlockSize != 0)
            throw new InvalidDataException("PFSC logical length is invalid.");

        long blockCountValue = logicalLength / LogicalBlockSize;
        if (blockCountValue > MaximumBlockCount) throw new InvalidDataException("PFSC block count exceeds the safety limit.");
        int blockCount = checked((int)blockCountValue);
        long tableBytes = checked((long)(blockCount + 1) * OffsetEntrySize);
        if (tableOffset > dataOffset || tableBytes > dataOffset - tableOffset)
            throw new InvalidDataException("PFSC offset table overlaps the data region.");

        byte[] table = ReadAt(source, checked(baseOffset + tableOffset), checked((int)tableBytes));
        var offsets = new long[blockCount + 1];
        for (int index = 0; index < offsets.Length; index++)
        {
            ulong value = BinaryPrimitives.ReadUInt64LittleEndian(table.AsSpan(index * OffsetEntrySize, OffsetEntrySize));
            if (value > long.MaxValue) throw new InvalidDataException("PFSC block offset is too large.");
            offsets[index] = (long)value;
            if (offsets[index] < dataOffset || offsets[index] > available)
                throw new InvalidDataException("PFSC block offset is outside the stored payload.");
            if (index > 0 && offsets[index] < offsets[index - 1])
                throw new InvalidDataException("PFSC block offsets are not monotonic.");
        }
        if (offsets.Length > 0 && offsets[0] != dataOffset)
            throw new InvalidDataException("PFSC first block does not begin at the declared data offset.");

        return new PfscInfo
        {
            LogicalBlockSize = blockSize,
            OffsetTableOffset = tableOffset,
            DataOffset = dataOffset,
            PaddedLogicalLength = logicalLength,
            StoredLength = available,
            BlockOffsets = offsets
        };
    }

    public static async Task DecodeAsync(Stream source, Stream destination, long? contentLength = null,
        long baseOffset = 0, long? storedLength = null, IProgress<PfscProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(destination);
        if (!destination.CanWrite) throw new ArgumentException("Destination must be writable.", nameof(destination));
        PfscInfo info = Inspect(source, baseOffset, storedLength);
        long outputLength = contentLength ?? info.PaddedLogicalLength;
        if (outputLength < 0 || outputLength > info.PaddedLogicalLength)
            throw new ArgumentOutOfRangeException(nameof(contentLength));

        long written = 0;
        long lastProgress = 0;
        for (int index = 0; index < info.BlockCount && written < outputLength; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            byte[] block = ReadBlock(source, info, index, baseOffset);
            int count = checked((int)Math.Min(block.Length, outputLength - written));
            await destination.WriteAsync(block.AsMemory(0, count), cancellationToken).ConfigureAwait(false);
            written += count;
            if (written - lastProgress >= 8L * 1024 * 1024 || written == outputLength)
            {
                lastProgress = written;
                progress?.Report(new PfscProgress(written, outputLength, index + 1, info.BlockCount));
            }
        }
        if (written != outputLength) throw new InvalidDataException("PFSC output length does not match the requested content length.");
    }

    public static byte[] ReadBlock(Stream source, PfscInfo info, int blockIndex, long baseOffset = 0)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(info);
        if (blockIndex < 0 || blockIndex >= info.BlockCount) throw new ArgumentOutOfRangeException(nameof(blockIndex));
        long first = info.BlockOffsets[blockIndex];
        long next = info.BlockOffsets[blockIndex + 1];
        long storedSize = next - first;
        if (storedSize <= 0 || storedSize > LogicalBlockSize)
            throw new InvalidDataException($"PFSC block {blockIndex} has an invalid stored size.");
        byte[] stored = ReadAt(source, checked(baseOffset + first), checked((int)storedSize));
        if (storedSize == LogicalBlockSize) return stored;

        byte[] output = new byte[LogicalBlockSize];
        using var input = new MemoryStream(stored, writable: false);
        using var zlib = new ZLibStream(input, CompressionMode.Decompress, leaveOpen: false);
        int total = 0;
        while (total < output.Length)
        {
            int read = zlib.Read(output, total, output.Length - total);
            if (read == 0) break;
            total += read;
        }
        if (total != output.Length || zlib.ReadByte() != -1)
            throw new InvalidDataException($"PFSC block {blockIndex} did not decode to exactly {LogicalBlockSize:N0} bytes.");
        return output;
    }

    private static async Task WriteHeaderAsync(Stream destination, long start, long[] offsets, long headerSize,
        int blockCount, CancellationToken cancellationToken)
    {
        byte[] header = new byte[HeaderRecordSize];
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(0x00, 4), Magic);
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(0x04, 4), 0);
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(0x08, 4), VersionField);
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(0x0C, 4), LogicalBlockSize);
        BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(0x10, 8), LogicalBlockSize);
        BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(0x18, 8), OffsetTableOffset);
        BinaryPrimitives.WriteUInt64LittleEndian(header.AsSpan(0x20, 8), checked((ulong)headerSize));
        BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(0x28, 8), checked((long)blockCount * LogicalBlockSize));
        destination.Position = start;
        await destination.WriteAsync(header, cancellationToken).ConfigureAwait(false);

        destination.Position = checked(start + OffsetTableOffset);
        byte[] tableChunk = new byte[Math.Min(offsets.Length, 8192) * OffsetEntrySize];
        int cursor = 0;
        while (cursor < offsets.Length)
        {
            int count = Math.Min(tableChunk.Length / OffsetEntrySize, offsets.Length - cursor);
            for (int index = 0; index < count; index++)
                BinaryPrimitives.WriteUInt64LittleEndian(tableChunk.AsSpan(index * OffsetEntrySize, OffsetEntrySize),
                    checked((ulong)offsets[cursor + index]));
            await destination.WriteAsync(tableChunk.AsMemory(0, count * OffsetEntrySize), cancellationToken).ConfigureAwait(false);
            cursor += count;
        }
    }

    private static long CalculateHeaderSize(int blockCount)
    {
        long tableSize = checked((long)(blockCount + 1) * OffsetEntrySize);
        long initialCapacity = InitialDataOffset - OffsetTableOffset;
        long extra = Math.Max(0, tableSize - initialCapacity);
        return checked(InitialDataOffset + DivideRoundUp(extra, LogicalBlockSize) * LogicalBlockSize);
    }

    private static long DivideRoundUp(long value, long divisor) => value == 0 ? 0 : checked((value - 1) / divisor + 1);

    private static async Task<int> ReadExactlyOrEndAsync(Stream stream, byte[] buffer, int count,
        CancellationToken cancellationToken)
    {
        int total = 0;
        while (total < count)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(total, count - total), cancellationToken).ConfigureAwait(false);
            if (read == 0) break;
            total += read;
        }
        return total;
    }

    private static byte[] ReadAt(Stream stream, long offset, int count)
    {
        if (offset < 0 || count < 0 || offset > stream.Length || count > stream.Length - offset)
            throw new InvalidDataException("PFSC read range is outside the source stream.");
        byte[] buffer = new byte[count];
        stream.Position = offset;
        stream.ReadExactly(buffer);
        return buffer;
    }
}
