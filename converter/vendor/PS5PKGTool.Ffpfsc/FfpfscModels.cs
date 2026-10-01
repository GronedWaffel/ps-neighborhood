namespace PS5PKGTool.Ffpfsc;

public sealed class FfpfscBuildOptions
{
    public const int DefaultPfsBlockSize = 0x10000;

    public int PfsBlockSize { get; init; } = DefaultPfsBlockSize;
    public bool CaseInsensitive { get; init; } = true;
    public bool OverwriteExisting { get; init; }
    public string? InnerFileName { get; init; }
    /// <summary>Optional deterministic timestamp for interoperability tests; normal builds use the current UTC time.</summary>
    public long? BuildTimestampUnixSeconds { get; init; }
    public PfscCompressionOptions Compression { get; init; } = new();

    internal void Validate()
    {
        if (PfsBlockSize is < 0x1000 or > 0x100000 || (PfsBlockSize & (PfsBlockSize - 1)) != 0)
            throw new ArgumentOutOfRangeException(nameof(PfsBlockSize),
                "The PFS block size must be a power of two between 4 KiB and 1 MiB.");
        if (BuildTimestampUnixSeconds is < 0 or > 253_402_300_799)
            throw new ArgumentOutOfRangeException(nameof(BuildTimestampUnixSeconds),
                "The optional build timestamp must be a valid Unix timestamp.");
        Compression.Validate();
    }
}

public readonly record struct FfpfscProgress(string Stage, long BytesProcessed, long TotalBytes);

public sealed class FfpfscBuildResult
{
    public required string OutputPath { get; init; }
    public required string InnerFileName { get; init; }
    public required long SourceLength { get; init; }
    public required long PfscStoredLength { get; init; }
    public required long ContainerLength { get; init; }
    public required int PfsBlockSize { get; init; }
    public required int PfscBlockCount { get; init; }
    public required int CompressedBlockCount { get; init; }
    public double PayloadSavingsPercent => SourceLength == 0
        ? 0
        : (SourceLength - PfscStoredLength) * 100.0 / SourceLength;
}

public sealed class FfpfscInfo
{
    public required int PfsVersion { get; init; }
    public required int PfsMode { get; init; }
    public required int PfsBlockSize { get; init; }
    public required long PfsBlockCount { get; init; }
    public required int InodeCount { get; init; }
    public required string InnerFileName { get; init; }
    public required long PayloadOffset { get; init; }
    public required long StoredLength { get; init; }
    public required long LogicalLength { get; init; }
    public required PfscInfo Pfsc { get; init; }
}

public sealed class FfpfscVerificationResult
{
    public FfpfscInfo? Info { get; init; }
    public required bool StructureValid { get; init; }
    public required bool EveryPfscBlockDecodes { get; init; }
    public bool? SourceMatches { get; init; }
    public string? SourceSha256 { get; init; }
    public string? DecodedSha256 { get; init; }
    public string? Error { get; init; }
}
