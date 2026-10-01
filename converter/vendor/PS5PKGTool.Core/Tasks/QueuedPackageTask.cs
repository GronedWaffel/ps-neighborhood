namespace PS5PKGTool.Core.Tasks;

/// <summary>Lifecycle state of a queued operation. <see cref="Interrupted"/> is used when a task
/// was running in a previous session and could not be resumed.</summary>
public enum PackageTaskStatus
{
    Queued,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    Interrupted
}

/// <summary>Progress snapshot for a running task. <see cref="OperationPercent"/> is the progress of
/// the active step; <see cref="TaskPercent"/> is progress across the task's steps.</summary>
public readonly record struct PackageTaskProgress(
    string Stage,
    int Step = 0,
    int TotalSteps = 0,
    long CurrentBytes = 0,
    long TotalBytes = 0,
    int CurrentItem = 0,
    int TotalItems = 0,
    string CurrentFile = "",
    double StagePercent = -1)
{
    public static readonly PackageTaskProgress Empty = new(string.Empty);

    /// <summary>Percent within the current step, derived from the most useful counter pair.</summary>
    public double OperationPercent => StagePercent >= 0
        ? Math.Clamp(StagePercent, 0d, 1d)
        : TotalBytes > 0
            ? Math.Clamp((double)CurrentBytes / TotalBytes, 0d, 1d)
            : TotalItems > 0
                ? Math.Clamp((double)CurrentItem / TotalItems, 0d, 1d)
                : TotalSteps > 0
                    ? Math.Clamp((double)Step / TotalSteps, 0d, 1d)
                    : 0d;

    /// <summary>
    /// Fraction of the task completed: completed steps plus the current step's own fraction. Using
    /// the within-step fraction (not just the step index) keeps the task bar advancing smoothly
    /// instead of jumping to a step boundary and then sitting still.
    /// </summary>
    public double TaskPercent => TotalSteps > 1
        ? Math.Clamp((Step + OperationPercent) / TotalSteps, 0d, 1d)
        : OperationPercent;

    /// <summary>Backward-compatible alias for the current step percent.</summary>
    public double Percent => OperationPercent;
}

/// <summary>
/// One named step of a task. A reported stage is matched to a step through <see cref="Keywords"/>
/// (case-insensitive substring); unmatched reports fall back to the last matched step.
/// </summary>
public sealed class PackageTaskStage
{
    public PackageTaskStage(string name, params string[] keywords)
    {
        Name = name;
        Keywords = keywords;
    }

    public string Name { get; }
    public string[] Keywords { get; }
}

/// <summary>Declarative step lists used to turn stage-relative reports into task step progress.</summary>
public static class PackageTaskPlans
{
    public static readonly PackageTaskStage[] Single = [];
    public static readonly PackageTaskStage[] Extract = [new("Extract")];
    public static readonly PackageTaskStage[] Verify = [new("Verify")];
    public static readonly PackageTaskStage[] Build = [new("Build")];

    public static readonly PackageTaskStage[] ConvertImage =
    [
        new("Extract", "extract", "reading"),
        new("Build", "build", "creating", "writing"),
        new("Verify", "verif", "check", "compar")
    ];

    public static readonly PackageTaskStage[] ConvertPackage =
    [
        new("Extract", "extract", "reading"),
        new("Build", "build", "creating", "writing"),
        new("Verify", "verif", "check", "compar")
    ];

    /// <summary>Build package from an unpacked dump folder.</summary>
    public static readonly PackageTaskStage[] BuildPackageDump =
    [
        new("Read source", "reading source folder"),
        new("Inner image", "inner image"),
        new("NAPS", "naps"),
        new("Outer PFS", "outer pfs"),
        new("CNT", "cnt"),
        new("Finalize", "finaliz")
    ];

