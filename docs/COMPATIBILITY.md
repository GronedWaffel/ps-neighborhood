# Compatibility and validation

## What is tested

PS4 **10.01 only** has PS4 real-hardware validation. Other PS4 firmware targets are unverified. PS5 **13.60** has the limited live checks listed below. A successful mock or simulator test is not a hardware compatibility result.

Confirmed live workflows on 10.01 include classic PS4Debug process enumeration, bounded memory reads, scan/refinement, selected BO2 trainer writes, native inventory/capacity queries, encrypted save backup and game launch. A complete background PKG transfer finished with no BGFT error and installation was confirmed on the console.

## Experimental PS4 targets

The receiver's allowlist is 9.00, 9.03, 9.04, 9.50, 9.51, 9.60, 10.00, 10.01, 10.50, 10.70, 10.71, 11.00 and 13.52. These are implementation targets, not a promise that a compatible public jailbreak or payload exists for each target.

The receiver detects firmware using `kern.sdk_version`; the editable desktop profile is separate. Initialization checks its allowlist before entering the credential helpers. Unsupported firmware fails at stage 40. The receiver needs an existing compatible GoldHEN syscall-11 environment. An open BinLoader port alone is insufficient.

Classic PS4Debug and PS4Debug-NG are protocol integrations, not universal firmware adapters. NG scanning has fixture-based tests but no real-console validation here. Do not load PS4Debug twice; reuse the running service and investigate connection errors before considering any payload reload.

## Remaining validation

- Uninstalling games/patches and power transitions have native dispatch regression tests, but have not been exercised on hardware.
- External-storage behavior needs hardware validation.
- Save backup does not include restore, decryption or account conversion.
- The Ghidra importer passed import, persistence, analysis and byte/permission verification in Ghidra 12.1.3 using a real PS5 RAM capture and a synthetic multi-region fixture.
- RAM captures are sequential and can contain data from different moments.
- Pointer search results are candidates, not guaranteed stable chains.
- The BO2 trainer is fingerprint-specific. See its guide for control-by-control evidence and limitations.
- The optional RPI route has separate compatibility constraints from the tested background receiver.

## PS5 13.60 integration

v0.9.0 implements a PS5 profile, validated ELF64 loading, FTP, a PS5Debug-NG memory client and experimental read-only CUSA/PPSA library inventory. PS5Debug-NG 1.3.2 lists 13.60 upstream; that is separate from our own validation. The client confirms platform ID 5 and reads firmware/branding before process enumeration. Native integer scanning is enabled for the hardware-validated PS5Debug-NG 1.3.2 identity; other versions retain host scanning.

Automated TCP, MCP and UI fixtures cover the new paths. On 2026-09-29, live PS5 13.60 checks with PS5Debug-NG 1.3.2 covered memory reads, scans, refinement, controlled writes to a temporary diagnostic buffer, pointers, RAM captures, offline analysis, MCP, FTP, inventory, internal partition capacity and one encrypted save archive. No game memory was written. BO2 close/relaunch and native integer scanning also passed. Rest mode passed. Uninstall and patch removal/reinstall passed on newly installed test content. Restart passed with user confirmation; shutdown was tested successfully by the user. PS4 Minecraft and the PS5 browser package installed over HTTP with native completion and user confirmation after the metadata/status ABI fix. The Minecraft update and 73 DLC installs, named add-on inventory and base/update native pause/resume passed. Minecraft launched and closed. An earlier automated browser launch returned 0x80020060; the user subsequently confirmed the installed browser works. The 13.60 installer ABI is required; the existing PS4-specific BO2 trainer is not enabled. PS5 decrypted export and edited-copy preparation passed; installed restore was tested with unchanged original bytes (see [save workflow](PS5-SAVES.md)); Ghidra 12.1.3 import, persistence and analysis passed verification. See the [full option audit](PS5-VALIDATION.md) and [setup guide](PS5.md).

## Reporting a result

**Help us confirm other versions.** Use the [compatibility report template](https://github.com/GronedWaffel/ps-neighborhood/issues/new?template=firmware_report.md) for other PS4 firmware, GoldHEN/PS4Debug releases, Windows versions, MCP clients or Ghidra releases. Successful, failed and partial results are all useful. You do not need to submit code.

Report the app version or commit, exact environment, feature, reproducible steps and whether hardware, simulation or offline testing was used. Never infer that all controls work from one successful connection. Keep private console data and memory captures out of public issues.

## Community confirmations

No additional firmware or software versions have been confirmed through reviewed community reports yet. Project hardware checks cover PS4 10.01 and the limited PS5 13.60 workflows listed above.

After review, contributors can open a PR adding a result here. Each entry should identify:

- The firmware/software versions and app release or commit tested.
- The specific features that passed, failed, worked partially or were not tested.
- Hardware versus simulation/offline testing, repeatability and any relevant limitations.
- A link to the public test report and reviewing PR so others can reproduce the result.

Label these entries **community-reported** unless independently reproduced by the project. Document confirmation for that particular feature and environment without implying support for every operation or nearby version. Keep failures visible alongside successes.

Rest mode is hardware/user-confirmed on PS5 13.60. Restart passed with user confirmation and disconnected services; shutdown was tested successfully by the user. Full uninstall was tested only on the newly installed browser, which was then reinstalled. Patch removal was tested only on the newly installed PS4 Minecraft update, which was restored. Existing retail titles were preserved.
