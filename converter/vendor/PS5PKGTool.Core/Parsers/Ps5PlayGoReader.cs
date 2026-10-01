using System.Buffers.Binary;
using System.Text;
using PS5PKGTool.Core.Models;
using ProsperoPkgTool.Containers;
using ProsperoPkgTool.Gp5;

namespace PS5PKGTool.Core.Parsers;

/// <summary>
/// Reads the PlayGo chunk map. Parsing is delegated to the vendored, validated
/// <c>ProsperoPkgTool.Gp5.PlayGoChunkReader</c>; the chunk records/scenario table come from the
/// plaintext <c>playgo-chunk.dat</c> PLGX blob (usually inside the SI archive) and the per-file chunk
/// assignments from the <c>playgo-hash-table.dat</c> + <c>playgo-ficm.dat</c> pair. A lenient
/// app-side parser is kept as a fallback for user files the strict engine reader rejects.
/// </summary>
public static class Ps5PlayGoReader
{
    private const uint PlgxMagic = 0x78676c70;

    public static Ps5PlayGoSummary Read(
        byte[]? plgx,
        byte[]? hashTable,
        byte[]? ficm,
        IReadOnlyDictionary<ulong, string>? pathByHash)
    {
        if (plgx is { Length: > 0x100 } && ReadU32(plgx, 0) == PlgxMagic)
        {
            try
            {
                return FromEngine(plgx, hashTable, ficm, pathByHash);
            }
            catch (InvalidDataException ex)
            {
                // The engine reader is strict by design; the GUI is intentionally lenient.
                return ReadLenient(plgx, hashTable, ficm, pathByHash, ex.Message);
            }
        }
        return ReadLenient(plgx, hashTable, ficm, pathByHash, string.Empty);
    }

    private static Ps5PlayGoSummary FromEngine(byte[] plgx, byte[]? hashTable, byte[]? ficm,
        IReadOnlyDictionary<ulong, string>? pathByHash)
    {
        PlayGoProject project = hashTable is { Length: >= 0x38 } && ficm is { Length: >= 0x10 }
            ? PlayGoChunkReader.Read(plgx, hashTable, ficm, pathByHash)
            : PlayGoChunkReader.Read(plgx);

        var totals = new Dictionary<int, (int Count, long Bytes)>();
        foreach (PlayGoExtent extent in project.Extents)
        {
            totals.TryGetValue(extent.ChunkId, out (int Count, long Bytes) current);
            long length = extent.Length > long.MaxValue ? long.MaxValue : (long)extent.Length;
            totals[extent.ChunkId] = (current.Count + 1, current.Bytes + length);
        }

        return new Ps5PlayGoSummary
        {
            ContentId = project.ContentId,
            DefaultScenarioId = project.DefaultScenarioId,
            HeaderFlags = (int)project.HeaderFlags,
            VersionMajor = project.VersionMajor,
            VersionMinor = project.VersionMinor,
            Chunks = project.Chunks.Select(chunk =>
            {
                totals.TryGetValue(chunk.Id, out (int Count, long Bytes) total);
                return new Ps5PlayGoChunk
                {
                    Id = chunk.Id,
                    Label = chunk.Label,
                    LanguageMask = chunk.LanguageMask,
                    ExtentCount = total.Count,
                    TotalBytes = total.Bytes
                };
            }).ToArray(),
            Scenarios = project.Scenarios.Select(scenario => new Ps5PlayGoScenario
            {
                Id = scenario.Id,
                Label = scenario.Label,
                InitialChunkCount = scenario.InitialChunkCount,
                Chunks = scenario.Chunks
            }).ToArray(),
            Files = project.Assignments.Select(assignment => new Ps5PlayGoFileChunk
            {
                PathHash = assignment.PathHash,
                ChunkId = assignment.ChunkId,
                Path = assignment.Path ?? string.Empty
            }).ToArray()
        };
    }