    /// <summary>
    /// Build package directly from a filesystem image. Adds a format-detect phase and a
    /// format-named read phase (exFAT / UFS2-FFPKG / FFPFSC) before the shared build stages.
    /// </summary>
    public static readonly PackageTaskStage[] BuildPackageImage =
    [
        new("Detect image", "detecting image format"),
        new("Read image", "reading image filesystem", "reading exfat", "reading ufs2", "reading ffpkg",
            "reading ffpfsc", "reading pfs"),
        new("Inner image", "inner image"),
        new("NAPS", "naps"),
        new("Outer PFS", "outer pfs"),
        new("CNT", "cnt"),
        new("Finalize", "finaliz")
    ];

    /// <summary>
    /// Build package from an image with LibProsperoPkg: the image is extracted to a staging folder
    /// first, then built. Adds an "Extract image" step before the shared build stages.
    /// </summary>
    public static readonly PackageTaskStage[] BuildPackageImageLpp =
    [
        new("Extract image", "extract", "reading exfat", "reading ufs2", "reading ffpkg", "reading ffpfsc"),
        new("Inner image", "inner image"),
        new("NAPS", "naps"),
        new("Outer PFS", "outer pfs"),
        new("CNT", "cnt"),
        new("Finalize", "finaliz")
    ];

    /// <summary>Selects the build-package step plan for a dump folder or an image file.</summary>
    /// <param name="extractImageFirst">True when an image source is extracted to a staging folder first.</param>
    public static PackageTaskStage[] BuildPackageFor(string sourcePath, bool extractImageFirst = false) =>
        extractImageFirst ? BuildPackageImageLpp
        : Directory.Exists(sourcePath) ? BuildPackageDump : BuildPackageImage;

    public static readonly PackageTaskStage[] Ampr =
    [
        new("Build index", "building"),
        new("Write index", "writing")
    ];

    public static readonly PackageTaskStage[] BuildAndVerify =
    [
        new("Build", "build", "creating", "writing"),
        new("Verify", "verif", "check", "compar")
    ];
}

/// <summary>
/// Wraps a task progress sink and annotates raw reports with the current step and step count from
/// a <see cref="PackageTaskStage"/> plan. Tasks without a plan are treated as a single step.
/// </summary>
public sealed class PackageTaskProgressTracker : IProgress<PackageTaskProgress>
{
    private readonly IProgress<PackageTaskProgress> _sink;
    private readonly PackageTaskStage[] _stages;
    private int _stageIndex = -1;

    public PackageTaskProgressTracker(IProgress<PackageTaskProgress> sink, PackageTaskStage[]? plan = null)
    {
        _sink = sink ?? throw new ArgumentNullException(nameof(sink));
        _stages = plan is { Length: > 0 } ? plan : [];
    }

    public void Report(PackageTaskProgress value)
    {
        double stageFraction = value.OperationPercent;
        int index = ResolveStage(value.Stage);
        int steps = _stages.Length > 0 ? _stages.Length : 1;
        int step = index < 0 ? 0 : index;
        _sink.Report(value with { Step = step, TotalSteps = steps, StagePercent = stageFraction });
    }

    private int ResolveStage(string raw)
    {
        if (_stages.Length == 0) return -1;
        if (!string.IsNullOrWhiteSpace(raw))
        {
            for (int i = 0; i < _stages.Length; i++)
            {
                foreach (string keyword in _stages[i].Keywords)
                {
                    if (raw.Contains(keyword, StringComparison.OrdinalIgnoreCase))
                    {
                        if (i > _stageIndex) _stageIndex = i;
                        return _stageIndex;
                    }
                }
            }
        }
        return _stageIndex;
    }
}

