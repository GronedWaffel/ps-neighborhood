# PS5 saves on firmware 13.60

PS Neighbourhood exports decrypted PS5 save files and restores edits to existing files for the same console, local user and game. It requires FTP, a connected PS5Debug service and companion revision 105. The PS5 BO2 trainer is separate and remains deferred.

## Export, edit and restore

1. Close the target game. In **Console & storage**, load the PS5 companion and refresh the library.
2. Under **Game saves**, select **Export decrypted**. The app first downloads a complete encrypted backup, then mounts disposable copies to export their plaintext files. **Open backup folder** opens the output directory.
3. Copy the completed decrypted export before editing. Keep its `manifest.json` unchanged. Use an editor appropriate to the game to edit existing files inside a single `sdimg_*` folder; leave other containers and all `sce_sys` metadata unchanged.
4. Select **Prepare restore** beside the same save and choose the export folder containing `manifest.json`. The app checks for newer game progress, backs up the current encrypted originals, edits a staged copy, re-encrypts it and mounts it again to verify every file.
5. Review the changed-file list and select **Restore edited save…**. The desktop confirmation identifies the game, container and files. Keep the game closed throughout. Preparations expire after 30 minutes and are discarded when the app exits; **Discard preparation** also clears one without changing the installed save.

Replacement uploads a verified incoming image and separate recovery copy beside the original, preserves ownership and permissions, and uses one atomic rename. Read-back hashing must pass before the on-console recovery copy is removed. The original PC backup remains. An ambiguous result is never retried automatically; retain the backup and inspect the console before retrying.

## Scope

- Existing-file edits in one PS5 save container per restore, up to 4 GiB per container. Adding/deleting files, editing protected metadata, creating saves, resigning and transferring between accounts/consoles are not implemented.
- If the game saves again after export, export a fresh copy. Do not restore an old edit over newer progress.
- This provides decrypted file access and re-encryption, not a universal game-save editor. Games may have internal checksums, compression or validation that an appropriate editor must handle.
- PS4 saves retain the encrypted-backup workflow. PS5 decryption applies to PS5 save containers, not every save merely stored on a PS5.
- Hardware validation on 13.60: one closed-game container exported five plaintext files (715,316 bytes). A one-byte edit to a disposable copy survived re-encryption and full remount verification. Installed replacement and ownership preservation passed using unchanged original bytes. Arbitrary edited content has not been tested in-game.

## MCP

Use `psn_console_status` to find a save ID, then `psn_console_backup` with `{ "id": "<save-id>", "decrypted": true }`. Poll `psn_console_status` until its `backup.state` is `complete`; `backup.local` names the export and `backup.encryptedBackup` names the retained original backup. The companion must first be loaded in the desktop. Restore preparation and installation stay in the desktop, with explicit confirmation.

Research references: [Garlic SaveMgr](https://github.com/earthonion/garlic-savemgr) and the GPL-licensed [PlayStation 5 Save Mounter](https://github.com/n0llptr/Playstation-5-Save-Mounter). See [third-party notices](../THIRD-PARTY-NOTICES.md).
