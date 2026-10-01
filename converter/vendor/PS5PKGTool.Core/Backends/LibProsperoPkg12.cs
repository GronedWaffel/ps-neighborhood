using System.Collections;
using System.Reflection;
using System.Runtime.Loader;

namespace PS5PKGTool.Core.Backends;

/// <summary>Inputs for a LibProsperoPkg 1.2.0 directory build.</summary>
internal sealed class LibProsperoPkg12BuildRequest
{
    public required string SourceFolder { get; init; }
    public required string OutputFolder { get; init; }
    public required string ContentId { get; init; }
    public required string Passcode { get; init; }
    public ulong? SdkVersion { get; init; }
    public int PlayGoChunks { get; init; } = 1;
    public bool Deterministic { get; init; }
    public byte[]? OuterSeed { get; init; }
    /// <summary>0 = none (stored), 1 = zlib, 2 = kraken.</summary>
    public int Compression { get; init; } = 2;
    public int KrakenLevel { get; init; } = 7;
    public int KrakenThreads { get; init; }
    public string? TempDirectory { get; init; }
    public Action<string>? Log { get; init; }
}

/// <summary>
/// Loads the vendored LibProsperoPkg 1.2.0 (the version the working PPR-PKG/fpkg-gui ships) in an
/// isolated <see cref="AssemblyLoadContext"/> and calls it by reflection. Isolation is required
/// because 1.2.0 depends on BCnEncoder.Net 2.3.0 and Magick.NET, which would clash with the engine
/// assemblies already loaded in the default context. The public surface is deliberately tiny.
/// </summary>
internal static class LibProsperoPkg12
{
    private static readonly Lazy<Api?> Shared = new(Load, LazyThreadSafetyMode.ExecutionAndPublication);

    /// <summary>True when the vendored 1.2.0 payload is present and loadable.</summary>
    public static bool Available => Shared.Value is not null;

    private static string Folder => Path.Combine(AppContext.BaseDirectory, "LibProsperoPkg12");

    /// <summary>Builds a package from a folder and returns the produced package path.</summary>
    public static string Build(LibProsperoPkg12BuildRequest request)
    {
        Api api = Shared.Value ?? throw NotInstalled();
        object options = Activator.CreateInstance(api.OptionsType)
            ?? throw NotInstalled();

        Set(options, "Mode", Enum.Parse(api.ModeType, "Application"));
        Set(options, "OutputFormat", Enum.Parse(api.FormatType, "DebugImage"));
        Set(options, "SourceFolder", request.SourceFolder);
        Set(options, "OutputFolder", request.OutputFolder);
        Set(options, "ContentId", request.ContentId);
        Set(options, "Passcode", request.Passcode);
        Set(options, "TemporaryDirectory", request.TempDirectory);
        Set(options, "SdkVersionOverride", request.SdkVersion);
        Set(options, "PlayGoChunkCount", request.PlayGoChunks);
        Set(options, "DeterministicBuild", request.Deterministic);
        Set(options, "OuterPfsSeed", request.OuterSeed);
        Set(options, "CompressInnerImage", request.Compression != 0);
        Set(options, "InnerCompression", Enum.Parse(api.CompressionType, request.Compression switch
        {
            2 => "Kraken",
            1 => "Zlib",
            _ => "None",
        }));
        Set(options, "KrakenCompressionLevel", request.KrakenLevel);
        Set(options, "KrakenMaxDegreeOfParallelism", request.KrakenThreads);

        Action<string> log = message => request.Log?.Invoke(message);
        object result;
        try
        {
            result = api.BuildMethod.Invoke(null, [options, log])
                ?? throw new InvalidOperationException("LibProsperoPkg returned no build result.");
        }
        catch (System.Reflection.TargetInvocationException ex) when (ex.InnerException is not null)
        {
            // Unwrap reflection so callers can recognise the library's real failure (for example an
            // unsupported layout) instead of seeing a generic TargetInvocationException.
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
            throw;
        }
        return (string?)result.GetType().GetProperty("OutputPath")?.GetValue(result)
            ?? throw new InvalidOperationException("LibProsperoPkg returned no output path.");
    }

