# PS5 option audit — 2026-09-30

## ShadowMount transfer follow-up (0.10.0)

On PS5 13.60 with ShadowMountPlus `1.7beta2-snipers1360-r1` and companion revision 106, a PS5 folder was copied to internal storage and registered successfully. All remote file sizes matched; small-file SHA-256 readbacks also passed. The source remained unchanged. The library reported installed, managed and source available, and the user confirmed the transferred game plays correctly. External-drive transfers were not tested in this check.

Real interruption/retry skipped completed files and finished the transfer. ftpsrv 0.21.1 required disabling virtual decrypted SELF mode for accurate stored executable sizes. Its missing-file SIZE response was also handled through parent-directory listing. Transfers ran roughly 60–80 MB/s on the tested gigabit link.

The existing per-title registration hook was unavailable. Enabling ShadowMount's built-in `app_install_all` mode, after backing up its configuration and resetting registration retries, completed native batch registration. No etaHEN, ShadowMount or debugger reload was required. The desktop exposes this as an explicit repair action because a batch scan may register other staged applications.

## Earlier 0.9.0 audit

Environment: PS5 firmware 13.60, PS5Debug-NG 1.3.2, PS Neighbourhood 0.9.0, Windows x64. Hardware results apply to this environment and the tested operations, not every game or firmware. Private captures and device details are excluded from source control.

## Confirmed on hardware

- **Connection and profile:** separate PS5 workspace, firmware/platform/branding handshake, process list, title identity and mapped addresses. Existing PS5Debug is reused.
- **Memory reads:** bounded reads, batched reads, typed structure decoding and string extraction through the real stdio MCP bridge.
- **Scanning:** every signed/unsigned integer width, float, double, text and wildcard AOB. Unknown initial values and increased/decreased/changed/unchanged refinements were checked against controlled changes in a diagnostic payload. Numeric and AOB scans also ran against a bounded game-memory range.
- **Writes:** expected-byte compare, read-back verification, mismatch rejection and the MCP write gate. Writes affected only the temporary diagnostic's scratch buffer. Original bytes and MCP settings were restored; the diagnostic exited. This is not validation of a particular game cheat.
- **Watches:** add, read and remove, including a live game value.
- **Pointers:** live pointer resolution and discovery of a known pointer in a captured diagnostic buffer. Multi-level behavior has automated coverage; stable pointers across game restarts are not guaranteed.
- **RAM export:** two bounded game captures, file hashes, original virtual addresses and generated Ghidra importer. Offline reads/scans and comparison of unchanged captures passed. The importer was executed in Ghidra 12.1.3, saved, reopened and analyzed; original addresses, permissions and SHA-256 hashes matched.
- **FTP:** browsing, binary download, upload/download round trip and refusal to overwrite an existing file. Only the uniquely named validation file was removed afterward.
- **ELF loading:** PS5Debug and our distinct storage/diagnostic ELFs transferred and executed. Loader sockets are not probed with empty connections.
- **Inventory:** installed base/patch/DLC file sizes, PS5 `tbl_contentinfo` catalog names, PS5 `param.json` version/title metadata and CUSA/PPSA entries. Empty or stale directories can appear separately from validated installed content; presence does not establish playability.
- **Storage:** a new PS5-only companion supplies `/user` partition capacity. Parent mounts masquerading as unmounted external paths are excluded. Actual external drives and M.2 storage remain unverified.
- **Saves:** PS4 and PS5 encrypted save directories and visible metadata were enumerated for local users. One small closed-game PS5 save archive downloaded through MCP and every local file hash verified. Revision 105 adds decrypted export and a same-console/user edited-file restore workflow, tested as detailed below. Account transfer is not implemented.
- **MCP:** discovery of 39 tools, 3 resources and 1 prompt; the live checks above used the packaged stdio bridge. Memory writes require the desktop gate. Console mutations remain restricted by platform and origin.

## Automated coverage or unverified limits

UI navigation/profile settings, cancellation, failure handling, scan boundary cases, large-address arithmetic, multi-level pointer chains, mutation-during-backup detection, save-use guards and platform restrictions have automated tests. Full-console RAM captures, every game, every save format, other PS5 firmware have not been verified. Ghidra 12.1.3 execution passed the checks described below.

## Native control follow-up

- **Launch/close:** BO2 (PPSA34502) closed, returned no running app ID, relaunched and remained running after 30 seconds. PS5 small nonnegative app IDs are handled independently of PS4 IDs.
- **Native NG scanner:** the actual packaged stdio MCP bridge selected the native backend successfully. A direct exact u32 scan and unchanged refinement of a bounded executable region passed, followed by a byte-identical read confirming stream framing. Enabled for PS5Debug-NG 1.3.2 only.
- **PKG:** revision 102 installed the PS4 Minecraft base (CUSA00265, 186,122,240 bytes) and PS5 browser (MOUU12023, 37,633,547 bytes) directly over HTTP. Both reached full transfer, 100% promote, playable and no native error; the user confirmed both installs. The folder importer validated 75 files. The separately tested base was skipped; the queue installed the update and all 73 DLC files. The final update test used dedicated patch status and reached 2,569,928,704 transferred bytes, promoting, then playable.
- **Uninstall and power:** rest mode passed with user confirmation. Full browser uninstall was followed by reinstall. Restart passed; shutdown was tested successfully by the user; existing retail games have not been removed.
- **Patch-only removal:** one-title argument ABI inspected on 13.60 and enabled for separately stored patches. Removing the new Minecraft update preserved the base game and all DLC byte counts. Reinstall restored the patch.
- **BO2 trainer:** PS4 profile remains guarded; user deferred the PS5 trainer port.
- **Regression checks:** 87 automated tests and the Electron UI smoke test passed after the control port. Earlier read-only storage/memory results above still apply.

