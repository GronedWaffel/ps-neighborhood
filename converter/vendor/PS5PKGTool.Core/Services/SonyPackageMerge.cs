using PS5PKGTool.Core.Parsers;

namespace PS5PKGTool.Core.Services;

public sealed class SonyPackageMergeValidation
{
    public required bool IsValid { get; init; }
    public required string Message { get; init; }
    public required long CombinedBytes { get; init; }
}

public static class SonyPackageMerge
{
    public static async Task MergeManifestAtomicAsync(string manifestPath, string outputPath,
        CancellationToken cancellationToken = default)
    {
        IReadOnlyList<string> pieces = await SonyPackageSplit.GetValidatedPiecePathsAsync(manifestPath,
            cancellationToken).ConfigureAwait(false);
        await MergeAtomicAsync(pieces, outputPath, cancellationToken).ConfigureAwait(false);
    }

    public static SonyPackageMergeValidation Validate(IReadOnlyList<string> pieces)
    {
        if (pieces is null || pieces.Count < 2) return new() { IsValid = false, Message = "At least two package pieces are required.", CombinedBytes = 0 };
        try
        {
            long total = 0;
            foreach (string path in pieces)
            {
                if (!File.Exists(path)) return new() { IsValid = false, Message = "A package piece is missing: " + path, CombinedBytes = total };
                total = checked(total + new FileInfo(path).Length);
            }
            using var first = File.OpenRead(pieces[0]); Span<byte> magic = stackalloc byte[4]; first.ReadExactly(magic);
            bool isFih = magic[0] == 0x7F && magic[1] == 'F' && magic[2] == 'I' && magic[3] == 'H';
            return new() { IsValid = isFih, CombinedBytes = total, Message = isFih ? "Split set begins with an FIH package header." : "The first split piece does not begin with FIH magic." };
        }
        catch (Exception ex) when (ex is IOException or OverflowException) { return new() { IsValid = false, Message = ex.Message, CombinedBytes = 0 }; }
    }

    public static async Task MergeAtomicAsync(IReadOnlyList<string> pieces, string outputPath, CancellationToken cancellationToken = default)
    {
        SonyPackageMergeValidation validation = Validate(pieces);
        if (!validation.IsValid) throw new InvalidDataException(validation.Message);
        string destination = Path.GetFullPath(outputPath); string? parent = Path.GetDirectoryName(destination);
        if (string.IsNullOrWhiteSpace(parent)) throw new ArgumentException("Output path has no parent directory.", nameof(outputPath));
        Directory.CreateDirectory(parent); string temporary = Path.Combine(parent, "." + Path.GetFileName(destination) + "." + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, FileOptions.Asynchronous))
            {
                foreach (string piece in pieces)
                {
                    await using var input = new FileStream(piece, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
                    await input.CopyToAsync(output, 1024 * 1024, cancellationToken).ConfigureAwait(false);
                }
                await output.FlushAsync(cancellationToken).ConfigureAwait(false);
            }
            File.Move(temporary, destination, true);
        }
        finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch (IOException) { } }
    }
}
