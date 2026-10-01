namespace PS5PKGTool.Core.Models;

/// <summary>
/// The state of one detail section. Empty tables and zero values cannot express these reliably, so
/// every section carries an explicit state instead of implying "no data" from an empty result.
/// </summary>
public enum SectionState
{
    NotChecked,
    Loading,
    Available,
    Partial,
    NotPresent,
    NotApplicable,
    Locked,
    Unsupported,
    Failed
}

/// <summary>A section's state, where its data came from, and a short explaining message.</summary>
public sealed record SectionStatus(SectionState State, string Origin = "", string Message = "")
{
    public string StateText => State switch
    {
        SectionState.NotChecked => "Not checked",
        SectionState.Loading => "Loading",
        SectionState.Available => "Available",
        SectionState.Partial => "Partial",
        SectionState.NotPresent => "Not present",
        SectionState.NotApplicable => "Not applicable",
        SectionState.Locked => "Locked / key required",
        SectionState.Unsupported => "Unsupported",
        SectionState.Failed => "Read failed",
        _ => State.ToString()
    };

    /// <summary>Human-readable "state - origin - message" for the diagnostics summary.</summary>
    public string Display
    {
        get
        {
            string text = StateText;
            if (Origin.Length > 0) text += $" ({Origin})";
            if (Message.Length > 0) text += " - " + Message;
            return text;
        }
    }
}