    /// <summary>Validates a package with LibProsperoPkg 1.2.0 (structure + CNT metadata signature).</summary>
    public static (bool Valid, string Message) Validate(string packagePath)
    {
        if (Shared.Value is not { } api)
            return (false, NotInstalled().Message);
        try
        {
            _ = api.ReaderRead.Invoke(null, [packagePath]);
            bool signature = (bool)(api.VerifySignature.Invoke(null, [packagePath]) ?? false);
            return signature
                ? (true, "LibProsperoPkg 1.2.0 read the structure and verified the CNT metadata signature.")
                : (false, "LibProsperoPkg 1.2.0 could not verify the CNT metadata signature.");
        }
        catch (TargetInvocationException ex)
        {
            return (false, ex.InnerException?.Message ?? ex.Message);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    /// <summary>Extracts a package's inner filesystem with LibProsperoPkg 1.2.0 and returns the file count.</summary>
    public static int Extract(string packagePath, string outputDirectory, string passcode)
    {
        Api api = Shared.Value ?? throw NotInstalled();
        try
        {
            object list = api.ExtractInnerFiles.Invoke(null, [packagePath, outputDirectory, passcode, true])
                ?? throw new InvalidOperationException("LibProsperoPkg returned no extraction result.");
            return list is ICollection collection
                ? collection.Count
                : ((IEnumerable)list).Cast<object>().Count();
        }
        catch (TargetInvocationException ex)
        {
            throw ex.InnerException ?? ex;
        }
    }

    private static void Set(object target, string property, object? value)
    {
        if (value is null)
            return;
        PropertyInfo? info = target.GetType().GetProperty(property);
        info?.SetValue(target, value);
    }

    private static BackendNotSupportedException NotInstalled() =>
        new(LppBackend.BackendId, "The vendored LibProsperoPkg 1.2.0 payload (LibProsperoPkg12) is missing from the application folder.");

    private static Api? Load()
    {
        try
        {
            string folder = Folder;
            string library = Path.Combine(folder, "LibProsperoPkg.dll");
            if (!File.Exists(library))
                return null;

            var context = new IsolatedLoadContext(folder);
            Assembly assembly = context.LoadFromAssemblyPath(library);

            return new Api
            {
                OptionsType = Require(assembly, "LibProsperoPkg.ProsperoBuildOptions"),
                ModeType = Require(assembly, "LibProsperoPkg.ProsperoPackageMode"),
                FormatType = Require(assembly, "LibProsperoPkg.ProsperoOutputFormat"),
                CompressionType = Require(assembly, "LibProsperoPkg.PKG.ProsperoInnerCompression"),
                BuildMethod = Require(assembly, "LibProsperoPkg.ProsperoPackageBuilder").GetMethod("Build", [OptionsType(assembly), typeof(Action<string>)])
                    ?? throw new MissingMethodException("ProsperoPackageBuilder.Build"),
                ArchiveType = Require(assembly, "LibProsperoPkg.PKG.ProsperoPackageArchive"),
                ReaderRead = Require(assembly, "LibProsperoPkg.PKG.ProsperoPkgReader").GetMethod("Read", [typeof(string)])
                    ?? throw new MissingMethodException("ProsperoPkgReader.Read"),
                VerifySignature = Require(assembly, "LibProsperoPkg.PKG.ProsperoPackageArchive").GetMethod("VerifyCntMetadataSignature", [typeof(string)])
                    ?? throw new MissingMethodException("VerifyCntMetadataSignature"),
                ExtractInnerFiles = Require(assembly, "LibProsperoPkg.PKG.ProsperoPackageArchive")
                    .GetMethod("ExtractInnerFiles", [typeof(string), typeof(string), typeof(string), typeof(bool)])
                    ?? throw new MissingMethodException("ExtractInnerFiles"),
            };
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static Type OptionsType(Assembly assembly) => Require(assembly, "LibProsperoPkg.ProsperoBuildOptions");

    private static Type Require(Assembly assembly, string typeName) =>
        assembly.GetType(typeName, throwOnError: true)
        ?? throw new TypeLoadException(typeName);

    private sealed class Api
    {
        public required Type OptionsType { get; init; }
        public required Type ModeType { get; init; }
        public required Type FormatType { get; init; }
        public required Type CompressionType { get; init; }
        public required MethodInfo BuildMethod { get; init; }
        public required Type ArchiveType { get; init; }
        public required MethodInfo ReaderRead { get; init; }
        public required MethodInfo VerifySignature { get; init; }
        public required MethodInfo ExtractInnerFiles { get; init; }
    }

    private sealed class IsolatedLoadContext(string folder) : AssemblyLoadContext("LibProsperoPkg12")
    {
        protected override Assembly? Load(AssemblyName assemblyName)
        {
            string path = Path.Combine(folder, assemblyName.Name + ".dll");
            return File.Exists(path) ? LoadFromAssemblyPath(path) : null;
        }

        protected override IntPtr LoadUnmanagedDll(string unmanagedDllName)
        {
            foreach (string candidate in new[]
            {
                Path.Combine(folder, unmanagedDllName + ".dll"),
                Path.Combine(folder, "runtimes", "win-x64", "native", unmanagedDllName + ".dll"),
            })
            {
                if (File.Exists(candidate))
                    return LoadUnmanagedDllFromPath(candidate);
            }
            return IntPtr.Zero;
        }
    }
}
