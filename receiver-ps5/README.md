# PS5 native companion

Revision **106** adds a bounded ShadowMount API bridge (command 23). The desktop sends a port, a fixed operation ID and at most 2044 JSON bytes; the companion connects only to `127.0.0.1`, permits a fixed route list, and returns at most 1 MiB of HTTP response over its authenticated PC connection. No public API listener is added. The desktop validates HTTP framing and ShadowMount status before accepting replies. This retains revision 105 save support and previous storage, installer and console controls. See [ShadowMount setup](../docs/SHADOWMOUNT.md).

This ELF supplies storage, application and power service calls plus experimental AppInstUtil package submission/progress. It connects back to the PC using a per-launch random token and bounded frames. Revision 103 uses PS5-specific service ABIs; it never injects code into ShellUI or reloads PS5Debug. Unknown commands and system title IDs are rejected. Patch-only removal is enabled on 13.60 for separately stored updates; removal and reinstall passed for a new Minecraft test update.

SystemService/UserService/Ipmi/AppInstUtil are linked in dependency order. Installer and launch authorization changes apply only to this companion process and restore the original auth ID after each call. Package arguments remain alive for native asynchronous use. A failed or ambiguous submission is not retried automatically.

ABI references: [PS5 SDK](https://github.com/ps5-payload-dev/sdk), [etaHEN PKG writeup](https://github.com/etaHEN/etaHEN/blob/main/PS5%20technical%20writeups/pkg-writeup.md), [PS5 package manager status ABI](https://github.com/itsPLK/ps5-pkg-manager/blob/main/include/install_service.h), [PS5Upload service references](https://github.com/phantomptr/ps5upload), and [SystemStateManager power ABI](https://github.com/StonedModder/PS5-SystemStateManager/blob/main/src/SystemStateManager.c). Our protocol and service implementation are independent; SDK-linked components retain their licenses.

See [validation](../docs/PS5-VALIDATION.md): launch/close, rest mode and both PS4/PS5 package installation passed on 13.60. Uninstall and reinstall passed on a new browser test package. Restart passed with user confirmation; shutdown was tested successfully by the user. Revision 102 fixes out-of-bounds metadata reads (fields at 0x30 and 0x34) and status writes (712 bytes, error at 0xa0), verified against the console marshaller. Public older structure definitions omitted these fields.

Live-tested on PS5 13.60 using the PS5 payload SDK v0.43. `/user` was mounted; `/mnt/ext0` and `/user2` resolved to parent mounts and were correctly excluded. External-drive capacity has not been hardware-tested.

Build with Node.js, Zig 0.14.1 and the official [PS5 payload SDK v0.43](https://github.com/ps5-payload-dev/sdk/releases/tag/v0.43):

```
node receiver-ps5/build.mjs
```

Set `PS5_PAYLOAD_SDK` and `ZIG` to override their local paths. The Windows build uses Zig's Clang/LLD and only PS5 SDK headers, runtime objects, libraries and linker script. The compiler target selects ELF linking; no Linux libc is linked. No WSL installation is needed.

The SDK's runtime and linker artifacts are GPL-3.0-or-later, Copyright John Törnblom and other contributors; FreeBSD headers carry their own BSD notices. Obtain the matching SDK source from [its v0.43 source tree](https://github.com/ps5-payload-dev/sdk/tree/v0.43). The companion sources are GPL-3.0-or-later under the project's LICENSE. Public redistributions must include the corresponding source for linked SDK components and their notices.

## Optional memory diagnostic

`node receiver-ps5/build.mjs --diagnostic` builds `diagnostic.c` separately. It creates a private scratch buffer containing integers, floating-point values, a pointer and a string. A token-authenticated callback reports only this payload's PID and scratch range. It exits on connection close or a 90-second receive timeout. It is never loaded automatically and is not required for normal use. The hardware audit used only this buffer for write tests, restored the original bytes and MCP setting, then exited the payload.

`--services-diagnostic` builds a separate read-only ABI probe, excluded from the production protocol. It reports service pointers and diagnostic status from its own process; use PS5Debug for code reads because Sony library pages may be execute-only. Its binary and manifest have separate names.

Rest mode is hardware/user-confirmed on PS5 13.60. Restart passed with user confirmation and disconnected services; shutdown was tested successfully by the user. Full uninstall was tested only on the newly installed browser, which was then reinstalled. Patch removal was tested only on the newly installed PS4 Minecraft update, which was restored. Existing retail titles were preserved.

Revision 104 extends storage replies with filesystem/device metadata and probes `/mnt/ext0` through `/mnt/ext7`, `/mnt/usb0` through `/mnt/usb7`, `/user` and `/user2`. The host excludes placeholders/duplicate devices and handles direct or nested game directories. Internal storage was checked live on 13.60; no additional drive was attached for external/M.2 hardware testing.

Revision 105 adds PS5 13.60 staged save mounting and confirmed single-container replacement. `saves.h` mounts only `/data/psn-saves/<uuid>/image`, temporarily adjusts this companion's own credentials, restores them, and never mounts installed saves for editing. The host retains encrypted originals, verifies plaintext before and after re-encryption, uploads a separately verified recovery copy, and requests one atomic rename after identity/game-closed checks. The PFS ABI reference is [n0llptr/Playstation-5-Save-Mounter](https://github.com/n0llptr/Playstation-5-Save-Mounter), GPL-3.0. See [save workflow and validation](../docs/PS5-SAVES.md) and [notices](../THIRD-PARTY-NOTICES.md). FsInternalForVsh is linked for the mount APIs.
