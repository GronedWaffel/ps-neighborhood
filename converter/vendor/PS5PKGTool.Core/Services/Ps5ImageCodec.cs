using BCnEncoder.Decoder;
using BCnEncoder.ImageSharp;
using PS5PKGTool.Core.Models;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;

namespace PS5PKGTool.Core.Services;

public static class Ps5ImageCodec
{
    public static byte[] DecodeDdsToPng(Stream ddsStream)
    {
        ArgumentNullException.ThrowIfNull(ddsStream);
        if (!ddsStream.CanRead) throw new ArgumentException("The DDS stream must be readable.", nameof(ddsStream));
        var decoder = new BcDecoder();
        using Image<Rgba32> image = decoder.DecodeToImageRgba32(ddsStream);
        using var output = new MemoryStream();
        image.SaveAsPng(output);
        return output.ToArray();
    }

    /// <summary>
    /// Decodes a DDS/BC texture to raw RGBA pixels. The UI builds a bitmap straight from these bytes,
    /// avoiding the intermediate PNG encode/decode a re-encoded PNG would require.
    /// </summary>
    public static (byte[] Rgba, int Width, int Height) DecodeDdsToRgba(Stream ddsStream)
    {
        ArgumentNullException.ThrowIfNull(ddsStream);
        if (!ddsStream.CanRead) throw new ArgumentException("The DDS stream must be readable.", nameof(ddsStream));
        var decoder = new BcDecoder();
        using Image<Rgba32> image = decoder.DecodeToImageRgba32(ddsStream);
        byte[] rgba = new byte[checked(image.Width * image.Height * 4)];
        image.CopyPixelDataTo(rgba);
        return (rgba, image.Width, image.Height);
    }

    /// <summary>
    /// Decodes a PNG and resizes it to <paramref name="width"/> x <paramref name="height"/> raw RGBA.
    /// Used to pre-build small grid thumbnails (for example trophy icons) on the background thread so
    /// the UI only has to blit the pixels. Returns null when the bytes are not a decodable image.
    /// </summary>
    public static Ps5ImageData? DecodePngToRgba(byte[] pngBytes, int width, int height)
    {
        if (pngBytes is null || pngBytes.Length == 0 || width <= 0 || height <= 0) return null;
        try
        {
            using Image<Rgba32> image = Image.Load<Rgba32>(pngBytes);
            image.Mutate(context => context.Resize(width, height));
            byte[] rgba = new byte[checked(width * height * 4)];
            image.CopyPixelDataTo(rgba);
            return Ps5ImageData.FromRgba(rgba, width, height);
        }
        catch (Exception ex) when (ex is SixLabors.ImageSharp.InvalidImageContentException
            or SixLabors.ImageSharp.UnknownImageFormatException
            or NotSupportedException or ArgumentException or InvalidOperationException)
        {
            return null;
        }
    }
}