/// <summary>
/// One unit of work in the <see cref="PackageTaskQueue"/>. Tasks are deliberately UI-agnostic:
/// the queue owns sequencing, cancellation, retry and persistence, while the executable action is
/// injected by the caller. Persistence carries an opaque <see cref="PersistencePayload"/> so the
/// owning feature can reconstruct the action after a restart.
/// </summary>
public sealed class QueuedPackageTask
{
    public required string Id { get; init; }
    public required string Type { get; init; }
    public required string DisplayName { get; init; }
    public string SourcePath { get; init; } = string.Empty;
    public string OutputPath { get; init; } = string.Empty;
    public string? PersistencePayload { get; init; }

    /// <summary>Coarse operation label, for example "Convert" or "Build package".</summary>
    public string Operation { get; init; } = string.Empty;

    /// <summary>Human-readable source format, for example "FFPKG" or "dump".</summary>
    public string SourceFormat { get; init; } = string.Empty;

    /// <summary>Human-readable target format, for example "FFPFSC".</summary>
    public string TargetFormat { get; init; } = string.Empty;

    /// <summary>Weighted stages used to compute task-overall progress; empty means single-stage.</summary>
    public PackageTaskStage[] StagePlan { get; init; } = [];

    /// <summary>The action this task runs when dequeued. Supplied by the owning feature.</summary>
    public Func<IProgress<PackageTaskProgress>, CancellationToken, Task>? Execute { get; init; }

    public PackageTaskStatus Status { get; internal set; } = PackageTaskStatus.Queued;
    public PackageTaskProgress Progress { get; internal set; }
    public string Message { get; internal set; } = string.Empty;

    /// <summary>The exception that failed the task, when there was one, for diagnostics.</summary>
    public Exception? Failure { get; internal set; }
    public DateTime CreatedUtc { get; init; } = DateTime.UtcNow;
    /// <summary>Number of execution attempts (a retry starts a new attempt).</summary>
    public int Attempts { get; internal set; }
    public DateTime? StartedUtc { get; internal set; }
    public DateTime? CompletedUtc { get; internal set; }

    internal CancellationTokenSource? Cancellation { get; set; }

    public event EventHandler? Changed;

    public bool IsTerminal => Status is PackageTaskStatus.Completed or PackageTaskStatus.Failed
        or PackageTaskStatus.Cancelled or PackageTaskStatus.Interrupted;

    /// <summary>
    /// Optional qualifier appended to the target in <see cref="FormatRoute"/>, for example the builder
    /// used for a debug package ("Dump Folder → FPKG (LibProsperoPkg 1.2.0)").
    /// </summary>
    public string TargetQualifier { get; init; } = string.Empty;

    public string FormatRoute
    {
        get
        {
            if (SourceFormat.Length == 0 || TargetFormat.Length == 0) return string.Empty;
            string route = $"{SourceFormat} \u2192 {TargetFormat}";
            return TargetQualifier.Length > 0 ? $"{route} ({TargetQualifier})" : route;
        }
    }

    internal void Apply(PackageTaskStatus status, string? message = null, PackageTaskProgress? progress = null)
    {
        Status = status;
        if (message is not null) Message = message;
        if (progress is not null) Progress = progress.Value;
        if (status == PackageTaskStatus.Running) StartedUtc ??= DateTime.UtcNow;
        if (IsTerminal) CompletedUtc ??= DateTime.UtcNow;
        Changed?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>
    /// Restores persisted history metadata (timing, last stage, failure text) after a restart so the
    /// past attempt is shown truthfully rather than as a bare status.
    /// </summary>
    internal void RestoreHistory(DateTime? startedUtc, DateTime? completedUtc, string message, string stage,
        string failureText, int attempts)
    {
        if (attempts > 0) Attempts = attempts;
        if (startedUtc is { } started) StartedUtc = started;
        if (completedUtc is { } completed) CompletedUtc = completed;
        if (!string.IsNullOrEmpty(message)) Message = message;
        if (!string.IsNullOrEmpty(stage)) Progress = Progress with { Stage = stage };
        if (!string.IsNullOrEmpty(failureText)) Failure = new InvalidOperationException(failureText);
    }
}
