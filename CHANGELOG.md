# Changelog

## 0.12.1 — Connection and first-run storage fixes

- Show live transfer byte counts in the converter while a large image is copying, instead of waiting for the entire file to finish before updating progress.
- Connect console and Check services save the entered IP and ports automatically. Failed connections and background polling preserve edits.
- Discover existing internal ShadowMount game folders over FTP on fresh installations, without relying on saved preparation state. Check real internal free space and respect custom scan paths and read-only mounts.
- Find conversion destinations automatically and prepare a missing internal game folder directly in the conversion window. FTP failures leave local conversion available; successful refreshes clear storage warnings.

## 0.12.0 — PS5 fPKG conversion for ShadowMount

- Detect finalized debug PS5 base-game packages in the PKG installer and ShadowMount source picker. Offer conversion or native installation, and hold folder-import entries for an explicit method choice.
- Bundle a self-contained converter with an open-source decoder. Preserve the original PKG, restore separate CNT metadata, build FFPFSC, verify every block, and compare decoded/source SHA-256 before transfer.
- Add working-space checks, progress, cancellation, saved verification receipts and optional automatic transfer of only the converted image. Existing installations remain protected and interrupted FTP copies can resume.
- This is a ShadowMount workaround for native PS5 fPKG launch limitations, not a native etaHEN/kstuff compatibility patch. See [conversion instructions and scope](docs/PS5-PKG-CONVERSION.md).

## 0.11.0 — GTA V Story Mode in-game menu

- Added the controller-operated GTA V menu, installed through PS5Debug-NG with executable fingerprint checks. Supports PPSA04263 01.000.000 and PPSA04264 01.010.002 with separate native maps, player offsets and mission profiles.
- Includes player/weapon controls, Never Wanted, searchable-by-category vehicle lists, performance upgrades and vehicle protection, clothing preview, character models, waypoint travel, weather/time, radio/phone options and confirmed progression actions.
- Model prefetching and bounded per-frame jobs keep the menu responsive. Movement and camera controls remain available while it is open. The menu remains resident when the PC app closes; reinstall after restarting GTA.
- Includes trainer C/JavaScript source, generated catalogs, both bridge images, build scripts and regression tests. Live native calls and user gameplay checks passed on PPSA04264 01.010.002 / PS5 13.60. The new Prologue state machine was compared and fingerprinted; its completion was not replayed against the user's progressed save.

## 0.10.1 — ShadowMount game transfers

- Added a PS5 ShadowMount page for folder/image transfer queues, free-space checks, progress, cancellation and file-level retry. Incomplete games remain staged, existing games are not overwritten, and copying is distinguished from console recognition.
- Added library refresh/rescan, mount/unmount and launch/close controls, plus MCP source inspection, queueing and status tools.
- Companion revision 106 bridges the console-local ShadowMount API through the existing authenticated connection. No ShadowMount LAN configuration changes are needed.
- Added a confirmed 13.60 batch-registration repair with a configuration backup, plus ftpsrv raw-file mode and missing-file compatibility fixes. Library refresh reconciles delayed recognition with completed transfers.
- See [ShadowMount setup and transfer details](docs/SHADOWMOUNT.md).

## 0.9.0 — PS5 13.60 workbench, installer, console controls and saves

- Fixed delayed ELF socket timeouts escaping into Electron's main process. Transfers now clear their timers, close their sockets, and return transport errors to the caller. Added completion, stalled-transfer, late-error and refused-connection checks.

- Added PS5 13.60 decrypted save export through the desktop and MCP, staged editing/re-encryption verification, and confirmed same-console/user restore of existing files. Companion revision 105 retains encrypted backups, protects metadata and rejects newer save progress. See docs/PS5-SAVES.md for hardware test scope and restrictions.

- Added PS5 companion revision 104 storage metadata, M.2 identification, extended/USB slot probing, placeholder/alias filtering and direct/nested library layouts.
- Verified the generated importer in Ghidra 12.1.3 against real and synthetic captures; added automatic headless program saving and repeatable import/analysis verification scripts.

- Fixed FTP browsing, inventory traversal and upload overwrite checks with servers that ignore LIST path arguments. Verified the corrected inventory on PS5 13.60 after reboot.

- Added PS4/PS5 platform selection and a separate PS5 workspace launcher.
- Added a PS5Debug-NG identity handshake and shared host scanning, memory, dump and MCP workflows.
- Added PS5 ELF64 validation and duplicate-debugger checks before loader connections.
- Removed empty loader-port probes from service checks.
- Added experimental read-only CUSA/PPSA FTP inventory.
- Added PS5-native launch/close, uninstall, power and AppInstUtil installation paths; kept the PS4-specific trainer behind a platform guard. Fixed text/AOB default alignment so valid unaligned matches are found.
- Added PS5 protocol, catalog, storage, save-archive and platform-guard regressions, plus PS5 UI coverage.
- Confirmed PS5 13.60 memory, all scan types, controlled scratch-buffer writes, pointers, RAM export, MCP, FTP, inventory, internal capacity and one encrypted save archive. Added a PS5-native companion and PS5 catalog/save layouts. See docs/PS5-VALIDATION.md for limits.
- Confirmed BO2 close/relaunch and native NG exact/refinement scans on PS5 13.60. Rest mode passed. Test-content uninstall and patch removal/reinstall passed; restart passed with user confirmation; shutdown was tested successfully by the user. Corrected the native install metadata and 712-byte status ABI; both PS4 Minecraft and the PS5 browser package now install over HTTP with native completion and user confirmation.
- Added dedicated PS5 patch progress and native base/update pause/resume, verified through a full update download. Installed 73 DLC packages through the folder queue and added named PS5 add-on catalog reading. Minecraft launch/close passed; the user subsequently confirmed the browser works after an earlier automated launch error with byte-identical installed content.
- Extended the duplicate-debugger check to five seconds: Windows can take just over two seconds to report a closed port.

## 0.8.3 — Community documentation and repository links

- Updated project and download links to GronedWaffel/ps-neighborhood.
- Added prominent invitations for pull requests and community testing.
- Expanded compatibility reports to record exact firmware, payload, Windows, MCP client and Ghidra versions with per-feature results.
- Included the contribution guide and changelog in the portable build.
- No new firmware support or console behavior is introduced in this release.

## 0.8.2 — Public release preparation

- Documented features, setup, MCP integration, known limitations and firmware validation.
- Made PS4 10.01-only hardware testing explicit; added the conditional PS5 13.60 roadmap.
- Included the BO2 trainer, its MCP client dependency and GPL license in portable builds.
- Added an explicit portable trainer entry point and aligned its default data directory with the main app.
- Removed source launchers' dependency on an old local portable build.
- Replaced the development console address with a localhost placeholder for new profiles.
- Added contributor and issue templates and excluded local/private artifacts from source control.

Existing scanner, RAM exports, PKG folder queue, console management, save backup, FTP and trainer functionality are included. See the compatibility and trainer guides for validation details.
