using System.Text.Json;
using System.Text.Json.Serialization;

namespace PS5PKGTool.Core.Tasks;

/// <summary>Serializable projection of a <see cref="QueuedPackageTask"/> for restart-resume.</summary>
    public sealed record PersistedPackageTask(
    string Id,
    string Type,
    string DisplayName,
    string SourcePath,
    string OutputPath,
    string? Payload,
    PackageTaskStatus Status,
    string Operation = "",
    string SourceFormat = "",
    string TargetFormat = "",
    DateTime CreatedUtc = default,
    DateTime? StartedUtc = null,
    DateTime? CompletedUtc = null,
    string Message = "",
    string Stage = "",
    string FailureText = "",
    int Attempts = 0,
    string TargetQualifier = "");

/// <summary>
/// Sequential, resumable task queue modelled after a desktop download manager: long package
/// operations are enqueued once and processed one at a time. The queue owns ordering, status,
/// cancellation, retry, and persistence; feature code supplies the executable action. This mirrors
/// the PS4 multitool's task-queue concept but is an independent clean-room implementation.
/// </summary>
public sealed class PackageTaskQueue : IAsyncDisposable
{
    private static readonly JsonSerializerOptions s_jsonOptions = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() }
    };

    private readonly List<QueuedPackageTask> _tasks = [];
    private readonly SemaphoreSlim _signal = new(0);
    private readonly object _gate = new();
    private readonly CancellationTokenSource _lifetime = new();
    private readonly Task _worker;
    private string? _persistencePath;
    private QueuedPackageTask? _requested;
    private bool _shutdown;

    public PackageTaskQueue()
    {
        _worker = Task.Run(() => WorkerAsync(_lifetime.Token));
    }

    private bool _autoStart = true;

    /// <summary>
    /// When true (default) the queue drains waiting tasks automatically. When false the queue is
    /// held: the running task continues, waiting tasks stay queued, and only <see cref="StartNext"/>
    /// runs one. This is scheduling, not pause/resume of a build.
    /// </summary>
    public bool AutoStart
    {
        get => _autoStart;
        set
        {
            bool wasHeld = !_autoStart;
            _autoStart = value;
            if (value && wasHeld) RunQueue();
        }
    }

    public IReadOnlyList<QueuedPackageTask> Tasks
    {
        get { lock (_gate) return _tasks.ToArray(); }
    }

    /// <summary>Raised whenever the task list or any task state/progress changes.</summary>
    public event EventHandler? TasksChanged;

    public QueuedPackageTask? Find(string id)
    {
        lock (_gate) return _tasks.FirstOrDefault(task => string.Equals(task.Id, id, StringComparison.Ordinal));
    }

    public QueuedPackageTask Enqueue(QueuedPackageTask task)
    {
        ArgumentNullException.ThrowIfNull(task);
        lock (_gate) _tasks.Add(task);
        Notify();
        Persist();
        if (AutoStart) _signal.Release();
        return task;
    }

    /// <summary>Queues a one-shot task without persistence (for actions reconstructed at runtime).</summary>
    public QueuedPackageTask Enqueue(string type, string displayName,
        Func<IProgress<PackageTaskProgress>, CancellationToken, Task> execute,
        string sourcePath = "", string outputPath = "", string? payload = null,
        string operation = "", string sourceFormat = "", string targetFormat = "",
        PackageTaskStage[]? stagePlan = null, string targetQualifier = "")
    {
        ArgumentNullException.ThrowIfNull(execute);
        return Enqueue(new QueuedPackageTask
        {
            Id = Guid.NewGuid().ToString("N"),
            Type = type,
            DisplayName = displayName,
            SourcePath = sourcePath,
            OutputPath = outputPath,
            PersistencePayload = payload,
            Operation = operation,
            SourceFormat = sourceFormat,
            TargetFormat = targetFormat,
            TargetQualifier = targetQualifier,
            StagePlan = stagePlan ?? [],
            Execute = execute
        });
    }

    /// <summary>Runs exactly the next waiting task, even while the queue is held.</summary>
    public void StartNext()
    {
        lock (_gate)
        {
            _requested = _tasks.FirstOrDefault(task => task.Status == PackageTaskStatus.Queued);
            if (_requested is null) return;
        }
        _signal.Release();
    }

    /// <summary>Drains all waiting tasks, used by the Run queue control and when hold is released.</summary>
    public void RunQueue()
    {
        bool hasQueued;
        lock (_gate) hasQueued = _tasks.Any(task => task.Status == PackageTaskStatus.Queued);
        if (hasQueued) _signal.Release();
    }

    public bool Cancel(string id)
    {
        QueuedPackageTask? task = Find(id);
        if (task is null) return false;
        lock (_gate)
        {
            switch (task.Status)
            {
                case PackageTaskStatus.Queued:
                    task.Apply(PackageTaskStatus.Cancelled, "Cancelled");
                    break;
                case PackageTaskStatus.Running:
                    task.Apply(PackageTaskStatus.Cancelling, "Cancelling…");
                    task.Cancellation?.Cancel();
                    break;
                default:
                    return false;
            }
        }
        Notify();
        Persist();
        return true;
    }

    public bool Retry(string id)
    {
        QueuedPackageTask? task = Find(id);
        if (task is null || task.Execute is null ||
            task.Status is not (PackageTaskStatus.Failed or PackageTaskStatus.Cancelled or PackageTaskStatus.Interrupted))
            return false;
        lock (_gate)
        {
            task.Apply(PackageTaskStatus.Queued, "Queued");
            task.StartedUtc = null;
            task.CompletedUtc = null;
            task.Progress = PackageTaskProgress.Empty;
        }
        Notify();
        Persist();
        if (AutoStart) _signal.Release();
        return true;
    }

    public bool Remove(string id)
    {
        bool removed;
        lock (_gate)
        {
            QueuedPackageTask? task = _tasks.FirstOrDefault(candidate => string.Equals(candidate.Id, id, StringComparison.Ordinal));
            if (task is null || task.Status is PackageTaskStatus.Running or PackageTaskStatus.Cancelling) return false;
            removed = _tasks.Remove(task);
        }
        if (removed) { Notify(); Persist(); }
        return removed;
    }

    /// <summary>
    /// Removes only successful completed records from history. Failed, cancelled and interrupted
    /// records are retained so a problem is never silently cleared away.
    /// </summary>
    public int ClearCompleted()
    {
        int removed;
        lock (_gate) removed = _tasks.RemoveAll(task => task.Status == PackageTaskStatus.Completed);
        if (removed > 0) { Notify(); Persist(); }
        return removed;
    }

    // ---------------------------------------------------------------- persistence

    /// <summary>Sets the persistence path without writing immediately (use before <see cref="RestoreFromDisk"/>).</summary>
    public void SetPersistencePath(string path) => _persistencePath = path;

    /// <summary>Enables automatic persistence to <paramref name="path"/> on every state change.</summary>
    public void EnablePersistence(string path)
    {
        _persistencePath = path;
        Persist();
    }

    public void Persist()
    {
        string? path = _persistencePath;
        if (path is null) return;
        try
        {
            PersistedPackageTask[] entries = Tasks.Select(task => new PersistedPackageTask(
                task.Id, task.Type, task.DisplayName, task.SourcePath, task.OutputPath,
                task.PersistencePayload, task.Status, task.Operation, task.SourceFormat, task.TargetFormat,
                task.CreatedUtc, task.StartedUtc, task.CompletedUtc, task.Message, task.Progress.Stage,
                task.Failure?.ToString() ?? string.Empty, task.Attempts, task.TargetQualifier)).ToArray();
            string directory = Path.GetDirectoryName(path) ?? ".";
            Directory.CreateDirectory(directory);
            string temporary = path + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(entries, s_jsonOptions));
            File.Move(temporary, path, true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // Persistence is best-effort; never let it break the running queue.
        }
    }

    /// <summary>
    /// Restores tasks previously written by <see cref="Persist"/>. The supplied factory rebuilds a
    /// runnable task from its payload (return null to drop an unknown entry). Tasks that were
    /// running when the app last exited are restored as <see cref="PackageTaskStatus.Interrupted"/>.
    /// </summary>
    public int RestoreFromDisk(Func<PersistedPackageTask, QueuedPackageTask?> restore)
    {
        ArgumentNullException.ThrowIfNull(restore);
        string? path = _persistencePath;
        if (path is null || !File.Exists(path)) return 0;

        List<PersistedPackageTask>? saved;
        try
        {
            saved = JsonSerializer.Deserialize<List<PersistedPackageTask>>(File.ReadAllText(path), s_jsonOptions);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return 0;
        }
        if (saved is null) return 0;

        int restored = 0;
        foreach (PersistedPackageTask entry in saved)
        {
            QueuedPackageTask? task = restore(entry);
            if (task is null) continue;
            if (entry.Status is PackageTaskStatus.Running or PackageTaskStatus.Cancelling)
                task.Apply(PackageTaskStatus.Interrupted, "Interrupted during a previous session; retry to resume.");
            else
                task.Apply(entry.Status, string.IsNullOrEmpty(entry.Message) ? task.Message : entry.Message);
            // Restore the recorded timing, last stage, attempt count and failure text so history stays truthful.
            task.RestoreHistory(entry.StartedUtc, entry.CompletedUtc, entry.Message, entry.Stage, entry.FailureText,
                entry.Attempts);
            lock (_gate) _tasks.Add(task);
            restored++;
        }
        if (restored > 0)
        {
            Notify();
            // A single signal wakes the worker, which drains every still-queued task itself.
            if (AutoStart) _signal.Release();
        }
        return restored;
    }

    // ---------------------------------------------------------------- worker

    private async Task WorkerAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try { await _signal.WaitAsync(cancellationToken).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }

            // Drain the queue while it is running. Holding stops the drain after the current task;
            // TakeNext decides whether anything may start. A single signal wakes this loop.
            while (!cancellationToken.IsCancellationRequested)
            {
                QueuedPackageTask? task = TakeNext();
                if (task is null) break;
                await RunAsync(task, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private QueuedPackageTask? TakeNext()
    {
        lock (_gate)
        {
            QueuedPackageTask? requested = _requested is { Status: PackageTaskStatus.Queued } value ? value : null;
            _requested = null;
            if (requested is not null) return requested; // an explicit Start next works while held
            if (!AutoStart) return null;                 // held: no automatic starts
            return _tasks.FirstOrDefault(candidate => candidate.Status == PackageTaskStatus.Queued);
        }
    }

    private async Task RunAsync(QueuedPackageTask task, CancellationToken lifetime)
    {
        // Revalidate the captured input before running: files, volumes and workspaces may have changed
        // since the job was queued.
        if (!string.IsNullOrEmpty(task.SourcePath) &&
            !File.Exists(task.SourcePath) && !Directory.Exists(task.SourcePath))
        {
            task.Attempts++;
            task.Apply(PackageTaskStatus.Failed, "Source is no longer available: " + task.SourcePath);
            Persist();
            return;
        }

        task.Cancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime);
        CancellationToken token = task.Cancellation.Token;
        task.Attempts++;
        task.Apply(PackageTaskStatus.Running, "Starting…");

        var progress = new PackageTaskProgressTracker(new RelayProgress<PackageTaskProgress>(value =>
        {
            if (task.Status == PackageTaskStatus.Running) task.Apply(PackageTaskStatus.Running, null, value);
        }), task.StagePlan);

        try
        {
            Func<IProgress<PackageTaskProgress>, CancellationToken, Task>? execute = task.Execute;
            if (execute is null)
                throw new InvalidOperationException($"Task '{task.DisplayName}' has no executable action.");
            await execute(progress, token).ConfigureAwait(false);
            task.Apply(PackageTaskStatus.Running, null, task.Progress with
            {
                StagePercent = 1d,
                Step = task.Progress.TotalSteps > 0 ? task.Progress.TotalSteps : task.Progress.Step
            });
            task.Apply(PackageTaskStatus.Completed, "Completed");
        }
        catch (OperationCanceledException)
        {
            task.Apply(PackageTaskStatus.Cancelled, "Cancelled");
        }
        catch (Exception ex)
        {
            task.Failure = ex;
            task.Apply(PackageTaskStatus.Failed, $"{ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            task.Cancellation?.Dispose();
            task.Cancellation = null;
            Persist();
        }
    }

    private void Notify() => TasksChanged?.Invoke(this, EventArgs.Empty);

    private sealed class RelayProgress<T>(Action<T> report) : IProgress<T>
    {
        public void Report(T value) => report(value);
    }

    public async ValueTask DisposeAsync()
    {
        if (_shutdown) return;
        _shutdown = true;
        _lifetime.Cancel();
        lock (_gate)
        {
            foreach (QueuedPackageTask task in _tasks)
                if (task.Status is PackageTaskStatus.Running or PackageTaskStatus.Cancelling)
                    task.Cancellation?.Cancel();
        }
        try { await _worker.ConfigureAwait(false); }
        catch (OperationCanceledException) { }
        Persist();
        _lifetime.Dispose();
        _signal.Dispose();
    }
}
