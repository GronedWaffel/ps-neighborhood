namespace PS5PKGTool.Ffpfsc;

public sealed class PfscCompressionOptions
{
    public int CompressionLevel { get; init; } = 9;
    public int MinimumGainPercent { get; init; } = 5;

    internal void Validate()
    {
        if (CompressionLevel is < 0 or > 9)
            throw new ArgumentOutOfRangeException(nameof(CompressionLevel), "Compression level must be between 0 and 9.");
        if (MinimumGainPercent is < 0 or > 100)
            throw new ArgumentOutOfRangeException(nameof(MinimumGainPercent), "Minimum gain must be between 0 and 100 percent.");
    }
}

public readonly record struct PfscProgress(long BytesProcessed, long TotalBytes, int BlocksProcessed, int TotalBlocks);

public sealed class PfscWriteResult
{
    public required long SourceLength { get; init; }
    public required long PaddedLogicalLength { get; init; }
    public required long StoredLength { get; init; }
    public required int BlockCount { get; init; }
    public required int CompressedBlockCount { get; init; }
    public required long HeaderSize { get; init; }
    public double SavingsPercent => SourceLength == 0 ? 0 : (SourceLength - StoredLength) * 100.0 / SourceLength;
}

public sealed class PfscInfo
{
    public required int LogicalBlockSize { get; init; }
    public required long OffsetTableOffset { get; init; }
    public required long DataOffset { get; init; }
    public required long PaddedLogicalLength { get; init; }
    public required long StoredLength { get; init; }
    public required IReadOnlyList<long> BlockOffsets { get; init; }
    public int BlockCount => BlockOffsets.Count - 1;
}
