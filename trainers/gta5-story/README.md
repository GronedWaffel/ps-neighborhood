# GTA V

Supports native PS5 `PPSA04263` version `01.000.000` and `PPSA04264` version `01.010.002`. Development hardware: PS5 13.60, PS5Debug-NG 1.3.2. The installer selects a separate fingerprinted profile for each executable; it refuses unknown builds. This is a Story Mode trainer; the running network-session flag blocks writes in Online.

Open PS Neighborhood, connect to the console, enable **MCP bridge → Allow MCP compare-and-write**, then run **GTA V In-Game Menu.cmd**. Close any old PC trainer first so it can restore its temporary hook. Once installation completes, the menu runs inside GTA and the PC apps can be closed. Install again after restarting GTA. Loading the same resident build again reconnects to it instead of adding another hook.

Hold **L1** and tap **D-pad Right** to open or close it. **D-pad Up/Down** browses vertical lists, **Cross** applies/selects, and **Circle** goes back. Both sticks remain available for walking, steering and camera movement while the menu is open. Cross and the other menu buttons are reserved while browsing. The menu has Player, Weapons, Garage, Vehicle spawner, World, Character and Story & progression sections. Never Wanted continuously clears the wanted level while enabled; turning it off permits normal wanted-level behavior again.

Hold D-pad Up or Down to browse repeatedly. Vehicle, weapon, model, clothing, weather and time choices have scrollable lists with nine visible rows, a scrollbar and position counter. Back navigation restores the previous selection. Loading status stays visible and simple toggles remain available while a model streams.

**Vehicle spawner** opens categories with cars first (Supercars, Sports, Muscle, Classics and the other road classes), followed by bikes, utility vehicles, boats and aircraft. An 881-model reference catalogue is checked through GTA's model-registration natives once per installation, in small frame-budgeted batches. Only registered vehicle models and nonempty categories are shown. This checks known model hashes, not memory-scanning patterns. Trains and tow-only trailers are excluded from the normal spawn-and-enter operation.

**Character → Clothing & outfits → body slot → clothing item → color / texture** browses the current character's wardrobe. Categories place shirts, upper layers, trousers and footwear first, with Story-character labels instead of assuming multiplayer component names. `clothing-labels.h` maps 1,452 Story garment/color entries in 202 compact ranges to their actual GXT keys; drawable numbers are not assumed to equal label numbers. Labels resolve through the game when present; otherwise rows show the category and actual drawable/texture IDs. The footer shows style and color counts. Models have different wardrobes; slots with no items report that directly.

Highlighting a choice for 120 ms previews it on the actual character. The wardrobe camera shows the outfit, with a closer view for headwear/hair and footwear. **Square** toggles that camera; **Cross** keeps the choice; **Circle** or closing the menu restores uncommitted browsing changes. A kept item remains equipped while you browse its textures. Preview snapshots all 12 clothing components. Changing a Story shirt clears conflicting neckwear, armor, logos and upper overlays; Franklin's vest/shirt-cut combinations select their matching layers. Cross commits the changed layers together. Cancel restores each uncommitted layer only if the ped/model and that layer still match our preview, preserving later mission or external wardrobe changes. Other models retain their native component choices; this is not a complete compatibility catalogue for arbitrary replacement peds. The camera is not activated inside a vehicle, during a cutscene or over an existing scripted camera. Only the camera created by this menu is destroyed. This is a live in-game preview, not a set of downloaded thumbnail images.

Spawned vehicles receive the existing `MPBitset` bit-30 exemption before the player is seated. The matched Story Mode `shop_controller` checks that flag before its DLC cleanup can clear the player's tasks and delete the car. Other decorator bits are preserved, the flag is read back, and a failed protection attempt removes only the newly created car instead of seating the player in it. No global shop bypass, mission-script termination or Online session is used.

## Responsiveness

The resident menu calls resolved native-handler addresses and obtains current entity handles directly. Selecting a car does not start a memory scan. After a short browsing debounce, the vehicle list requests the selected model first and preloads its two immediate neighbours, retaining at most three prefetched models. The character list preloads only its selected model. Requests are released when leaving the list, except for a model still owned by an active spawn job. Already-prefetched choices bypass the debounce. `SELECTED MODEL READY` means the game reports the asset loaded. A ready vehicle can be created in the same update as the select input; a cold model still depends on GTA's streaming system.

