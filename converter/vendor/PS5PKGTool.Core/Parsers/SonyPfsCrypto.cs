using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using PS5PKGTool.Core.Models;
using ProsperoPkgTool.Crypto;

namespace PS5PKGTool.Core.Parsers;

internal static class SonyPfsCrypto
{
    public const ulong SignedSectorFlag = 0x800000000000UL;

    public static byte[] DeriveEkpfs(string contentId, string passcode)
    {
        if (contentId.Length != 36) throw new ArgumentException("Content ID must contain 36 characters.", nameof(contentId));
        if (passcode.Length != 32) throw new ArgumentException("Passcode must contain 32 characters.", nameof(passcode));
        Span<byte> index = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(index, 1);
        byte[] paddedContentId = new byte[48];
        Encoding.ASCII.GetBytes(contentId).CopyTo(paddedContentId, 0);
        byte[] input = new byte[96];
        // Use the engine's managed SHA3-256: the BCL SHA3_256 throws PlatformNotSupportedException on
        // Windows builds without CNG SHA-3 support, and this runs at the start of every package build.
        Sha3.Sha3_256(index).CopyTo(input, 0);
        Sha3.Sha3_256(paddedContentId).CopyTo(input, 32);
        Encoding.ASCII.GetBytes(passcode).CopyTo(input, 64);
        return Sha3.Sha3_256(input);
    }

    public static SonyPfsCryptoContext DeriveContext(byte[] ekpfs, ReadOnlySpan<byte> seed,
        int blockSize, bool newCrypt)
    {
        byte[] baseKey = newCrypt ? HMACSHA256.HashData(ekpfs, seed) : ekpfs;
        byte[] material = new byte[4 + seed.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(material, 1);
        seed.CopyTo(material.AsSpan(4));
        byte[] result = HMACSHA256.HashData(baseKey, material);
        return new SonyPfsCryptoContext(result[16..32], result[0..16], blockSize);
    }

    public static void DecryptBlock(Span<byte> block, SonyPfsCryptoContext context,
        ulong blockIndex, bool signedDomain)
        => TransformBlock(block, context, blockIndex, signedDomain, encrypt: false);

    public static void EncryptBlock(Span<byte> block, SonyPfsCryptoContext context,
        ulong blockIndex, bool signedDomain)
        => TransformBlock(block, context, blockIndex, signedDomain, encrypt: true);

    private static void TransformBlock(Span<byte> block, SonyPfsCryptoContext context,
        ulong blockIndex, bool signedDomain, bool encrypt)
    {
        if ((block.Length & 15) != 0) throw new InvalidDataException("An AES XTS block must be 16-byte aligned.");
        using Aes dataAes = CreateAes(context.DataKey);
        using Aes tweakAes = CreateAes(context.TweakKey);
        using ICryptoTransform dataTransform = encrypt ? dataAes.CreateEncryptor() : dataAes.CreateDecryptor();
        using ICryptoTransform tweakEncryptor = tweakAes.CreateEncryptor();
        byte[] tweakInput = new byte[16];
        BinaryPrimitives.WriteUInt64LittleEndian(tweakInput,
            signedDomain ? blockIndex | SignedSectorFlag : blockIndex);
        byte[] tweak = new byte[16];
        tweakEncryptor.TransformBlock(tweakInput, 0, 16, tweak, 0);
        byte[] temporary = new byte[16];
        byte[] transformed = new byte[16];
        for (int offset = 0; offset < block.Length; offset += 16)
        {
            for (int index = 0; index < 16; index++) temporary[index] = (byte)(block[offset + index] ^ tweak[index]);
            dataTransform.TransformBlock(temporary, 0, 16, transformed, 0);
            for (int index = 0; index < 16; index++) block[offset + index] = (byte)(transformed[index] ^ tweak[index]);
            MultiplyTweak(tweak);
        }
    }

    private static Aes CreateAes(byte[] key)
    {
        Aes aes = Aes.Create();
        aes.Mode = CipherMode.ECB;
        aes.Padding = PaddingMode.None;
        aes.KeySize = 128;
        aes.BlockSize = 128;
        aes.Key = key;
        return aes;
    }

    private static void MultiplyTweak(Span<byte> tweak)
    {
        int carry = 0;
        for (int index = 0; index < tweak.Length; index++)
        {
            int next = tweak[index] >> 7;
            tweak[index] = (byte)((tweak[index] << 1) | carry);
            carry = next;
        }
        if (carry != 0) tweak[0] ^= 0x87;
    }
}
