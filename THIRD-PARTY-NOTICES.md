# Third-party notices

PS Neighbourhood uses Electron (MIT and included Chromium third-party notices), the official Model Context Protocol TypeScript SDK (MIT), basic-ftp (MIT) and Zod (MIT). Their package license files remain in the distribution. Electron's LICENSE and LICENSES.chromium.html are included at the portable build root.

The PS4Debug client uses documented wire protocol facts from jogolden/ps4debug and GoldHEN/ps4debug, plus the supplied OpenSourcereR-dev/ps4debug-NG reference (GPL-3.0, https://github.com/OpenSourcereR-dev/ps4debug-NG). The new JavaScript NG transport implements its command layouts, framing and challenge-response algorithm for interoperability. No PS4Debug payload binaries or payload source files are redistributed. PS4, PlayStation and GoldHEN names identify interoperating products; this project is unaffiliated with their owners.

The generated Ghidra importer uses Ghidra public APIs. Ghidra is a separate installation and is not redistributed.

The console receiver's loader metadata definitions and packed-library symbol lookup are adapted from ps4-payload-dev/sdk, Copyright (C) 2025 John Törnblom, GPL-3.0-or-later (https://github.com/ps4-payload-dev/sdk). Original notices and corresponding adapted source accompany the receiver. Application and power API references include LightningMods/Itemzflow, LightningMods/PS4-daemon-writeup, OpenOrbis and Scene-Collective/ps4-payload-sdk; see receiver/README.md.

The background PKG receiver is distributed with its complete corresponding source and GPL-3.0-or-later license under `receiver/`. It includes credential and module-loader helpers from marcussacana/DirectPackageInstaller (commit ca7bade66737fede3b0e7bad73b665e0a4d4ff39), incorporating ps4-libjbc and flatz's loader. See receiver/README.md for attribution and local modifications. GoldHEN itself is not redistributed. The receiver requires an already enabled compatible GoldHEN environment.