    private static Ps5PlayGoSummary ReadLenient(
        byte[]? plgx,
        byte[]? hashTable,
        byte[]? ficm,
        IReadOnlyDictionary<ulong, string>? pathByHash,
        string notice)
    {
        string contentId = string.Empty;
        int defaultScenario = 0;
        int headerFlags = 0;
        int versionMajor = 0;
        int versionMinor = 0;
        List<Ps5PlayGoChunk> chunks = [];
        List<Ps5PlayGoScenario> scenarios = [];

        if (plgx is { Length: > 0x100 } && ReadU32(plgx, 0) == PlgxMagic)
        {
            contentId = ReadAsciiZ(plgx, 0x40);
            defaultScenario = ReadU16(plgx, 0x14);
            headerFlags = (int)ReadU32(plgx, 0x1C);
            versionMajor = ReadU16(plgx, 0x04);
            versionMinor = ReadU16(plgx, 0x06);
            int chunkCount = ReadU16(plgx, 0x0A);
            int scenarioCount = ReadU16(plgx, 0x0E);

            Section(plgx, 0xC0, out int chunkStart, out int chunkSize);
            Section(plgx, 0xC8, out int listStart, out _);
            Section(plgx, 0xD0, out int labelStart, out int labelSize);
            Section(plgx, 0xD8, out int extentStart, out int extentSize);
            Section(plgx, 0xE0, out int scenStart, out int scenSize);
            Section(plgx, 0xE8, out int seqStart, out _);
            Section(plgx, 0xF0, out int scenLabelStart, out int scenLabelSize);

            int maxChunk = Math.Min(chunkCount, Math.Max(0, chunkSize / 0x20));
            int extentCount = Math.Max(0, extentSize / 16);

            for (int i = 0; i < maxChunk; i++)
            {
                int record = chunkStart + (i * 0x20);
                int extentIdCount = (int)ReadU32(plgx, record + 0x04);
                ulong languageMask = ReadU64(plgx, record + 0x10);
                int listOffset = (int)ReadU32(plgx, record + 0x18);
                int labelOffset = (int)ReadU32(plgx, record + 0x1C);

                long total = 0;
                int count = 0;
                for (int j = 0; j < extentIdCount; j++)
                {
                    int id = (int)ReadU32(plgx, listStart + listOffset + (j * 4));
                    if (id < 0 || id >= extentCount) continue;
                    long length = (long)ReadU64(plgx, extentStart + (id * 16) + 8);
                    if (length < 0) continue;
                    total += length;
                    count++;
                }

                chunks.Add(new Ps5PlayGoChunk
                {
                    Id = i,
                    Label = ReadLabel(plgx, labelStart, labelSize, labelOffset),
                    LanguageMask = languageMask,
                    ExtentCount = count,
                    TotalBytes = total
                });
            }

            int maxScenario = Math.Min(scenarioCount, Math.Max(0, scenSize / 0x20));
            for (int i = 0; i < maxScenario; i++)
            {
                int record = scenStart + (i * 0x20);
                int initial = ReadU16(plgx, record + 0x14);
                int sequenceCount = ReadU16(plgx, record + 0x16);
                int sequenceOffset = (int)ReadU32(plgx, record + 0x18);
                int labelOffset = (int)ReadU32(plgx, record + 0x1C);

                var sequence = new List<int>(sequenceCount);
                for (int j = 0; j < sequenceCount; j++)
                    sequence.Add(ReadU16(plgx, seqStart + sequenceOffset + (j * 2)));

                scenarios.Add(new Ps5PlayGoScenario
                {
                    Id = i,
                    Label = ReadLabel(plgx, scenLabelStart, scenLabelSize, labelOffset),
                    InitialChunkCount = initial,
                    Chunks = sequence
                });
            }
        }

        List<Ps5PlayGoFileChunk> files = [];
        if (hashTable is { Length: >= 0x38 } && ficm is { Length: >= 0x10 })
        {
            int hashCount = (int)ReadU32(hashTable, 0x24);
            int count = hashCount;
            uint declaredFicmBytes = ReadU32(ficm, 0x0C);
            if (declaredFicmBytes >= 2 && declaredFicmBytes % 2 == 0 && declaredFicmBytes <= ficm.Length - 0x10)
                count = (int)(declaredFicmBytes / 2);
            int max = Math.Min(count, (hashTable.Length - 0x38) / 8);
            max = Math.Min(max, (ficm.Length - 0x10) / 2);
            if (max < 0) max = 0;
            for (int i = 0; i < max; i++)
            {
                ulong hash = ReadU64(hashTable, 0x38 + (i * 8));
                int chunk = ReadU16(ficm, 0x10 + (i * 2));
                string path = string.Empty;
                if (pathByHash is not null && pathByHash.TryGetValue(hash, out string? resolved))
                    path = resolved;
                files.Add(new Ps5PlayGoFileChunk { PathHash = hash, Path = path, ChunkId = chunk });
            }
        }

        return new Ps5PlayGoSummary
        {
            ContentId = contentId,
            DefaultScenarioId = defaultScenario,
            HeaderFlags = headerFlags,
            VersionMajor = versionMajor,
            VersionMinor = versionMinor,
            Notice = notice,
            Chunks = chunks,
            Scenarios = scenarios,
            Files = files
        };
    }

