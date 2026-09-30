# ShadowMount transfers

Select the PS5 profile, enter the console IP and FTP port, and open **ShadowMount**. Start your compatible ShadowMount payload on the console. **Load PS5 companion** connects to ShadowMount's local API without exposing its unauthenticated API to the network. It reuses an already connected companion; it does not load etaHEN, kstuff, or ShadowMount.

Use **Prepare internal storage** if no internal destination is shown. It creates the standard homebrew folder and remembers preparation for that console. On builds that omit the `/data` alias from their storage response, the app uses `/user/data/homebrew` and the console's actual `/user` capacity report. Refresh discovers existing writable internal, USB, and extended-storage destinations reported by ShadowMount. Custom scan paths are respected. The API port defaults to 10101.

Add a PS5 dump folder containing `sce_sys/param.json` and `eboot.bin`, or a `.ffpkg` / `.exfat` image. `.ffpfs` and `.ffpfsc` are accepted as experimental ShadowMount formats. Standard `.pkg` files belong in **PKG installer**. File transfer does not remove encryption, supply licenses, or guarantee that a particular dump can run.

Choose a destination and **Transfer / retry queue**. The app checks free space, refuses existing destinations, streams files with progress and speed, and withholds metadata until the complete source is copied. It checks every remote file size and records a local SHA-256 while uploading; it does not claim a full remote checksum readback. The PC source remains unchanged.

Keep the app open. Cancel keeps staging data; retry skips completed files with matching sizes and starts the interrupted file again. Keep the original PC source unchanged. The queue survives app restarts. Interrupted publication with an unknown outcome is reported for inspection rather than overwriting content. An ownership receipt remains with each transfer. Completed queue entries may be removed without deleting console files; incomplete staged entries are retained for retry.

After copying, the app requests a scan and distinguishes successful copying from confirmed ShadowMount recognition. Library controls offer mount, unmount, launch, and close. Close active games before mounting or unmounting. The library is refreshed on request; free-space readings reflect the last refresh.

If files are copied but registration fails on 13.60, use **Repair registration (13.60)**. After confirmation, this backs up ShadowMount's configuration locally, enables its native batch registration mode (`app_install_all=true`), and resets registration retries. The resulting scan can register other app folders already staged on the console. Existing configuration settings are preserved. Refresh the library after the scan; completed queue entries update when ShadowMount recognizes their source.

MCP exposes `psn_shadow_status`, `psn_shadow_refresh`, `psn_shadow_inspect`, and `psn_shadow_add`. Transfers, companion loading, rescan, and game controls remain desktop actions. PS4 workflows are unchanged.

Transfer speed depends on the console FTP server and network. In the 13.60 hardware check, etaHEN FTP on 1337 ran around 7 MB/s, while ftpsrv 0.21.1 on 2121 ran roughly 60–80 MB/s over the same gigabit link. Use the port of the FTP service you have running. The app does not automatically start or replace FTP servers. Its existence checks handle ftpsrv's misleading `SIZE` response for absent files by reading the parent directory instead. On ftpsrv connections, the app disables virtual decrypted SELF transfer mode so file-size checks and downloads use the original stored bytes.

Requires ShadowMount API v1 and PS Neighborhood PS5 companion revision 106. Developed against the supplied `1.7beta2-snipers1360-r1` ShadowMount source. External-drive behavior depends on the mounted drives reported by the console.