The first runtime service-loading attempt timed out; the console debugger and FTP remained responsive. Linking SystemService, UserService, Ipmi, then AppInstUtil before startup resolved the capability and initialization issue. Neither PS4Debug nor PS5Debug was reloaded during these tests.

The optional service diagnostic reports only its own PID and exported function pointers. Library instruction reads went through PS5Debug. The later controlled uninstall and patch-removal tests used only the newly installed test content. A diagnostic attempting direct access to protected executable pages did not reply; switching to debugger reads resolved it.

Native pause/resume: both the PS5 browser base download and PS4 Minecraft update entered the native paused state, resumed transferring, then completed. The update requires separate PausePatchInstall/ResumePatchInstall exports. The installed browser was uninstalled and restored, with the other 12 titles preserved. Minecraft launch, stable process identity and close passed. Browser launch returned 0x80020060; an FTP readback found zero differing bytes against the original file prefix (37,617,664 installed bytes; the original file includes a trailer). The user subsequently confirmed the browser works; the earlier automated launch failure is retained as historical test evidence.

Rest mode is hardware/user-confirmed on PS5 13.60. Restart passed with user confirmation and disconnected services; shutdown was tested successfully by the user. Full uninstall was tested only on the newly installed browser, which was then reinstalled. Patch removal was tested only on the newly installed PS4 Minecraft update, which was restored. Existing retail titles were preserved.


Installer ABI correction (2026-09-29): read-only inspection of AppInstUtil in our own companion found metadata reads at 0x30 (u32) and 0x34 (byte), beyond the previous 48-byte definition. Adding zero-valued fields resolved INVALID_SLOT. The status marshaller writes 0x2c8 bytes rather than 600, with the error record at 0xa0; correcting this resolved the progress-query companion crash. The interrupted browser download reported a network error and was retried only after that failure was confirmed. Both formats then completed. No credential expansion, debugger reload, ShellUI injection or firmware patch was required. Native regression checks exercise these read/write boundaries using synthetic data. Private Sony code captures are excluded from source control.

Revision 103 selects GetPatchInstallStatus for updates: the general query returns the old base while downloading, then base-plus-update totals. Patch completion checks the submitted size and waits for native playable/completed status. Both status calls write 712 bytes on 13.60. Native installation rejects other firmware until that ABI has been validated.

FTP compatibility follow-up (2026-09-29): after reboot, the active FTP server ignored LIST path arguments and returned its current directory. Inventory now changes to each absolute directory before listing; the same helper protects FTP browsing and upload overwrite checks. Regression checks against an argument-ignoring server passed (27 targeted tests), and the live refresh completed in approximately nine seconds with 13 named games, 62 save groups and no warnings. No shutdown command was sent during this refresh. The user subsequently tested shutdown independently and confirmed success.

Ghidra validation (2026-09-29): Ghidra 12.1.3 with JDK 26.0.2.1 imported a real 65,536-byte PS5 capture and a 12,288-byte synthetic capture spanning three regions with different permissions and gaps, including addresses above 4 GiB. Each program was saved, reopened and analyzed. An independent verification script compared every byte by SHA-256, each start/length and read/write/execute flag, block count and total captured address count. All passed. Headless imports now save the new program automatically. Reproduce with scripts/verify-ghidra.ps1; logs and private captures remain under ignored artifacts/.

Storage revision 104 adds filesystem/device metadata and probes ext0–7 and usb0–7 as well as /user and /user2. Inventory excludes tmpfs/devfs placeholders and duplicate device aliases, and reads both direct and user/ game layouts. Automated fixtures cover separate USB/M.2 totals, patches, placeholders, aliases and multi-terabyte capacities. The user has no additional drive attached, so actual external/M.2 hardware validation cannot be performed on this console.

Revision 104 was loaded on the PS5 after confirming no transfer was active. The internal drive returned filesystem bfs and source ssd0.user; empty extra-drive slots were excluded. The final inventory listed 13 games and 62 save groups with no warnings. 39 targeted storage/memory/export tests passed, followed by 18 storage regression checks after normalizing device names with and without /dev/. The Electron UI test passed including a separate M.2 capacity panel. Its stale fixture host was corrected to match the selected console.

Save revision 105 (2026-09-29): a closed-game PS5 container exported five decrypted files totaling 715,316 bytes, with retained encrypted originals. A one-byte edit to a disposable local copy was uploaded only to staging, re-encrypted, remounted and verified against all expected plaintext hashes. The actual installed replacement path passed using unchanged original bytes; full encrypted SHA-256, mode, UID and GID matched afterward. Arbitrary edited content has not been tested in-game. An initial hard-link approach was rejected before changing the original; the final implementation uses a separately uploaded and hash-verified recovery copy followed by a single atomic rename. PS5Debug was reused throughout. See PS5-SAVES.md for limitations.

The updated portable build's actual stdio MCP bridge completed a second decrypted export with all five file hashes verified. Discovery still reports 39 tools, with the new `decrypted` option on `psn_console_backup`. 38 targeted save/console/protocol/MCP tests passed, along with an Electron UI run covering decrypted-export dispatch, cancelled folder selection, cancelled restore confirmation and discarding a prepared restore. The final live inventory reported 13 named games, 62 save groups, save-mount capability and no warnings.
