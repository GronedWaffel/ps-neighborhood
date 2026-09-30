# Roadmap

- [x] Add PS5 13.60 decrypted save export through desktop/MCP and verified edited-file restore preparation. Installed replacement tested with unchanged originals; see [save validation limits](PS5-SAVES.md).

- [x] Validate PS5 13.60 memory scans, guarded diagnostic writes, RAM export, pointer tools, MCP, FTP, inventory, internal capacity and an encrypted save archive. See the scoped option audit.
- [x] Implement PS5-native launch/close, power/uninstall service paths and AppInstUtil package streaming.
- [x] Resolve PlayGo INVALID_SLOT and validate a PS4 and PS5 PKG install on 13.60.
- [x] Validate test-content uninstall, patch removal/reinstall, update/DLC queue and native pause/resume.
- [x] Verify restart on hardware with user confirmation.
- [x] Shutdown tested successfully by the user; rest mode and restart also passed.
- [x] Browser installation and byte verification passed; the user subsequently confirmed the browser works. The earlier automated launch returned 0x80020060.
- [x] Validate native integer scanning/refinement on PS5Debug-NG 1.3.2.
- [ ] Add verified hardware results for additional PS4 firmware targets.
- [ ] Validate PS4Debug-NG scanning on real hardware.
- [ ] Improve trainer validation across maps and supported game builds.
- [ ] Confirm external/M.2 storage on a real additional drive when available. Detection and direct/nested layouts have automated coverage; the current console has no extra drive.
- [x] Validate the generated importer in Ghidra 12.1.3, including saving/reopening, analysis, addresses, permissions and hashes.

PS5 memory, FTP, ELF, storage and save-archive paths have scoped 13.60 hardware checks. PS5 launch/close and native integer scanning are now verified. PS4 Minecraft and the PS5 browser package now install successfully over HTTP on 13.60. See [setup](PS5.md), [compatibility](COMPATIBILITY.md) and the [option audit](PS5-VALIDATION.md).
