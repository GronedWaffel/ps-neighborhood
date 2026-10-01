using ProsperoPkgTool.Containers;

namespace PS5PKGTool.Core.Builders;

/// <summary>Inner-image compression choice for a package build.</summary>
public enum Ps5InnerCompression
{
    /// <summary>Every inner block stored uncompressed (byte-identical to the historical default).</summary>
    Stored,

    /// <summary>Force Kraken compression on every block.</summary>
    Kraken,

    /// <summary>Kraken where it helps, stored otherwise (engine default).</summary>
    Auto
}

internal static class Ps5InnerCompressionExtensions
{
    public static ProsperoInnerCompressionMode ToEngine(this Ps5InnerCompression value) => value switch
    {
        Ps5InnerCompression.Stored => ProsperoInnerCompressionMode.Stored,
        Ps5InnerCompression.Kraken => ProsperoInnerCompressionMode.Kraken,
        _ => ProsperoInnerCompressionMode.Auto
    };
}
