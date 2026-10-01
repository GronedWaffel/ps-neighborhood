using System.Security.Cryptography;
using System.Text.Json;

namespace PS5PKGTool.Core.Services;

public sealed class SonyPackageSplitOptions
{
    public long MaximumPieceBytes { get; init; } = 4L * 1024 * 1024 * 1024;
    public int CrcBlockBytes { get; init; } = 0x10000;
}

public readonly record struct SonyPackageSplitProgress(long CompletedBytes, long TotalBytes, string CurrentPiece);
public sealed record SonyPackageSplitPiece(string FileName, long Bytes, string Sha256, uint[] Crc32C);
public sealed class SonyPackageSplitManifest
{
    public int Version { get; init; } = 1;
    public required string SourceFileName { get; init; }
    public required long SourceBytes { get; init; }
    public required string SourceSha256 { get; init; }
    public required int CrcBlockBytes { get; init; }
    public required IReadOnlyList<SonyPackageSplitPiece> Pieces { get; init; }
}

public sealed class SonyPackageSplitResult
{
    public required string ManifestPath { get; init; }
    public required SonyPackageSplitManifest Manifest { get; init; }
}

public static class SonyPackageSplit
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public static async Task<SonyPackageSplitResult> CreateAsync(string packagePath, string outputDirectory,
        SonyPackageSplitOptions? options = null, IProgress<SonyPackageSplitProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packagePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputDirectory);
        options ??= new SonyPackageSplitOptions();
        ValidateOptions(options);
        string source = Path.GetFullPath(packagePath);
        if (!File.Exists(source)) throw new FileNotFoundException("The package does not exist.", source);
        string destination = Path.GetFullPath(outputDirectory);
        Directory.CreateDirectory(destination);
        if (Directory.EnumerateFileSystemEntries(destination).Any())
            throw new IOException("The split destination must be empty: " + destination);

        long total = new FileInfo(source).Length;
        string stem = Path.GetFileNameWithoutExtension(source);
        string extension = Path.GetExtension(source);
        var pieces = new List<SonyPackageSplitPiece>();
        var created = new List<string>();
        long completed = 0;
        try
        {
            await using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read,
                1024 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
            for (int index = 0; input.Position < input.Length; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                string name = $"{stem}.part{index:D3}{extension}";
                string target = Path.Combine(destination, name);
                created.Add(target);
                long remaining = Math.Min(options.MaximumPieceBytes, input.Length - input.Position);
                uint[] crc = new uint[checked((int)((remaining + options.CrcBlockBytes - 1) / options.CrcBlockBytes))];
                using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                await using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                                 1024 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan))
                {
                    byte[] buffer = new byte[options.CrcBlockBytes];
                    for (int block = 0; block < crc.Length; block++)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        int wanted = checked((int)Math.Min(buffer.Length, remaining));
                        await input.ReadExactlyAsync(buffer.AsMemory(0, wanted), cancellationToken).ConfigureAwait(false);
                        await output.WriteAsync(buffer.AsMemory(0, wanted), cancellationToken).ConfigureAwait(false);
                        sha.AppendData(buffer, 0, wanted);
                        crc[block] = Ps5Crc32C.Compute(buffer.AsSpan(0, wanted));
                        remaining -= wanted;
                        completed += wanted;
                        progress?.Report(new SonyPackageSplitProgress(completed, total, name));
                    }
                    await output.FlushAsync(cancellationToken).ConfigureAwait(false);
                }
                pieces.Add(new SonyPackageSplitPiece(name, new FileInfo(target).Length,
                    Convert.ToHexString(sha.GetHashAndReset()).ToLowerInvariant(), crc));
            }
            string sourceSha = await ComputeSha256Async(source, cancellationToken).ConfigureAwait(false);
            var manifest = new SonyPackageSplitManifest
            {
                SourceFileName = Path.GetFileName(source), SourceBytes = total, SourceSha256 = sourceSha,
                CrcBlockBytes = options.CrcBlockBytes, Pieces = pieces
            };
            string manifestPath = Path.Combine(destination, stem + ".ps5split.json");
            await WriteManifestAtomicAsync(manifestPath, manifest, cancellationToken).ConfigureAwait(false);
            return new SonyPackageSplitResult { ManifestPath = manifestPath, Manifest = manifest };
        }
        catch
        {
            foreach (string path in created)
            {
                try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { }
            }
            throw;
        }
    }

    public static async Task<SonyPackageMergeValidation> ValidateManifestAsync(string manifestPath,
        CancellationToken cancellationToken = default)
    {
        try
        {
            string source = Path.GetFullPath(manifestPath);
            SonyPackageSplitManifest manifest = JsonSerializer.Deserialize<SonyPackageSplitManifest>(
                await File.ReadAllTextAsync(source, cancellationToken).ConfigureAwait(false), JsonOptions)
                ?? throw new InvalidDataException("The split manifest is empty.");
            if (manifest.Version != 1 || manifest.Pieces.Count < 2 || manifest.CrcBlockBytes <= 0)
                return Invalid("The split manifest has unsupported values.");
            string root = Path.GetDirectoryName(source)!;
            long total = 0;
            foreach (SonyPackageSplitPiece piece in manifest.Pieces)
            {
                if (!IsSafeFileName(piece.FileName)) return Invalid("The split manifest contains an unsafe piece name.");
                string path = Path.Combine(root, piece.FileName);
                if (!File.Exists(path) || new FileInfo(path).Length != piece.Bytes) return Invalid("A split piece is missing or has an unexpected size: " + piece.FileName);
                if (!string.Equals(await ComputeSha256Async(path, cancellationToken).ConfigureAwait(false), piece.Sha256, StringComparison.OrdinalIgnoreCase))
                    return Invalid("SHA-256 mismatch for split piece: " + piece.FileName);
                await ValidateCrcAsync(path, piece, manifest.CrcBlockBytes, cancellationToken).ConfigureAwait(false);
                total = checked(total + piece.Bytes);
            }
            if (total != manifest.SourceBytes) return Invalid("Split-piece sizes do not equal the recorded original size.");
            return new SonyPackageMergeValidation { IsValid = true, Message = "Split manifest and all piece checksums are valid.", CombinedBytes = total };
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or JsonException or OverflowException)
        {
            return Invalid(ex.Message);
        }
    }

    public static async Task<IReadOnlyList<string>> GetValidatedPiecePathsAsync(string manifestPath,
        CancellationToken cancellationToken = default)
    {
        SonyPackageMergeValidation validation = await ValidateManifestAsync(manifestPath, cancellationToken).ConfigureAwait(false);
        if (!validation.IsValid) throw new InvalidDataException(validation.Message);
        string source = Path.GetFullPath(manifestPath);
        SonyPackageSplitManifest manifest = JsonSerializer.Deserialize<SonyPackageSplitManifest>(
            await File.ReadAllTextAsync(source, cancellationToken).ConfigureAwait(false), JsonOptions)
            ?? throw new InvalidDataException("The split manifest is empty.");
        string root = Path.GetDirectoryName(source)!;
        return manifest.Pieces.Select(piece => Path.Combine(root, piece.FileName)).ToArray();
    }

    private static async Task ValidateCrcAsync(string path, SonyPackageSplitPiece piece, int blockSize, CancellationToken token)
    {
        await using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
            blockSize, FileOptions.Asynchronous | FileOptions.SequentialScan);
        byte[] buffer = new byte[blockSize];
        for (int index = 0; index < piece.Crc32C.Length; index++)
        {
            int read = 0;
            while (read < buffer.Length)
            {
                int received = await input.ReadAsync(buffer.AsMemory(read), token).ConfigureAwait(false);
                if (received == 0) break;
                read += received;
            }
            if (read == 0 || Ps5Crc32C.Compute(buffer.AsSpan(0, read)) != piece.Crc32C[index])
                throw new InvalidDataException("CRC-32C mismatch for split piece: " + piece.FileName);
        }
        if (input.Position != input.Length) throw new InvalidDataException("The CRC-32C table does not cover split piece: " + piece.FileName);
    }

    private static async Task<string> ComputeSha256Async(string path, CancellationToken token)
    {
        await using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
            1024 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        byte[] buffer = new byte[1024 * 1024];
        int read;
        while ((read = await input.ReadAsync(buffer, token).ConfigureAwait(false)) > 0) hash.AppendData(buffer, 0, read);
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static async Task WriteManifestAtomicAsync(string destination, SonyPackageSplitManifest manifest, CancellationToken token)
    {
        string temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(manifest, JsonOptions), token).ConfigureAwait(false);
            File.Move(temporary, destination, true);
        }
        finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch (IOException) { } }
    }

    private static bool IsSafeFileName(string value) => !string.IsNullOrWhiteSpace(value) &&
        value == Path.GetFileName(value) && !value.Contains("..", StringComparison.Ordinal) && !value.Any(char.IsControl);
    private static void ValidateOptions(SonyPackageSplitOptions options)
    {
        if (options.CrcBlockBytes < 0x1000 || (options.CrcBlockBytes & (options.CrcBlockBytes - 1)) != 0)
            throw new ArgumentOutOfRangeException(nameof(options), "CRC block size must be a power of two of at least 4 KiB.");
        if (options.MaximumPieceBytes < options.CrcBlockBytes || options.MaximumPieceBytes % options.CrcBlockBytes != 0)
            throw new ArgumentOutOfRangeException(nameof(options), "Maximum piece size must be an exact multiple of the CRC block size.");
    }
    private static SonyPackageMergeValidation Invalid(string message) => new() { IsValid = false, Message = message, CombinedBytes = 0 };
}