For extracted game folders on case-sensitive PS5 storage, installed DLC directory names must match the game's resolved `dlclist.xml` exactly. The tested dump contained `mpLuxe2` and `mpHeist`, while GTA requested `mpluxe2` and `mpheist`; those packs were skipped despite their files being present. The diagnostic repair records exact directory renames and requires a game restart. Do not lowercase every game file or rename `mpG9EC`, whose requested spelling retains capitals. This is an installation issue separate from model-streaming latency.

After correcting 58 mismatched folder names and restarting this installation, registered packs increased from 13 to 71 and the bad-pack-order flag cleared. T20, Osiris, Kuruma and Hydra became registered vehicle models. A cold T20 preload was observed ready in 579 ms, including the browsing debounce and PC polling overhead; a T20 was then created and the player seated in it. This measurement is specific to this console and installation, not a guarantee of identical loading time for every model.

Cheap multi-step operations process up to eight items within a two-millisecond cooperative budget instead of deliberately waiting a frame after every item. Streaming, collision loading and trophy requests remain paced. The budget is checked between native calls; an individual game function can take longer. Local mailbox counters expose job elapsed time, last completed job duration and prefetch readiness for diagnosis. They do not upload telemetry.

The older PC control panel remains available through `GTA V Story Trainer.cmd`, with an **Install in-game menu** button. After installation, use the controller menu for changes so two interfaces do not compete. Source launchers accept the running application's data directory as their first argument; `PSN_DATA` also selects it.

## Implementation

Installation verifies exact executable fingerprints, process identity, mapped ranges and the Story Mode flag. Host memory writes use the application's MCP compare-and-write gate. Once installed, the resident menu executes native calls and player-field updates locally on the game's script thread. Bit updates preserve unrelated flags. Its drawing, input and actions are gated out when the network-session flag is active; it is not an Online menu.

The remaining controls use a mailbox executed by the game's `main_persistent` script. A verified, aligned cached `PLAYER_ID` handler slot forwards through the bridge to the original native. No extra debugger payload or remote worker thread is loaded. Command arguments are staged while idle and the ready flag is published last. Requests run serially; timed-out requests cannot be silently submitted again. Script-thread flags implement jump, explosive shots, horn boost, downward vehicle force and phone input blocking. Water driving uses a hidden collision surface that follows the vehicle at the water level.

Prologue recovery fingerprints the complete loaded `Prologue1` bytecode (SHA-256 in the PC panel, length and FNV-1a-64 in the resident menu), locates the active thread and local stack, then requests its existing state-16 completion/cleanup branch. It does not terminate the mission script or substitute another save. It may advance the story, autosave and award story trophies. The PC diagnostic locals snapshot is **not** a restorable save backup; the resident menu does not create a save backup.

Max vehicle upgrades apply engine, brake, transmission, suspension and armor upgrades plus turbo. Each result is read back; already-maxed parts are skipped. The active vehicle is rechecked before each modification. Cosmetic body, wheel and livery slots are not blindly replaced.

Money, skills, cash pickups, character changes, prologue completion and trophy requests require confirmation. The PC panel reports accepted trophy requests; the resident menu reports when requests have been sent. Neither guarantees that all platform trophies unlock. The game may reject unavailable IDs. Streaming and multi-step actions advance over frames without blocking the game thread.

## Waypoint teleport

Waypoint travel starts an owned destination scene before querying ground. It streams a 400 m sphere at successive 200/600/1000 m elevations, retries each elevation for up to five seconds without blocking frames, and queries land from above the map. It moves the original ped or occupied vehicle only after the scene and a valid ground height are available, then keeps streaming active for 350 ms to settle. Failed streaming, missing land, character/vehicle changes and transition out of Story Mode release the menu's scene/focus. It does not interrupt an already-active game scene loader or use an arbitrary high-altitude teleport fallback.

Live diagnosis verified the previous airport-to-hills waypoint (~3.6 km) returned ground at 288.36 m after destination scene loading. The previous fixed-height collision request did not load that destination reliably. The updated resident path is installed; use the waypoint option for the final in-game arrival check.

## Validation status

On PPSA04264 01.010.002, live native getter calls and resident frame execution passed, and the user confirmed gameplay controls, DLC vehicle spawning, clothing and waypoint travel work. The new Prologue bytecode was compared, its stage local moved from 1255 to 1253, and its exact fingerprint and changed thread layout are recorded in the profile. Prologue completion was not replayed against the progressed save. The tests below also cover the earlier PPSA04263 work.

