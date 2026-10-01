namespace PS5PKGTool.Core.Backends;

/// <summary>
/// Raised when a backend is asked to do something it cannot do (for example LibProsperoPkg building
/// from an image, or its NAPS single-byte layout limit on a very large title). The message is
/// user-facing and names the backend; callers may offer to retry with another backend.
/// </summary>
public sealed class BackendNotSupportedException : NotSupportedException
{
    public BackendNotSupportedException(string backendId, string message)
        : base(message)
    {
        BackendId = backendId;
    }

    /// <summary>The id of the backend that could not handle the request.</summary>
    public string BackendId { get; }
}
