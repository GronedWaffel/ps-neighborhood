using ProsperoPkgTool.Content;

namespace PS5PKGTool.Core.Services;

/// <summary>
/// The known Prospero application SDK releases, surfaced for the UI without referencing the engine
/// assembly directly. A release id is the full 64-bit executable SDK identifier.
/// </summary>
public static class Ps5SdkVersions
{
    public readonly record struct Release(int Major, string Version, ulong ExecutableVersion);

    /// <summary>Known SDK releases in ascending major order.</summary>
    public static IReadOnlyList<Release> Releases { get; } =
        ProsperoSdkVersions.Releases
            .Select(release => new Release(release.Major, release.Version, release.ExecutableVersion))
            .ToArray();

    /// <summary>The executable SDK id at <paramref name="index"/>, or null when out of range.</summary>
    public static ulong? ExecutableVersionAt(int index) =>
        index >= 0 && index < Releases.Count ? Releases[index].ExecutableVersion : null;
}
