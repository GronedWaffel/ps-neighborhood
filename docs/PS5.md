# PS5 setup (experimental)

v0.9.0 adds a PS5-specific connection path, memory tools, FTP, inventory, encrypted save archives and a separate PS5-native companion. These have scoped PS5 13.60 hardware checks with PS5Debug-NG 1.3.2. See the [option-by-option validation record](PS5-VALIDATION.md). It is not a port of the PS4 native receiver.

## Start your workspace

1. Extract the portable build and open **Start PS5 Neighbourhood.cmd**. From source, use `npm start -- --ps5`.
2. Enter your console IP in Overview. Select **PlayStation 5**, debugger port **744**, FTP **2121**, ELF loader **9021**, and the appropriate firmware profile, then save.
3. FTP browsing and file transfer are independent of the debugger. Open File browser and list `/` to check the service.
4. For memory tools, use a compatible PS5Debug service. This integration targets [PS5Debug-NG 1.3.2](https://github.com/Pharaoh2k/ps5debug-NG/releases/tag/1.3.2), whose upstream release explicitly lists firmware 13.60.
5. If the debugger is already running, connect to it. Otherwise choose the compatible upstream ELF in Payload loader and send it once through your existing ELF loader. The sender refuses a named PS5Debug payload if a debugger is already listening or its state is uncertain. A successful transfer does not confirm execution; Connect console confirms the debugger protocol.
6. Connect, select the intended process, and use the memory scanner, inspector, watches or RAM capture tools. Start with a small readable range.
7. In Console & storage, choose **Load PS5 companion** to enable partition-capacity readings and available game/power controls. This is our separate PS5 ELF, not another debugger. It exits when the app connection closes. Refresh the library for games, patches, DLC, save groups and storage categories.
8. For saves, connect PS5Debug and close the target game first. Choose **Encrypted backup**, or **Export decrypted** for PS5 saves with companion revision 105. Edit existing files and use **Prepare restore** to verify and confirm replacement. See the [save guide](PS5-SAVES.md) for steps and limits.

The PS5 launcher uses a separate `resources/app/data/ps5` directory; the source equivalent is `data/ps5`. Copy your MCP configuration from the PS5 window so the client uses that same workspace. `PSN_DATA`, when set, overrides the default directory.

## Available paths

- FTP browsing, downloads and uploads, using the existing no-overwrite behavior.
- ELF64 x86-64 payload validation and raw transfer to the configured ELF loader.
- PS5Debug platform, firmware and branding detection.
- Process enumeration, mappings, process info, bounded reads, typed inspection, strings, pointers and guarded writes.
- Host scans/refinements, watches, RAM bundles, offline scans/comparisons and pointer search.
- The same memory and FTP MCP tools as the desktop.
- Read-only CUSA/PPSA library inventory using PS5 catalog and parameter metadata, installed-file sizes and save directories visible over FTP. A file inventory is not proof that content is launchable.
- Partition capacity through the separate PS5 storage companion, and hashed encrypted save archives through FTP/MCP.

Native integer scanning and refinement are enabled for PS5Debug-NG 1.3.2, with host scanning for other types and unvalidated debugger versions. PS5Debug-NG's shared classic process protocol is used for reads and writes. Writes still require expected bytes and read-back checks, and MCP writes start disabled.

## Native controls and installer limitations

The PS5 companion implements launch, close, uninstall and shutdown/restart/rest requests using PS5 service APIs. BO2 close and relaunch passed on 13.60, including a 30-second stability check. Rest mode passed with user confirmation. Full uninstall of the new browser package and patch-only removal of the new Minecraft update passed; both were restored. Restart passed; shutdown was tested successfully by the user.

The PKG page accepts validated PS4 CNT and PS5 FIH/CNT files, including the tested MOUU homebrew ID format. Folder queues use native install status before advancing. Native pause/resume is available in the app and passed for both a base package and a separate update. Updates use dedicated patch status and control functions. On 13.60, both PS4 Minecraft (CUSA00265) and InternetBrowser-PS5M.pkg (MOUU12023) installed directly over HTTP. Native status reported full transfer, 100% promote and playable with no error, and the user confirmed both. Use companion revision 103 or newer. Revision 102 corrected incomplete native structure layouts; revision 103 adds patch-specific progress and pause/resume. Native installation is limited to the verified 13.60 ABI until other firmware layouts are checked.

The included BO2 trainer remains PS4/build-specific and rejects PS5. Its PS5 port is deferred.

Do not rename a PS4 payload to `.elf`. The ELF validator checks file structure, not firmware compatibility or payload trust. The app does not download a debugger automatically and does not reload one on connection failure. Check services deliberately skips ELF/BinLoader sockets to avoid treating an empty connection as a payload.

## Report results

Include the app version, exact firmware, loader and debugger versions, and feature-by-feature results. Distinguish live hardware results from simulation. Upstream debugger support alone is not PS Neighbourhood hardware validation. See [compatibility](COMPATIBILITY.md) and [contributing](../CONTRIBUTING.md).

Minecraft base, update and 73 DLC packages are registered on-console, and the storage viewer lists their names and sizes. Minecraft launch/close passed. The PS5 browser installed with byte-identical content. An earlier automated launch returned 0x80020060, but the user subsequently confirmed the browser works.

Rest mode is hardware/user-confirmed on PS5 13.60. Restart passed with user confirmation and disconnected services; shutdown was tested successfully by the user. Full uninstall was tested only on the newly installed browser, which was then reinstalled. Patch removal was tested only on the newly installed PS4 Minecraft update, which was restored. Existing retail titles were preserved.

## PS5 save editing

Companion revision 105 adds staged-copy decryption, verified re-encryption and confirmed replacement of one existing PS5 save container. Decrypted export and edited-copy preparation passed on 13.60; installed replacement passed with unchanged original bytes. PS Neighbourhood is not a game-specific save editor or account resigner. See [PS5 saves](PS5-SAVES.md) for the complete workflow and validation scope.
