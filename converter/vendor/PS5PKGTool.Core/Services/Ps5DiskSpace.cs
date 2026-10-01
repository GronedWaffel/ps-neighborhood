using ProsperoPkgTool.Containers;

namespace PS5PKGTool.Core.Services;

/// <summary>Free-space preflight outcome, mirroring the engine without exposing its types.</summary>
public enum Ps5DiskSpaceStatus
{
    Ok,
    NearLimit,
    Insufficient
}

/// <summary>Result of a free-space preflight, with a human-readable description.</summary>
public readonly record struct Ps5DiskSpaceCheck(Ps5DiskSpaceStatus Status, string Message);

/// <summary>
/// Thin facade over the engine's <see cref="DiskSpaceGuard"/> so the UI layer does not reference the
/// engine assembly directly.
/// </summary>
public static class Ps5DiskSpace
{
    /// <summary>Estimates and checks free space for a package build.</summary>
    /// <param name="rawPayloadBytes">Source payload upper bound (dump total, or image file length).</param>
    /// <param name="outputPath">Destination package path.</param>
    /// <param name="tempDirectory">Workspace folder, or null for the system temp folder.</param>
    public static Ps5DiskSpaceCheck Check(long rawPayloadBytes, string outputPath, string? tempDirectory)
    {
        DiskSpaceReport report = DiskSpaceGuard.Check(
            DiskSpaceGuard.Estimate(rawPayloadBytes, outputPath, tempDirectory));
        Ps5DiskSpaceStatus status = report.Status switch
        {
            DiskSpaceStatus.Insufficient => Ps5DiskSpaceStatus.Insufficient,
            DiskSpaceStatus.NearLimit => Ps5DiskSpaceStatus.NearLimit,
            _ => Ps5DiskSpaceStatus.Ok
        };
        return new Ps5DiskSpaceCheck(status, DiskSpaceGuard.Describe(report));
    }

    /// <summary>
    /// Free-space preflight for an extract-then-build: the extracted staging tree plus the build's
    /// temp workspace and output, measured against the affected volumes.
    /// </summary>
    public static Ps5DiskSpaceCheck CheckStagedImage(long rawPayloadBytes, long stagingBytes,
        string outputPath, string? tempDirectory)
    {
        var requirements = DiskSpaceGuard.Estimate(rawPayloadBytes, outputPath, tempDirectory).ToList();
        if (stagingBytes > 0)
        {
            string tempRoot = Path.GetPathRoot(Path.GetFullPath(tempDirectory ?? Path.GetTempPath())) ?? string.Empty;
            int index = requirements.FindIndex(requirement =>
                string.Equals(requirement.Root, tempRoot, StringComparison.OrdinalIgnoreCase));
            if (index >= 0)
            {
                requirements[index] = requirements[index] with
                {
                    Bytes = requirements[index].Bytes + stagingBytes,
                    What = requirements[index].What + " + staging tree",
                };
            }
            else
            {
                requirements.Add(new SpaceRequirement(tempRoot, stagingBytes, "staging tree"));
            }
        }

        DiskSpaceReport report = DiskSpaceGuard.Check(requirements);
        Ps5DiskSpaceStatus status = report.Status switch
        {
            DiskSpaceStatus.Insufficient => Ps5DiskSpaceStatus.Insufficient,
            DiskSpaceStatus.NearLimit => Ps5DiskSpaceStatus.NearLimit,
            _ => Ps5DiskSpaceStatus.Ok,
        };
        return new Ps5DiskSpaceCheck(status, DiskSpaceGuard.Describe(report));
    }

    /// <summary>True when the exception is the engine's insufficient-free-space failure.</summary>
    public static bool IsInsufficient(Exception exception) => exception is ProsperoInsufficientSpaceException;

    /// <summary>The engine's free-space message for an insufficient-space exception.</summary>
    public static string Describe(Exception exception) =>
        exception is ProsperoInsufficientSpaceException space ? space.Message : exception.Message;
}
