# Compatibility and validation

## What is tested

PS4 **10.01 only** has real-hardware validation. Firmware above 10.01 has not been tested. Lower firmware targets are also unverified. A successful mock or simulator test is not a hardware compatibility result.

Confirmed live workflows on 10.01 include classic PS4Debug process enumeration, bounded memory reads, scan/refinement, selected BO2 trainer writes, native inventory/capacity queries, encrypted save backup and game launch. A complete background PKG transfer finished with no BGFT error and installation was confirmed on the console.

## Experimental PS4 targets

The receiver's allowlist is 9.00, 9.03, 9.04, 9.50, 9.51, 9.60, 10.00, 10.01, 10.50, 10.70, 10.71, 11.00 and 13.52. These are implementation targets, not a promise that a compatible public jailbreak or payload exists for each target.

The receiver detects firmware using `kern.sdk_version`; the editable desktop profile is separate. Initialization checks its allowlist before entering the credential helpers. Unsupported firmware fails at stage 40. The receiver needs an existing compatible GoldHEN syscall-11 environment. An open BinLoader port alone is insufficient.

Classic PS4Debug and PS4Debug-NG are protocol integrations, not universal firmware adapters. NG scanning has fixture-based tests but no real-console validation here. Do not load PS4Debug twice; reuse the running service and investigate connection errors before considering any payload reload.

## Remaining validation

- Uninstalling games/patches and power transitions have native dispatch regression tests, but have not been exercised on hardware.
- External-storage behavior needs hardware validation.
- Save backup does not include restore, decryption or account conversion.
- The Ghidra importer is generated against its documented Java API; execution in Ghidra remains unverified.
- RAM captures are sequential and can contain data from different moments.
- Pointer search results are candidates, not guaranteed stable chains.
- The BO2 trainer is fingerprint-specific. See its guide for control-by-control evidence and limitations.
- The optional RPI route has separate compatibility constraints from the tested background receiver.

## PS5 13.60 roadmap

PS5 support is **not implemented**. The intent is to add PS5 13.60 support when a compatible jailbreak and the necessary debugging/payload interfaces are available, followed by testing on real hardware. This will require a separate platform implementation. A PS4 firmware allowlist entry cannot enable PS5 support. No release date is promised.

## Reporting a result

Use the Firmware test report issue template. Report console family, firmware, jailbreak/payload versions, feature, exact result and whether hardware was used. Never infer that all controls work from one successful connection. Keep private console data and memory captures out of public issues.
