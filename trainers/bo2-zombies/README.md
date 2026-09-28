# BO2 Zombies trainer

Launch **BO2 Zombies Trainer.cmd** in the PS Neighbourhood source folder. Keep the connected PS Neighbourhood desktop open with **MCP bridge → Allow MCP compare-and-write** enabled. Every console operation goes through the public stdio MCP tools.

## Controls and validation

- **Points:** confirmed on the live HUD, including 10,000 points.
- **Infinite clip:** configurable 1–250 rounds, repeatedly refills the equipped inventory slot. The original 6→8 magazine write was confirmed in game; the loop also passed a live MCP test (30 → 28 → 30 rounds) and automated cancellation tests. Stops on weapon switch, missing/dead player, connection/build change, match-clock reset, disabled MCP writes, a running scan/dump, or a non-transient error. Shooting between a refill and its read-back is retried rather than stopping the freeze. Re-enable after switching weapons. No reserve-ammo control is shown.
- **God mode:** native player invulnerability bit. Confirmed by the user against zombies.
- **Movement speed:** 190–760; 190 is normal, 380 is 2×. 2× confirmed in game. This is the server movement setting.
- **FOV slider:** 65–120 degrees, reset to 65. FOV 90 confirmed in game.
- **Perk effects:** seven native perk bit toggles with both player-state and persistent bitfields updated. These reproduce the native `setperk` bit changes, not the Zombies purchase scripts: no perk icons, purchase audio, script counters, or promised scripted health/revive behavior. Gameplay validation is still pending.
- **Armory (experimental):** reads the loaded map's weapon registry, excluding placeholder assets, dual-wield/attachment variants, and non-primary items. Replaces the supported primary weapon currently held, in that same inventory slot. This also applies when only one primary is owned. Holstered weapons and their ammo are preserved; primary weapon count never increases. The selected weapon reference is updated after the replacement is published. The old implementation exceeded the normal two-gun limit and triggered the game’s laugh/weapon-removal/1911 sequence. The corrected Ray Gun insertion passed a live retention check; sustained gameplay confirmation is pending.
- **Pack-a-Punch version (experimental):** replaces the equipped weapon with its supported upgraded version in the same slot, preserving the holstered weapon. Ray Gun → upgraded Ray Gun was confirmed live in the held slot with 40 rounds; the user confirmed it equipped and fired normally. Holstered-weapon preservation is covered by automated tests and still awaits a two-gun live test. It does not invoke the Pack-a-Punch machine or its scripts. This does not yet support Mustang & Sally or other dual-wield variants.

Launch performs reads only. Clip freeze runs only while this trainer process is open, and closing the window drains pending writes and stops the loop. One-time changes remain in the current match until changed or reset by the game. Changes are not automatically re-enabled after a new match.

## Build and addresses

The profile is for `codzm.elf`, `CUSA57548`, content `UP0002-CUSA57548_00-CODBO2GAME000001`. The trainer dynamically finds the PID and executable base and checks a SHA-256 fingerprint of its first 4 KiB. Each action checks readable/writable mappings, live player pointer/health, MCP permission, expected bytes, and read-back verification.

This executable's player-entity client pointer is at module + `0x19C4B98`. Points resolve through that pointer + `0x55C8`. Inventory starts at player + `0x248`, with 15 records of 28 bytes; clips start at + `0x428`. The equipped weapon ID at + `0x1B8` selects the slot. Invulnerability is bit 0 at + `0x18`; unrelated bits are preserved. Perk masks are at + `0x548` and mirrored at + `0x5594`.

Movement/FOV resolve dvar pointers and verify their name pointer and type before writing the current value. Weapon IDs are resolved live because the registry is rebuilt per map. No downloaded offsets or executable patches are used.

The profile records the validated executable fingerprint and offsets. Raw research captures and game binaries are not distributed. The portable release includes a trainer launcher; source users can also run `npm run trainer`.

## Verification

`npm test` runs protocol, workbench, MCP, trainer cancellation/guard, and inventory transaction tests. `tests/trainer-ui-smoke.cjs` runs a read-only Electron UI test against the open workspace.

## Weapon-limit fix reference

The [T6 Zombies weapon-limit monitor](https://github.com/plutoniummod/t6-scripts/blob/main/ZM/Core/maps/mp/zombies/_zm.gsc) checks primary weapon count every three seconds and runs the laugh/removal/start-weapon sequence when that limit is exceeded. The revised spawner replaces the held slot without adding weapons, validates inventory/held-weapon stability before each write, and checks retention after 3.5 seconds. Related native primary classification was checked at `0x624220` in this executable.
