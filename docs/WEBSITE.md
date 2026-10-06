# Website and companion

Open **https://psneighborhood.com** with the **0.14.0 or newer Windows companion**.
Run `Start Website Companion.cmd`, click **Start website session**, enter its code
on the website and approve the request on the PC. Only approve your own browser.

The website loads the same interface as the desktop app and dispatches to the
same Workbench. Memory tools, scans, dumps, watches, FTP, payload loading, package
queues/conversion, ShadowMount, console controls, saves and MCP keep their existing
backend implementations and firmware checks. Moving to the web does not broaden
firmware or game compatibility. The separate desktop trainer launchers remain in
the companion package.

## Where work happens

- The companion PC connects to the console and runs scans, exports, package
  serving, conversion and transfers. Large console transfers remain on that LAN.
- Website file/folder buttons open the existing native picker on the companion
  PC. Save-restore and console-action confirmations also appear there. This works
  from another browser device, but those native dialogs still require the PC.
- Downloads, save backups and Ghidra exports stay in the companion workspace.
  Open-folder buttons open that PC's folders. The website does not upload those
  entire files to the VPS or replace those controls with restricted browser APIs.
- Controls, displayed results, local paths and requested memory/file listings
  travel through the HTTPS relay. It holds transient sessions and requests in
  memory; no console data or pairing credentials are written to relay application
  logs. It is a trusted transport, not an end-to-end encrypted storage service.

## MCP and upgrading

MCP still uses local STDIO and the authenticated IPv4-loopback bridge. It is not
redirected through the website. Website and MCP share the selected console,
scans, watches and files. Connection changes and writes use the existing shared
queue; MCP's separate write gate and restricted action set remain enforced.

Close the old app before upgrading, preserve `resources/app/data` (or your
`PSN_DATA` directory), and never run two companions against the same workspace.
If you extract into a new location, update the MCP client's configuration from
that companion's MCP page. Pairing does not grant MCP additional permissions.

## Disconnect and background operation

Closing the window while website access is active hides the app in the tray.
Use the tray to reopen it, disconnect website access, or quit. The PC must stay
awake and online while serving the website and console jobs.

Codes expire in 15 minutes, work once, and require approval on the PC. Sessions
expire after eight hours. Closing the companion, losing its relay connection or
choosing Disconnect ends website access. Reconnection requires a new pairing;
commands are never retried automatically. A timeout may mean an operation is
still running: check its status before repeating it. Disconnect blocks queued
controls that have not started; it cannot undo a command already sent or cancel
every background job. MCP/local controls remain available after web disconnect.

## Validation

Integration tests exercise the real relay and companion against the simulated
console, plus a real STDIO MCP client. They cover shared memory/scans/dumps,
independent MCP write permissions, all seven native desktop capabilities,
pairing/approval, wrong origins/tokens, revoked queued commands and timeout
non-replay. Browser tests exercise the hosted interface, scanning, memory,
exports, navigation, native-action dispatch and reconnect. Existing firmware and
console feature regression tests remain in the release suite.

These checks do not substitute for testing every console workflow over a real
internet connection. No new hardware compatibility claim is made for web access.
