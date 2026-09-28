---
name: Firmware and software compatibility report
about: Help confirm another firmware, payload, Windows, MCP client or Ghidra version
labels: firmware-testing
---

Successes, failures and partial results are welcome. No code contribution is required. Use N/A for fields unrelated to your test.

**App release or commit:**
**Console family/model:**
**Exact console firmware:**
**Jailbreak / GoldHEN version:**
**PS4Debug or NG build/version (and source link, if available):**
**FTP / BinLoader / RPI version, if relevant:**
**Windows version and architecture:**
**MCP client and version, if relevant:**
**Ghidra version, if relevant:**
**Node.js / Zig version, if building from source:**
**Real hardware, memory lab, or offline-only test:**

### Features and outcomes

List each feature separately as passed, failed, partial or not tested. A successful connection alone does not confirm scanning, writes, installation or other controls.

### Steps to reproduce

### Expected and actual results

### Repeatability

How many attempts? Did the result persist after an ordinary reconnect or application restart, if tested?

### Limitations or errors

Attach only redacted logs or screenshots. Do not upload credentials, saves, game packages or raw RAM.

Only PS4 10.01 has project hardware validation. Start with read-only checks; leave unsupported-firmware guards in place and do not reload an already running PS4Debug payload. PS5 support is not implemented in this release.
