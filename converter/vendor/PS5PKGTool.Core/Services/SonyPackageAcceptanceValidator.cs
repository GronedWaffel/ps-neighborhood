using PS5PKGTool.Core.Builders;
using PS5PKGTool.Core.Models;
using PS5PKGTool.Core.Parsers;
using ProsperoPkgTool.Containers;

namespace PS5PKGTool.Core.Services;

public enum SonyPackageCheckState { Pass, Warning, Fail }
public sealed record SonyPackageAcceptanceCheck(string Name, SonyPackageCheckState State, string Message);
public sealed class SonyPackageAcceptanceReport
{
    public required IReadOnlyList<SonyPackageAcceptanceCheck> Checks { get; init; }
    public bool IsStructurallyReady => Checks.All(check => check.State != SonyPackageCheckState.Fail);
}

/// <summary>
/// Structural acceptance for a PS5 debug package. All checks are produced by the vendored,
/// validated <c>ProsperoPkgTool</c> engine verifier; PS5PKGTool only presents the results.
/// </summary>
public static class SonyPackageAcceptanceValidator
{
    public static SonyPackageAcceptanceReport Validate(string packagePath, string passcode = SonyDebugPackageCredentials.DefaultPasscode)
    {
        var checks = new List<SonyPackageAcceptanceCheck>();
        try
        {
            ProsperoPackageInspection inspection = ProsperoPackageReader.Read(packagePath);
            SonyPkgSummary package = new SonyPkgReader().Read(packagePath, passcode);
            bool isDebug = inspection.Kind is ProsperoPackageKind.FinalizedDebug or ProsperoPackageKind.FinalizedPatchDebug;
            checks.Add(new("FIH", isDebug ? SonyPackageCheckState.Pass : SonyPackageCheckState.Fail,
                isDebug ? "Finalized debug FIH detected." : "A finalized debug FIH is required."));
            checks.Add(new("Format version", package.FormatVersion == 3 ? SonyPackageCheckState.Pass : SonyPackageCheckState.Fail,
                "FIH format version: " + (package.FormatVersion?.ToString() ?? "missing")));
            checks.Add(new("Content ID", package.ContentId.Length == 36 ? SonyPackageCheckState.Pass : SonyPackageCheckState.Fail,
                package.ContentId.Length == 36 ? package.ContentId : "Content ID is missing or malformed."));
            checks.Add(new("Image key entry", package.Entries.Any(entry => entry.Id == 0x20) ? SonyPackageCheckState.Pass : SonyPackageCheckState.Fail,
                package.Entries.Any(entry => entry.Id == 0x20) ? "Image key entry is present." : "CNT entry 0x20 is missing."));
            checks.Add(new("Outer PFS", package.NestedPfs?.AccessState == SonyPfsAccessState.PlaintextIndexed ? SonyPackageCheckState.Pass : SonyPackageCheckState.Fail,
                package.NestedPfs?.StatusMessage ?? "PFS could not be indexed."));
            bool param = package.Entries.Any(entry => entry.Id == 0x2000);
            checks.Add(new("param.json", param ? SonyPackageCheckState.Pass : SonyPackageCheckState.Fail, param ? "CNT param.json entry is present." : "CNT param.json entry is missing."));

            ProsperoPackageVerificationReport report = ProsperoPackageVerifier.Verify(packagePath, passcode);
            foreach (VerificationCheck check in report.Checks)
                checks.Add(new(check.Name, MapState(check.State), check.Detail));
            SonyDebugPackageValidationResult core = SonyDebugPackageBuilder.Validate(packagePath, passcode);
            checks.Add(new("Engine validation", core.IsValid ? SonyPackageCheckState.Pass : SonyPackageCheckState.Fail, core.Message));
            checks.Add(new("Console acceptance", SonyPackageCheckState.Warning, "Structural validation cannot prove acceptance by a specific console, firmware, or debug environment."));
        }
        catch (Exception ex) { checks.Add(new("Package parse", SonyPackageCheckState.Fail, ex.Message)); }
        return new SonyPackageAcceptanceReport { Checks = checks };
    }

    private static SonyPackageCheckState MapState(VerificationState state) => state switch
    {
        VerificationState.Pass => SonyPackageCheckState.Pass,
        VerificationState.Fail => SonyPackageCheckState.Fail,
        _ => SonyPackageCheckState.Warning
    };
}
