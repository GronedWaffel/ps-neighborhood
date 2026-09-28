# PS Neighbourhood

[![Release](https://img.shields.io/github/v/release/GronedWaffel/ps-neighbourhood)](https://github.com/GronedWaffel/ps-neighbourhood/releases/latest) [![License: GPL v3+](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE) ![Windows x64](https://img.shields.io/badge/platform-Windows%20x64-0078D4) ![Hardware tested: PS4 10.01](https://img.shields.io/badge/hardware%20tested-PS4%2010.01-orange)

**Your PS4 workbench: memory scanner, MCP server, Ghidra RAM exports, direct PKG installs, FTP, saves and console management.**

PS Neighbourhood brings console tools into one Windows desktop app. Explore a running game's memory through PS4Debug, capture regions for offline analysis, build a trainer, or install a folder of local PKGs directly from your PC. An integrated [Model Context Protocol](https://modelcontextprotocol.io/) server gives compatible AI clients access to the same memory workflow.

> **Compatibility: only PS4 firmware 10.01 has been hardware-tested. Nothing above 10.01 has been tested on real hardware.** Other listed PS4 firmware targets are experimental, including versions below 10.01. Individual features have their own validation limits below.
>
> **PS5 13.60 is a future goal, not current support.** We plan to add support when a compatible jailbreak and the necessary debugging/payload tools become available. This requires a separate PS5 implementation and hardware validation; there is no release date or compatibility guarantee.

[Getting started](#getting-started) · [Features and options](#features-and-options) · [MCP setup](docs/MCP.md) · [Compatibility](docs/COMPATIBILITY.md) · [Build from source](#build-from-source) · [Roadmap](docs/ROADMAP.md)

**Contributors and testers welcome!** Fork the project, open a pull request, or help verify another firmware or software version. Improvements to the scanner, MCP tools, trainers, receiver, UI and documentation are all welcome. [Start contributing](CONTRIBUTING.md) or [submit a compatibility report](https://github.com/GronedWaffel/ps-neighbourhood/issues/new?template=firmware_report.md).

![PS Neighbourhood memory scanner in the simulated memory lab](docs/images/memory.png)

## Getting started

### Windows portable release

1. Download the Windows x64 ZIP from the [Releases page](https://github.com/GronedWaffel/ps-neighbourhood/releases/latest) and extract the whole folder somewhere writable.
2. Run **PS Neighbourhood.exe**. No separate Node.js installation is needed.
3. Enter your PS4's local IP in the console profile. The initial localhost value is a placeholder.
4. Enable the services needed for your task, then connect. Typical ports are PS4Debug **744**, FTP **2121**, and GoldHEN BinLoader **9090**; all are editable.
5. For PKGs and native console controls, open the PKG installer and load **PS Neighbourhood background receiver** through BinLoader.

PS4Debug must already be running for live memory tools. Reuse an existing PS4Debug session; **do not load another copy just because a connection fails**. The app does not jailbreak your console and does not include GoldHEN or PS4Debug.

No console available? Choose **Open memory lab** to try scanning, inspection, watches and dumps against simulated memory. Simulated memory operations do not contact a console.

Keep the portable folder together. Your settings, MCP bridge credentials, downloads, scans and captures live under `resources/app/data`; source builds use `data`. Keep that directory private. Set `PSN_DATA` to use another directory, and use the same value for the main app, trainer and MCP client.

## Features and options

### Memory scanner and inspector

- Scan integer and floating-point values, text, and array-of-bytes patterns with wildcards.
- Start from an exact value or an unknown initial value, then refine by changed, unchanged, increased, decreased or a value range.
- Inspect hex and ASCII, decode typed structures, extract strings, follow 64-bit pointers and watch addresses.
- **Host scanner:** disk-backed candidates and paged results; works with the classic PS4Debug protocol.
- **PS4Debug-NG scanner:** negotiated native integer scans when the payload advertises support. Unsupported types fall back to the host engine. NG has automated protocol coverage but still needs real-console validation.
- Explicit scan selections are bounded to 512 MiB. Cancel jobs, inspect progress and continue refining without presenting every candidate at once.
- Memory writes compare the expected bytes first and verify by reading back. This is not atomic against a running game. MCP writes require an explicit switch in the desktop.

### RAM capture, Ghidra and offline research

Select readable mappings or a bounded address range and save raw memory segments with original addresses, permissions, SHA-256 hashes and a manifest. A generated Java importer helps place the segments into Ghidra at their captured addresses; [Ghidra](https://github.com/NationalSecurityAgency/ghidra) is installed separately. The generated importer has not been independently validated inside Ghidra.

Scan dumps offline, compare captures, inspect strings and structures, or reverse-search for pointer chains up to five levels deep. Searches expose truncation and require revalidation across captures. Captures are sequential, not an atomic snapshot; ASLR addresses can change between sessions. These exports do not reconstruct an original executable.

### Install PKGs directly from your PC

Choose a local PKG or **add a whole folder**, optionally including subfolders. Review detected files, remove unwanted entries and run the queue. Duplicate entries are ignored, invalid headers are flagged, and packages are submitted sequentially. The queue stops on errors or uncertain replies and is not persisted between app sessions.

- **Background receiver:** our included, source-built payload runs in the PS4 background. You do not have to leave a Remote Package Installer app open on the console.
- **Remote Package Installer:** an optional compatibility route for an existing RPI installation; its console app must be open. Configure its API port for your fork.
- Files stream directly from their existing PC location. There is no USB transfer or second full local copy.
- Progress distinguishes transferred data from final installation. PS4 Notifications → Downloads remains the final authority.
- Keep the PC and app running until installation finishes; minimizing is fine. The app prevents idle sleep during file serving, but cannot prevent a manual shutdown.

The background receiver normally uses TCP **9697** for its authenticated callback and **9696** for PKG serving. Allow the console to reach those ports on your private network. PKG checks validate headers, declared size and content identity, not cryptographic integrity or firmware/backport compatibility. Bring your own package files; none are provided.

### Storage, games and saves

View installed games, separate patches and DLC, available drive capacity, category sizes and save groups. Some bundled content can be recognized from mounted game assets, including BO1/BO2 profiles. Bundled assets are not separately removable DLC, and finding an asset does not prove that all DLC is present or playable. File totals are logical sizes and can differ from disk allocation.

Launch or close games, uninstall a game or its separate patch, and request shutdown, restart or rest mode from desktop controls. Destructive actions identify their target; running-title removal is refused. **Uninstall and power transitions have not been hardware-validated.** External-storage scenarios also need hardware testing.

Download an encrypted save group, key files and metadata with a SHA-256 manifest while the game is closed. This is a raw backup, **not save decryption, account resigning, USB export or a restore workflow**.

### FTP and payload loader

Browse the console's filesystem, download files and upload files through passive anonymous FTP. Downloads are staged before the final rename; uploads refuse to overwrite an existing file. Transfer resume and recursive FTP queues are not implemented.

Send a selected local payload through BinLoader with a displayed SHA-256 hash. A completed transfer means the bytes were sent; it does not confirm that the payload executed successfully.

### BO2 Zombies trainer

Open **BO2 Zombies Trainer.cmd** while the main app is connected and **MCP bridge → Allow MCP compare-and-write** is enabled. The trainer uses the same MCP tools as other clients.

Controls include points, clip refill/freeze, god mode, movement speed, FOV, native perk-effect toggles, replacement of the held weapon and supported Pack-a-Punch weapon variants. Clip refill stops on weapon changes and must be enabled again. Weapon replacement preserves the holstered slot rather than adding another primary.

This profile targets one verified `codzm.elf` build with title ID `CUSA57548`; it checks content identity and an executable fingerprint before writing. It is not a universal BO2 trainer. Perk purchase scripts/HUD icons are not implemented, and armory, perk behavior and sustained clip refill have additional validation limits. See the [trainer guide](trainers/bo2-zombies/README.md) for exact controls and evidence.

### Built-in MCP server

Connect Cursor or another stdio MCP client to the server. Use **MCP bridge → Copy configuration** in the running app so paths match your installation. The Node entry point is `src/mcp.mjs`; there is no Python `psn.mcp_server` module.

Tools cover processes, mappings, bounded reads, structures, strings, scans, watches, guarded writes, RAM dumps, offline inspection, pointer searches, FTP, package inspection/status, console inventory and save backup. Payload loading, installation submission, uninstall and power actions stay in the desktop. See [MCP setup and tool reference](docs/MCP.md).

## Firmware and validation

**10.01 is the only hardware-tested PS4 firmware.** The receiver has explicit experimental targets for **9.00, 9.03, 9.04, 9.50, 9.51, 9.60, 10.00, 10.50, 10.70, 10.71, 11.00 and 13.52**. A listed target or editable firmware profile does not prove compatibility. Unknown receiver firmware is rejected before credential initialization. Every console still needs compatible jailbreak, debugging and BinLoader capabilities.

On 10.01, live checks covered classic PS4Debug memory workflows, selected trainer controls, a completed PC-to-PS4 package installation, console inventory, save backup and game launching. Automated tests exercise additional paths using simulation and native dispatch fixtures; they do not substitute for console testing. Read the [compatibility notes](docs/COMPATIBILITY.md) before trying an experimental target.

**PS5 13.60 support is planned for the future**, conditional on a compatible jailbreak, usable tools and validation. PS4 firmware numbers and payloads do not imply PS5 compatibility.

## Build from source

Requires **Windows x64**, **Node.js 24 or newer**, npm, and **Zig 0.14.1** for the native receiver and its regression test. Download Zig from [ziglang.org](https://ziglang.org/download/) and verify its published checksum. The compiler is not committed or included in the portable release.

From a checkout, in PowerShell:

```powershell
npm ci
$env:ZIG = 'C:\path\to\zig.exe'
npm run build:receiver
npm test
npm start
```

If Electron's install script was disabled by your npm configuration, run `node node_modules/electron/install.js` before starting. Alternatively, place Zig at `tools/zig-x86_64-windows-0.14.1/zig.exe`, which is the build's fallback location.

```powershell
# Simulated desktop smoke test; does not contact the PS4
node node_modules/electron/cli.js tests/ui-smoke.cjs

# Build the portable Windows folder, including the native receiver and trainer
npm run package
```

Output: `dist/PS-Neighbourhood-0.8.3-win-x64/`. Packaging refuses to overwrite an existing version's folder. Keep that folder outside Git. Source launchers start the source checkout; portable launchers start their accompanying executable.

## Contributing

**Pull requests are encouraged.** This project is open to other developers, testers and documentation contributors. Small fixes, new features, reproducible bug reports and compatibility work all help. Fork the repository, make a focused change and open a PR against `main`; draft PRs are welcome for work in progress. For a larger change, open an issue first to discuss the approach.

**Help confirm other versions.** If you have another PS4 firmware, PS4Debug/NG or GoldHEN version, Windows setup, MCP client or Ghidra release, please report what works and what fails. Include exact versions, app release/commit, console model where relevant, steps and repeatable results. You can contribute a test report without writing code. Start with read-only checks and leave unsupported firmware guards in place.

Only PS4 10.01 currently has project hardware validation. Reviewed community results will be recorded by feature and exact environment in the [compatibility notes](docs/COMPATIBILITY.md), with links to the evidence. One successful connection will not be presented as confirmation that every feature works.

See the [contribution guide](CONTRIBUTING.md), [open issues](https://github.com/GronedWaffel/ps-neighbourhood/issues), or [submit a compatibility report](https://github.com/GronedWaffel/ps-neighbourhood/issues/new?template=firmware_report.md).

Please do not attach credentials, account details, save files, game packages, Sony binaries or raw memory dumps to public issues. Share a minimal synthetic reproduction or redacted log instead.

## Credits and license

PS Neighbourhood is released under **GPL-3.0-or-later**; see [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Third-party components retain their own licenses. Complete receiver source and its build instructions are included under [receiver/](receiver/README.md).

Built on the work of [GoldHEN](https://github.com/GoldHEN/GoldHEN), [PS4Debug](https://github.com/GoldHEN/ps4debug), [jogolden/ps4debug](https://github.com/jogolden/ps4debug), [PS4Debug-NG](https://github.com/OpenSourcereR-dev/ps4debug-NG), [DirectPackageInstaller](https://github.com/marcussacana/DirectPackageInstaller), [Remote Package Installer](https://github.com/flatz/ps4_remote_pkg_installer), [OpenOrbis](https://github.com/OpenOrbis/OpenOrbis-PS4-Toolchain), [ps4-payload-dev/sdk](https://github.com/ps4-payload-dev/sdk), [Electron](https://github.com/electron/electron) and the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). Additional attribution is in the third-party notices.

Independent homebrew project. Not affiliated with or endorsed by Sony Interactive Entertainment.
