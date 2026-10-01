using System.Text.Json;

var cancel = new CancellationTokenSource();
// EOF means the parent app exited unexpectedly. Stop this worker too.
_ = Task.Run(async () => { var line = await Console.In.ReadLineAsync(); if (line is null or "cancel") cancel.Cancel(); });
try {
    if (args.Length == 1 && args[0] == "selftest") { await Conversion.SelfTest(); return 0; }
    if (args.Length != 4 || args[0] != "convert") throw new ArgumentException("convert <pkg> <empty work directory> <title ID>");
    await Conversion.Run(args[1], args[2], args[3], cancel.Token);
    return 0;
} catch (OperationCanceledException) { Conversion.Emit(new { type = "cancelled" }); return 2; }
catch (Exception e) { Conversion.Emit(new { type = "error", message = e.Message }); return 1; }