    /// <summary>The FLT path hash used by <c>playgo-hash-table.dat</c> (delegates to the engine).</summary>
    public static ulong PathHash(string path) => ProsperoOuterPfsBuilder.FltPathHash(path);

    /// <summary>
    /// Best-effort map of FLT path hash to inner-image relative path. The hash table uses the
    /// normalized inner-image relative path with no leading slash.
    /// </summary>
    public static IReadOnlyDictionary<ulong, string> BuildPathMap(IEnumerable<string> relativePaths)
    {
        var map = new Dictionary<ulong, string>();
        foreach (string raw in relativePaths)
        {
            if (string.IsNullOrWhiteSpace(raw)) continue;
            string path = raw.Replace('\\', '/').TrimStart('/');
            map.TryAdd(PathHash(path), path);
        }
        return map;
    }

    private static string ReadLabel(byte[] data, int labelStart, int labelSize, int offset)
    {
        if (offset < 0 || offset >= labelSize) return string.Empty;
        int start = labelStart + offset;
        if (start < 0 || start >= data.Length) return string.Empty;
        int end = start;
        while (end < data.Length && end - start < 256 && data[end] != 0) end++;
        return Encoding.ASCII.GetString(data, start, end - start);
    }

    private static void Section(byte[] data, int directoryOffset, out int start, out int size)
    {
        start = (int)ReadU32(data, directoryOffset);
        size = (int)ReadU32(data, directoryOffset + 4);
        if (start < 0 || start > data.Length) { start = 0; size = 0; }
        else if (size < 0 || start + size > data.Length) size = data.Length - start;
    }

    private static ushort ReadU16(byte[] data, int offset) =>
        offset >= 0 && offset + 2 <= data.Length ? BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(offset)) : (ushort)0;

    private static uint ReadU32(byte[] data, int offset) =>
        offset >= 0 && offset + 4 <= data.Length ? BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(offset)) : 0u;

    private static ulong ReadU64(byte[] data, int offset) =>
        offset >= 0 && offset + 8 <= data.Length ? BinaryPrimitives.ReadUInt64LittleEndian(data.AsSpan(offset)) : 0ul;

    private static string ReadAsciiZ(byte[] data, int offset)
    {
        if (offset < 0 || offset >= data.Length) return string.Empty;
        int end = offset;
        while (end < data.Length && end - offset < 128 && data[end] != 0) end++;
        return Encoding.ASCII.GetString(data, offset, end - offset);
    }
}
