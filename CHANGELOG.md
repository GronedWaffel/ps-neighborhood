# Changelog

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
