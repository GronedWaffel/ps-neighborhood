# Contributing to PS Neighbourhood

Use Node.js 24+ and Zig 0.14.1. Follow the README's source setup, then run `npm test`. UI changes should also pass `node node_modules/electron/cli.js tests/ui-smoke.cjs` using the simulated memory lab. Native receiver changes must pass the compiled dispatch test; packaging reruns it automatically.

Keep changes focused and describe what changed, why, how it was checked and any remaining hardware uncertainty. Do not describe an experimental firmware as supported based solely on a profile, open port or simulated test. Preserve compare-before-write checks, request bounds, host/origin checks, destructive-action confirmations and firmware initialization guards.

Do not commit `data`, `research`, `artifacts`, `dist`, compiler downloads, game files, raw RAM, account data or local MCP credentials. Use synthetic fixtures for tests. Redact private paths and identifiers from screenshots and logs.

Contributions are provided under GPL-3.0-or-later. Preserve attribution and the licenses of third-party code. Explain the provenance of any imported code.
