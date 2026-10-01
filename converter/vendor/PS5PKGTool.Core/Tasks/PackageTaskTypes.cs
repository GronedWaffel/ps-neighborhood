namespace PS5PKGTool.Core.Tasks;

/// <summary>Stable task type identifiers used for display and future persistence/restore routing.</summary>
public static class PackageTaskTypes
{
    public const string SonyDebugPkg = "FPKG";
    public const string FfpfscFromDump = "FFPFSC (dump)";
    public const string FfpfscFromImage = "FFPFSC (image)";
    public const string ExfatCreate = "exFAT image";
    public const string ExfatAmpr = "exFAT AMPR";
    public const string ExfatRepair = "exFAT repair";
    public const string FfpkgCreate = "FFPKG image";
    public const string FfpkgRebuild = "FFPKG rebuild";
    public const string PackageExtract = "Extract package";
    public const string PackageVerify = "Verify package";
    public const string ImageConvert = "Convert image";
    public const string ImageVerify = "Verify image";
    public const string ImageBuildPackage = "Build package";
    public const string LibraryMove = "Move";
}
