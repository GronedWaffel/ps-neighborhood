# PS Neighborhood — Support Build

This separate Windows build adds an **opt-in remote support session** for console diagnostics. The normal release stays available. It does not fix or replace etaHEN, install a jailbreak, or require a new console companion.

## Tester setup (one download)

1. Download the **Support Build** Windows ZIP from this repository's Releases page. Extract the whole folder. Do not copy only the EXE.
2. Run **Start PS5 Neighborhood.cmd**. Windows users do not need Node.js or developer tools.
3. In Overview, enter your PS5's local IP and save its profile. Enter its actual FTP port (often 1337 or 2121), debugger port (usually 744), and ELF loader port (usually 9021). Use your firmware version or `auto`. Your PC and PS5 must be able to reach each other.
4. Enable the console services needed for the agreed test. **FTP is enough to retrieve logs.** PS5Debug is needed only for process/memory tools; an ELF loader is needed only for payload sending. Support pairing itself works without those console services and reports connection failures normally. Do not reload a debugger that is already running.
5. Click **Remote support** at the bottom left. Check the selected console address. Leave **Allow support actions** off for diagnostics only, or enable it if you agree to ELF testing and memory changes.
6. Click **Start support session**. Privately send the displayed 16-character code to Snipers support within five minutes. Keep the app and PC awake. No router port forwarding or MCP configuration is needed on your PC.
7. The panel changes to **Operator connected** and lists requests as they run. **Disconnect now**, or the persistent **Disconnect support** button outside the panel, ends access. Closing the app also ends access.

The small × closes only the panel; the persistent Disconnect button remains visible. Sessions expire after one hour and never reconnect automatically after a lost relay connection. A new session creates new credentials. Changing permissions requires ending the session and starting another.

Local console operations pause while support is active to avoid competing debugger connections. Disconnecting support leaves the normal workbench available; use Connect console again if needed.

## What access includes

Diagnostics: console connection checks, process identity and memory maps, bounded live memory reads, typed fields, strings, pointer chains, FTP directory listings and console-file reads up to 4 MiB. No arbitrary files on the tester's PC are exposed.

With **Allow support actions**: PS5 ELF sending (validated ELF64, SHA-256 checked, up to 32 MiB) and memory compare/write/read-back (up to 4096 bytes). ELF sending does not establish firmware compatibility or successful execution. Memory compare/write is not atomic against running console code. The normal local MCP permissions are unchanged; remote actions use the separate session permission.

This build does not expose arbitrary shell commands, PC filesystem browsing, package installation, saves, power controls, remote desktop/video, or unrestricted TCP tunnels. A frozen console may still need its owner to restart and restore services. **Disconnect cannot undo an action already executed or unload a payload.** It blocks new requests and aborts active support connections/transfers; an interrupted transfer may have an uncertain result, so it is never automatically retried.

## Operator setup

The public download contains **no operator key**. Only operators provisioned on the Snipers relay can pair a code. A code alone is not an operator credential. The tester approves the scope by starting the session; the first authorized operator claim consumes the code.

Using Node.js 24+, or the packaged Electron runtime with `ELECTRON_RUN_AS_NODE=1`, run `resources/app/src/support-operator.mjs`. Set:

```powershell
$env:PSN_SUPPORT_KEY_FILE = 'C:\Private\snipers-support-operator.key'
$env:PSN_SUPPORT_CONNECTION = 'C:\Private\current-support-session.json'
node src/support-operator.mjs pair CODE_FROM_TESTER
node src/support-operator.mjs call status
node src/support-operator.mjs call ftp_read args.json
```

An FTP `args.json` can contain `{"remote":"/data/etaHEN/experimental-diagnostics/trace.log","encoding":"utf8"}`. `payload_send` accepts `{"local":"C:/Private/test.elf"}` on the operator PC; that local file is validated and sent through the relay. Preserve test binaries and hashes separately so reports can be correlated. Never automatically retry a payload after a timeout or connection loss.

MCP configuration on the **operator's** machine:

```json
{
  "mcpServers": {
    "ps-neighborhood-support": {
      "command": "node",
      "args": ["C:/PATH/ps-neighbourhood/src/support-operator.mjs", "mcp"],
      "env": {"PSN_SUPPORT_CONNECTION":"C:/Private/current-support-session.json"}
    }
  }
}
```

Tools are prefixed `psn_support_`. Pair first, call `psn_support_status`, then use only the tests agreed with the owner. The same CLI remains usable when an MCP client cannot hot-load a server. `node src/support-operator.mjs disconnect` ends the operator session.

## Relay and privacy

The desktop makes outbound HTTPS requests to `https://sniperscheats.lol/support/api`. The relay authenticates the operator separately and keeps session credentials, queued requests and results in memory only. It terminates TLS and can see the data it forwards; this is **not end-to-end encryption**. It does not archive file contents or payloads. Saved operator outputs follow the operator's local workflow.

The relay is an isolated loopback service behind HTTPS, with session expiry, owner heartbeat expiry, limited command concurrency and resource limits. Relay restarts invalidate every session. The owner enforces the method allowlist, permission and console binding independently of the relay. The shipped app does not contain VPS credentials or an operator secret.

## Validation and limits

Automated tests cover pairing/authentication, one-time codes, permission enforcement, console binding, command results, disconnect during an operation, expiry, real TCP ELF delivery, FTP content retrieval, and a real MCP stdio handshake. An offscreen Windows test exercises the session UI and the persistent disconnect control. Hardware and firmware compatibility of each console service remains dependent on the tester's installed payloads. This support build is not a claim that the 12.40 etaHEN startup issue is fixed.

Existing etaHEN/LightningMods, PS5 Payload SDK, debugger and project credits remain in the corresponding source files and THIRD-PARTY-NOTICES.md.
