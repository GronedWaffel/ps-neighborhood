# Contributing to PS Neighbourhood

**Pull requests, testing and ideas are welcome.** You do not need to be an expert or write code to help. We welcome bug fixes, scanner and MCP improvements, trainer profiles, receiver compatibility work, UI changes and clearer documentation.

## Open a pull request

1. Fork the repository and create a branch for your change.
2. Keep the change focused. For a larger feature or platform change, open an issue first so the approach can be discussed.
3. Follow the source setup in the README and run the checks relevant to your change.
4. Open a PR against `main`. Explain the problem, resulting behavior and validation. Link any related issues and state what you could not test.

Draft PRs are welcome while work is in progress. Documentation-only changes do not require running the console or rebuilding the app. For new firmware support, preserve the guards and provide evidence for the platform-specific changes; adding a version to an allowlist alone does not establish support.

## Help verify firmware and software versions

Use the [compatibility report template](https://github.com/GronedWaffel/ps-neighbourhood/issues/new?template=firmware_report.md) to report successes, failures or partial results. Testing other PS4 firmware and PS4Debug/NG/GoldHEN versions is especially valuable. Reports for different Windows versions, MCP clients and Ghidra versions also help.

Include the app release or commit, exact relevant software versions, console model/firmware if applicable, feature tested, steps, expected behavior, actual behavior and whether the result is repeatable. Identify real hardware, simulation or offline-only testing explicitly. Mark each tested feature as passed, failed, partial or not tested. No coding contribution is required for a useful report.

Begin with read-only workflows such as process enumeration, bounded reads and inventory. Do not remove firmware guards or reload an already running PS4Debug payload to force a test. There is no need to try uninstall or power actions just to submit a compatibility report.

Reviewed reports can be added to `docs/COMPATIBILITY.md` through a PR, with links to their issue and exact environment. Keep community-reported results distinct from project hardware validation. Confirmation is limited to the features actually exercised; preserve known failures and remaining uncertainty. PS5 has an experimental memory/FTP/ELF integration; test it using the PS5 profile and a compatible PS5 debugger. PS5 native receiver features remain unimplemented; never test them with the PS4 receiver.

## Development checks

Use Node.js 24+ and Zig 0.14.1. Follow the README's source setup, then run `npm test`. UI changes should also pass `node node_modules/electron/cli.js tests/ui-smoke.cjs` using the simulated memory lab. Native receiver changes must pass the compiled dispatch test; packaging reruns it automatically.

Keep changes focused and describe what changed, why, how it was checked and any remaining hardware uncertainty. Do not describe an experimental firmware as supported based solely on a profile, open port or simulated test. Preserve compare-before-write checks, request bounds, host/origin checks, destructive-action confirmations and firmware initialization guards.

## Data and licensing

Do not commit `data`, `research`, `artifacts`, `dist`, compiler downloads, game files, raw RAM, account data or local MCP credentials. Use synthetic fixtures for tests. Redact private paths and identifiers from screenshots and logs.

Contributions are provided under GPL-3.0-or-later. Preserve attribution and the licenses of third-party code. Explain the provenance of any imported code.