- Live verified: exact-build player/model/coordinate/game-time reads, native mailbox execution and hook restoration.
- User confirmed: built-in infinite ammo and successful recovery from the stuck prologue.
- Unit checked: version/Online/write-gate/session rejection, preservation of unrelated ammo bits, numeric bounds, persistent-action confirmations, and repeat-safe performance upgrades.
- Resident C harness checked: controller edges and hold repeat, vertical list scrolling/wrap/back, preservation of movement and look controls, Never Wanted enable/disable, repeated performance upgrades, cancellation when the vehicle changes, confirmation, model-streaming timeout, three-model prefetch ownership/release, unavailable models, same-update ready-model spawning and budgeted upgrade batches.
- User confirmed the revised menu, expanded vehicle/clothing fixes and spawning work; reported waypoint loading failure prompted the subsequent scene-streaming correction.
- Live verified after the DLC path repair: T20 streaming and creation, player seating, and registration of the previously missing Osiris, Kuruma and Hydra models. The updated resident build is installed; the PC launcher's binary matches it.
- Live catalogue filtering exposes 729 registered vehicles across 22 categories in the tested installation (including 53 supercars, 93 sports cars and 75 muscle cars). This is a registration check, not an individual spawn test of every vehicle. A clothing-item change was read back successfully on the current character, then the original outfit was restored.
- C harness checks cover delayed destination streaming, higher-elevation retry, ped/vehicle arrival, missing land, scene ownership, failed starts and entity-change cleanup, plus multi-layer preview/commit/cancel, per-layer external changes, clothing label remapping and category order, DLC protection before seating, preservation of decorator bits, failed-protection cleanup, preview debounce, keep/cancel behavior, external outfit changes and camera cleanup. The live script's decorator checks were inspected, the integer decorator is registered, and the preview/protection build is installed; extended driving and preview appearance require in-game acceptance.
- The remaining controls are implemented but still need individual in-game acceptance checks. Do not describe the whole feature list as hardware verified.

Before resident installation, closing the PC trainer normally restores its temporary native slot and removes its PC-managed water platform. After resident installation, closing the installer or PC panel deliberately leaves the menu running. GTA process exit removes the resident allocation and hook. Local recovery/checkpoint files are kept in `data/gta5-story`; no remote telemetry is added.

## Source and credits

`bridge.c`, `menu.c` and `bridge.ld` are the freestanding resident source. `npm run build:gta` generates `native-handlers.h` from the matched address catalogue and reproduces `gta-bridge.bin` with Zig 0.14.1; set `ZIG` to its executable if it is not under `tools/zig-x86_64-windows-0.14.1`. The build rejects ELF relocations and nonzero initialized mailbox/menu data before producing the flat image. Pointer-valued native arguments are materialized at runtime to avoid absolute string pointers in constant argument arrays. The PC implementation is in `src/gta-story-*.mjs`, `src/gta-menu-installer.mjs` and `src/gta-native-bridge.mjs`. Native addresses were resolved against the user's own executable; game executables, save files and decompiled scripts are not shipped.

Research references:

- [ZeddMOCO's 1.70 crossmap](https://github.com/ZeddMOCO/GTA-V-Crossmap-1.70) and [TupoyeMenu/BigBaseV2-fix](https://github.com/TupoyeMenu/BigBaseV2-fix): hash translation references for the new executable. All 114 required handlers were matched to its actual native registrations.

- [2much4u's PS4 GTA V Native Caller](https://github.com/2much4u/PS4-GTA-V-Native-Caller): native context/vector ABI reference. Its PS4 offsets and kernel code are not used.
- [Maestro-1337's GTA V 1.58 crossmap](https://github.com/Maestro-1337/GTA-V-1.58-Crossmap): hash identification reference, matched against this PS5 executable.
- [alloc8or's native database](https://github.com/alloc8or/gta5-nativedb-data): native names, signatures and trophy-ID documentation.
- [Cfx.re controller reference](https://docs.fivem.net/docs/game-references/controls/): game control indices used by the resident menu.
- [DurtyFree's GTA V data dumps](https://github.com/DurtyFree/gta-v-data-dumps): model identifiers, display labels and vehicle classes. `vehicles.json` contains the compact reference facts used by `scripts/build-gta-vehicles.mjs`; runtime registration checks determine availability in this PS5 build.
- [OpenSourcereR-dev's PS5Debug-NG](https://github.com/OpenSourcereR-dev/ps5debug-NG): existing debugger and documented process-allocation protocol.
- [YimMenu's decompiled-script research](https://github.com/YimMenu/GTA-V-Decompiled-Scripts) and [drunderscore's mission research](https://github.com/drunderscore/GTA-Research): reference for understanding mission flow; live PS5 bytecode is separately fingerprinted.

PS Neighborhood's GPL-3.0-or-later license applies to the original trainer implementation. Referenced projects retain their own licenses and attribution.
