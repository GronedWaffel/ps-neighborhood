using System.Security.Cryptography;
using System.Text;
using PS5PKGTool.Core.Parsers;

namespace PS5PKGTool.Core.Builders;

public sealed class SonyDebugPackageCredentials
{
    public const string DefaultPasscode = "00000000000000000000000000000000";

    private SonyDebugPackageCredentials(string contentId, string passcode, byte[] imageKey)
    {
        ContentId = contentId;
        Passcode = passcode;
        ImageKey = imageKey;
        Fingerprint = Convert.ToHexString(SHA256.HashData(imageKey)).ToLowerInvariant();
    }

    public string ContentId { get; }
    public string Passcode { get; }
    public byte[] ImageKey { get; }
    public string Fingerprint { get; }
    public bool UsesDefaultPasscode => Passcode == DefaultPasscode;

    public static SonyDebugPackageCredentials Create(string contentId, string? passcode = null)
    {
        string id = (contentId ?? string.Empty).Trim().ToUpperInvariant();
        string secret = passcode ?? DefaultPasscode;
        ValidateContentId(id);
        ValidatePasscode(secret);
        return new SonyDebugPackageCredentials(id, secret, SonyPfsCrypto.DeriveEkpfs(id, secret));
    }

    public static void ValidatePasscode(string passcode)
    {
        ArgumentNullException.ThrowIfNull(passcode);
        if (passcode.Length != 32)
            throw new ArgumentException("Passcode must contain exactly 32 ASCII characters.", nameof(passcode));
        if (Encoding.ASCII.GetByteCount(passcode) != 32 || passcode.Any(character => character < 0x20 || character > 0x7E))
            throw new ArgumentException("Passcode must contain only printable ASCII characters.", nameof(passcode));
    }

    private static void ValidateContentId(string contentId)
    {
        if (contentId.Length != 36 || contentId[6] != '-' || contentId[16] != '_' || contentId[19] != '-' ||
            contentId.Any(character => !(character is >= 'A' and <= 'Z' or >= '0' and <= '9' or '-' or '_')))
            throw new ArgumentException("Content ID must use the 36-character Sony package format.", nameof(contentId));
    }
}
