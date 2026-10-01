using System.Security.Cryptography;
using System.Text.Json;
using PS5PKGTool.Core.Parsers;
using PS5PKGTool.Core.Services;
using PS5PKGTool.Ffpfsc;

static class Conversion {
    static readonly object Gate = new();
    public static void Emit(object value) { lock (Gate) Console.WriteLine(JsonSerializer.Serialize(value)); }
    sealed class Reporter<T>(Action<T> action) : IProgress<T> { public void Report(T value) => action(value); }
    static long Last;
    static void Progress(string stage, long done = 0, long total = 0, string? file = null, bool force = false) {
        long now = Environment.TickCount64;
        if (!force && now - Last < 400) return;
        Last = now; Emit(new { type = "progress", stage, done, total, file });
    }
    static string Contained(string root, string name) {
        name = name.Replace('\\', '/');
        if (Path.IsPathRooted(name) || name.Split('/').Any(p => p is "." or ".." || p.Length == 0 || p.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || p.EndsWith('.') || p.EndsWith(' ')))
            throw new IOException("Unsafe package metadata path");
        string full = Path.GetFullPath(Path.Combine(root, name));
        if (!full.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("Metadata escapes output");
        return full;
    }
    public static async Task Run(string input, string work, string title, CancellationToken token) {
        input = Path.GetFullPath(input); work = Path.GetFullPath(work);
        if (!System.Text.RegularExpressions.Regex.IsMatch(title, "^PPSA[0-9]{5}$")) throw new IOException("Invalid title ID");
        if (!Directory.Exists(work) || Directory.EnumerateFileSystemEntries(work).Any(p => Path.GetFileName(p) != "temp")) throw new IOException("Conversion work directory must be empty");
        // Hold a write-blocking handle for the complete conversion, including independent verification.
        using var lockedSource = new FileStream(input, FileMode.Open, FileAccess.Read, FileShare.Read);
        var reader = new SonyPkgReader(); var summary = reader.Read(input);
        if (summary.SignedByte != 0 || summary.ContentId.Substring(7, 9) != title || summary.Kind.ToString() != "FinalizedDebug" || (summary.ContentFlags & 0x40100000) != 0 || summary.ContentType != 0x20)
            throw new IOException("Only finalized debug PS5 base-game packages can be converted");
        var before = new FileInfo(input); long size = before.Length; var modified = before.LastWriteTimeUtc;
        string unpacked = Path.Combine(work, "unpacked"), output = Path.Combine(work, title + ".ffpfsc");
        Progress("Decoding package", force: true);
        await SonyPackageExtraction.ExtractAsync(input, unpacked, progress: new Reporter<SonyPackageExtractProgress>(p => Progress("Extracting", p.CompletedBytes, p.TotalBytes, p.CurrentPath)), cancellationToken: token);
        Progress("Restoring game metadata", force: true);
        string metadata = Path.Combine(unpacked, "sce_sys"); Directory.CreateDirectory(metadata);
        foreach (var entry in summary.Entries) {
            token.ThrowIfCancellationRequested();
            if (entry.IsEncrypted || entry.DataSize > 32 * 1024 * 1024 || string.IsNullOrWhiteSpace(entry.Name)) continue;
            string name = entry.Name.Replace('\\', '/'); if (name.StartsWith("sce_sys/")) name = name[8..];
            if (!new[] { ".json", ".dds", ".png", ".at9", ".dat", ".trp", ".ucp", ".xml" }.Contains(Path.GetExtension(name).ToLowerInvariant())) continue;
            string dest = Contained(metadata, name);
            byte[] bytes = reader.ReadEntryBytes(input, summary, entry, 32 * 1024 * 1024);
            if (File.Exists(dest)) {
                if (!File.ReadAllBytes(dest).AsSpan().SequenceEqual(bytes)) throw new IOException("Conflicting inner and CNT metadata: " + name);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!); await File.WriteAllBytesAsync(dest, bytes, token);
        }
        using var param = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(metadata, "param.json"), token));
        if (param.RootElement.GetProperty("titleId").GetString() != title || !File.Exists(Path.Combine(unpacked, "eboot.bin"))) throw new IOException("Game metadata or executable is missing/mismatched");
        var reportProgress = new Reporter<FfpfscProgress>(p => Progress(p.Stage, p.BytesProcessed, p.TotalBytes));
        Progress("Packing ShadowMount image", force: true);
        var packed = await FfpfscImage.CreateFromDirectoryAsync(unpacked, output, new FfpfscBuildOptions { InnerFileName = title + ".exfat", Compression = new PfscCompressionOptions { CompressionLevel = 1 } }, progress: reportProgress, cancellationToken: token);
        Progress("Verifying every image block", force: true);
        var verified = await FfpfscImage.VerifyAsync(output, progress: reportProgress, cancellationToken: token);
        if (!verified.StructureValid || !verified.EveryPfscBlockDecodes) throw new IOException("Image block verification failed");
        Progress("Comparing image with extracted files", force: true);
        using var original = ExfatImage.OpenDirectory(unpacked);
        string sourceHash = Convert.ToHexString(await SHA256.HashDataAsync(original.Stream, token));
        if (original.Length != verified.Info?.LogicalLength || sourceHash != verified.DecodedSha256) throw new IOException("Image does not match extracted files");
        original.Dispose();
        before.Refresh(); if (size != before.Length || modified != before.LastWriteTimeUtc) throw new IOException("Source package changed during conversion");
        Progress("Hashing verified image", force: true);
        using var image = File.OpenRead(output);
        string imageHash = Convert.ToHexString(await SHA256.HashDataAsync(image, token)); image.Dispose();
        var report = new { titleId = title, source = input, sourceSize = size, sourceModifiedUtc = modified, output, imageSize = packed.ContainerLength, imageSha256 = imageHash, sourceSha256 = sourceHash, decodedSha256 = verified.DecodedSha256, verified = true };
        await File.WriteAllTextAsync(output + ".verified.json", JsonSerializer.Serialize(report), token);
        // Only our fixed extraction directory is removed after both verification passes.
        Directory.Delete(unpacked, true);
        Emit(new { type = "complete", report });
    }
    public static async Task SelfTest() {
        foreach (int length in new[] { 1, 65536, 65537, 128 * 65536, 129 * 65536 + 13 }) {
            byte[] bytes = new byte[length]; new Random(length).NextBytes(bytes); Array.Clear(bytes, 0, length / 2);
            using var input = new MemoryStream(bytes); using var encoded = new MemoryStream(); using var decoded = new MemoryStream();
            await PfscCodec.EncodeAsync(input, length, encoded, new PfscCompressionOptions { CompressionLevel = 1 }); encoded.Position = 0;
            await PfscCodec.DecodeAsync(encoded, decoded, length);
            if (!bytes.AsSpan().SequenceEqual(decoded.ToArray())) throw new Exception("PFSC roundtrip failed");
        }
        foreach (var bad in new[] { "../a", "/a", "a/../../b", "a:b", "a/./b", "a//b", "x./y" }) {
            try { Contained(Path.GetTempPath(), bad); throw new Exception("Unsafe metadata path accepted: " + bad); } catch (IOException) { }
        }
        Emit(new { type = "selftest", passed = true });
    }
}
