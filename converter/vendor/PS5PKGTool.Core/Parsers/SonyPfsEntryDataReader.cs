using PS5PKGTool.Core.Models;
using ProsperoPkgTool.Containers;

namespace PS5PKGTool.Core.Parsers;

internal static class SonyPfsEntryDataReader
{
    public static byte[] ReadAll(string packagePath, SonyPkgSummary package, SonyPfsSummary image,
        SonyPfsEntry entry, int maximumBytes)
    {
        if (entry.Size < 0 || entry.Size > maximumBytes || entry.Size > Array.MaxLength)
            throw new InvalidDataException($"The PFS entry exceeds the {maximumBytes:N0} byte read limit.");
        if (entry.Extents.Sum(extent => extent.Length) < entry.Size)
            throw new InvalidDataException("The PFS entry has too few data extents.");

        return ReadRange(packagePath, package, image, entry, 0, checked((int)entry.Size));
    }

    public static byte[] ReadRange(string packagePath, SonyPkgSummary package, SonyPfsSummary image,
        SonyPfsEntry entry, long offset, int count)
    {
        if (offset < 0 || count < 0 || offset > entry.Size || count > entry.Size - offset)
            throw new ArgumentOutOfRangeException(nameof(offset));
        if (image.EngineAccess is { } engine)
        {
            if (!engine.TryFindFile(entry.RelativePath, out ProsperoInnerPfsReader.Entry inner))
                throw new InvalidDataException($"The PFS entry '{entry.RelativePath}' is not present in the reconstructed image.");
            return engine.ReadFileRange(inner, offset, count);
        }

        byte[] output = new byte[count];
        using var stream = new FileStream(packagePath, FileMode.Open, FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete, 64 * 1024, FileOptions.RandomAccess);
        int written = 0;
        long skip = offset;
        foreach (SonyPfsExtent extent in entry.Extents)
        {
            if (skip >= extent.Length) { skip -= extent.Length; continue; }
            long extentOffset = checked(extent.Offset + skip);
            long available = extent.Length - skip;
            int wanted = checked((int)Math.Min(available, output.Length - written));
            if (wanted == 0) break;
            int consumed = 0;
            while (consumed < wanted)
            {
                long current = extentOffset + consumed;
                long relativeBlock = image.BlockSize == 0 ? 0 : current / image.BlockSize;
                int innerOffset = image.BlockSize == 0 ? 0 : checked((int)(current % image.BlockSize));
                int take = image.BlockSize == 0 ? wanted - consumed :
                    Math.Min(wanted - consumed, checked((int)image.BlockSize - innerOffset));
                long absolute = checked((long)package.PfsImageOffset + current - innerOffset);
                if (image.CryptoContext is null)
                {
                    stream.Position = checked(absolute + innerOffset);
                    stream.ReadExactly(output.AsSpan(written + consumed, take));
                }
                else
                {
                    byte[] block = new byte[image.CryptoContext.BlockSize];
                    stream.Position = absolute;
                    stream.ReadExactly(block);
                    SonyPfsCrypto.DecryptBlock(block, image.CryptoContext, checked((ulong)relativeBlock),
                        !entry.UsesPlainDataSector);
                    block.AsSpan(innerOffset, take).CopyTo(output.AsSpan(written + consumed));
                }
                consumed += take;
            }
            written += wanted;
            skip = 0;
        }
        if (written != output.Length) throw new EndOfStreamException("The PFS entry ended unexpectedly.");
        return output;
    }
}
