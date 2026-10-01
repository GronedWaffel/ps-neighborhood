import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function joaat(value) {
  let hash = 0;
  for (const byte of Buffer.from(value.toLowerCase())) { hash = (hash + byte) >>> 0; hash = (hash + (hash << 10)) >>> 0; hash ^= hash >>> 6; }
  hash = (hash + (hash << 3)) >>> 0; hash ^= hash >>> 11; return (hash + (hash << 15)) >>> 0;
}
const f = float => ({ float });
const vehicles = ['adder', 'zentorno', 't20', 'turismor', 'osiris', 'kuruma', 'sultan', 'buffalo', 'dominator', 'dukes', 'sandking', 'bifta', 'bati', 'akuma', 'buzzard', 'lazer', 'hydra', 'rhino', 'dinghy'];
const models = ['player_zero', 'player_one', 'player_two', 'a_m_y_business_01', 's_m_y_blackops_01', 's_m_y_cop_01', 'u_m_y_imporage', 'a_c_chop'];
const weapons = ['knife', 'nightstick', 'hammer', 'bat', 'crowbar', 'golfclub', 'bottle', 'dagger', 'hatchet', 'machete', 'switchblade', 'pistol', 'combatpistol', 'appistol', 'pistol50', 'snspistol', 'heavypistol', 'vintagepistol', 'revolver', 'microsmg', 'smg', 'assaultsmg', 'combatpdw', 'machinepistol', 'assaultrifle', 'carbinerifle', 'advancedrifle', 'specialcarbine', 'bullpuprifle', 'compactrifle', 'mg', 'combatmg', 'gusenberg', 'pumpshotgun', 'sawnoffshotgun', 'assaultshotgun', 'bullpupshotgun', 'heavyshotgun', 'dbshotgun', 'sniperrifle', 'heavysniper', 'marksmanrifle', 'rpg', 'grenadelauncher', 'minigun', 'hominglauncher', 'railgun', 'grenade', 'stickybomb', 'smokegrenade', 'molotov', 'proximine', 'fireextinguisher', 'petrolcan', 'parachute'];
export const gtaCatalog = { vehicles, models, weather: ['EXTRASUNNY', 'CLEAR', 'CLOUDS', 'OVERCAST', 'RAIN', 'THUNDER', 'FOGGY', 'SMOG', 'CLEARING', 'SNOW', 'BLIZZARD', 'XMAS'] };

export class GTAStoryActions {
  constructor(trainer, bridge) { this.trainer = trainer; this.bridge = bridge; this.tail = Promise.resolve(); }
  n(name, args) { return this.bridge.invoke(name, args); }
  async ped() { const id = (await this.n('PLAYER_PED_ID')).integer; if (!id) throw Error('Your character is not ready'); return id; }
  async vehicle() { const id = (await this.n('GET_VEHICLE_PED_IS_IN', [await this.ped(), false])).integer; if (!id) throw Error('Enter a vehicle first'); return id; }
  async requestModel(name, vehicle = false) {
    if (typeof name !== 'string' || !/^[a-z0-9_]{1,48}$/i.test(name)) throw Error('Enter a valid model name');
    const hash = joaat(name);
    if (!(await this.n('IS_MODEL_IN_CDIMAGE', [hash])).integer || !(await this.n('IS_MODEL_VALID', [hash])).integer) throw Error('This model is unavailable in your game build');
    if (vehicle && !(await this.n('IS_MODEL_A_VEHICLE', [hash])).integer) throw Error('This is not a vehicle model');
    if (vehicle === false && !(await this.n('IS_MODEL_A_PED', [hash])).integer) throw Error('This is not a character model');
    await this.n('REQUEST_MODEL', [hash]);
    const deadline = Date.now() + 15000;
    while (!(await this.n('HAS_MODEL_LOADED', [hash])).integer) {
      if (Date.now() > deadline) throw Error('Model streaming timed out');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return hash;
  }
  apply(action, input = {}) {
    const run = this.tail.then(() => this.applyNow(action, input)); this.tail = run.catch(() => {}); return run;
  }
  async close() {
    await this.tail;
    if (this.waterPlatform) await this.apply('water', { value: false });
    await this.bridge.close();
  }
  async applyNow(action, input) {
    if (action === 'inGameMenu') return this.bridge.installMenu();
    if (this.bridge.session?.resident) throw Error('Use the in-game controller menu while it is installed (L1 + D-pad Right).');
    if (action === 'neverWanted') return this.bridge.setFrameFlag(64, input.value);
    if (['god', 'clip', 'ammo', 'run'].includes(action)) return this.trainer.apply(action, input.value);
    if (['jump', 'explosive', 'horn', 'sticky'].includes(action)) return this.bridge.setFrameFlag({ jump: 1, explosive: 2, horn: 4, sticky: 8 }[action], input.value);
    if (action === 'phone') {
      await this.bridge.setFrameFlag(16, input.value);
      if (input.value) await this.n('DESTROY_MOBILE_PHONE');
      return { enabled: input.value };
    }
    if (action === 'seatbelt') {
      if (typeof input.value !== 'boolean') throw Error('Invalid seatbelt value');
      const ped = await this.ped();
      await this.n('SET_PED_CONFIG_FLAG', [ped, 32, !input.value]);
      await this.n('SET_PED_CAN_BE_KNOCKED_OFF_VEHICLE', [ped, input.value ? 1 : 0]);
    } else if (action === 'spawn') {
      const hash = await this.requestModel(input.model, true);
      try {
        const ped = await this.ped(), point = (await this.n('GET_OFFSET_FROM_ENTITY_IN_WORLD_COORDS', [ped, f(0), f(6), f(1)])).vector;
        const heading = (await this.n('GET_ENTITY_HEADING', [ped])).float;
        const vehicle = (await this.n('CREATE_VEHICLE', [hash, ...point.map(f), f(heading), false, false, false])).integer;
        if (!vehicle || !(await this.n('DOES_ENTITY_EXIST', [vehicle])).integer) throw Error('GTA did not create the vehicle');
        await this.n('SET_VEHICLE_ON_GROUND_PROPERLY', [vehicle, f(5)]);
        if (input.enter === true) await this.n('SET_PED_INTO_VEHICLE', [ped, vehicle, -1]);
        return { vehicle, model: input.model };
      } finally { await this.n('SET_MODEL_AS_NO_LONGER_NEEDED', [hash]); }
    } else if (action === 'vehicleGod') {
      if (typeof input.value !== 'boolean') throw Error('Invalid invulnerability value');
      const vehicle = await this.vehicle();
      await this.n('SET_ENTITY_INVINCIBLE', [vehicle, input.value]);
      await this.n('SET_VEHICLE_TYRES_CAN_BURST', [vehicle, !input.value]);
      await this.n('SET_VEHICLE_CAN_BREAK', [vehicle, !input.value]);
      if (input.value) { await this.n('SET_VEHICLE_FIXED', [vehicle]); await this.n('SET_VEHICLE_DEFORMATION_FIXED', [vehicle]); }
    } else if (action === 'upgrades') {
      const vehicle = await this.vehicle(), model = (await this.n('GET_ENTITY_MODEL', [vehicle])).unsigned;
      const stillCurrent = async () => {
        if (await this.vehicle() !== vehicle || (await this.n('GET_ENTITY_MODEL', [vehicle])).unsigned !== model) throw Error('Vehicle changed; remaining upgrades cancelled');
      };
      if ((await this.n('GET_NUM_MOD_KITS', [vehicle])).integer <= 0) throw Error('This vehicle has no upgrade kit');
      if ((await this.n('GET_VEHICLE_MOD_KIT', [vehicle])).integer !== 0) {
        await stillCurrent(); await this.n('SET_VEHICLE_MOD_KIT', [vehicle, 0]);
      }
      let changed = 0;
      // Performance slots only. A blanket 0..49 loop also replaces vehicle-
      // specific body, wheel and livery parts while they may still be streaming.
      for (const slot of [11, 12, 13, 15, 16]) {
        await stillCurrent();
        const count = (await this.n('GET_NUM_VEHICLE_MODS', [vehicle, slot])).integer;
        if (!Number.isInteger(count) || count <= 0 || count > 100) continue;
        const desired = count - 1;
        if ((await this.n('GET_VEHICLE_MOD', [vehicle, slot])).integer === desired) continue;
        await stillCurrent(); await this.n('SET_VEHICLE_MOD', [vehicle, slot, desired, false]);
        if ((await this.n('GET_VEHICLE_MOD', [vehicle, slot])).integer !== desired) throw Error('An upgrade did not verify; remaining upgrades cancelled');
        changed++;
      }
      await stillCurrent();
      if (!(await this.n('IS_TOGGLE_MOD_ON', [vehicle, 18])).integer) {
        await this.n('TOGGLE_VEHICLE_MOD', [vehicle, 18, true]);
        if (!(await this.n('IS_TOGGLE_MOD_ON', [vehicle, 18])).integer) throw Error('Turbo did not verify');
        changed++;
      }
      return { changed, message: changed ? `${changed} performance upgrades applied and verified.` : 'This car already has maximum performance upgrades; nothing was changed.' };
    } else if (action === 'weapons') {
      const ped = await this.ped(); let given = 0;
      for (const name of weapons) {
        const hash = joaat('weapon_' + name);
        if (!(await this.n('IS_WEAPON_VALID', [hash])).integer) continue;
        await this.n('GIVE_WEAPON_TO_PED', [ped, hash, 9999, false, false]); given++;
      }
      return { given };
    } else if (action === 'model') {
      if (input.confirm !== true) throw Error('Confirm changing character; story missions expect the original protagonist');
      const hash = await this.requestModel(input.model);
      try { await this.n('SET_PLAYER_MODEL', [0, hash]); await this.n('SET_PED_DEFAULT_COMPONENT_VARIATION', [await this.ped()]); }
      finally { await this.n('SET_MODEL_AS_NO_LONGER_NEEDED', [hash]); }
    } else if (action === 'outfit') {
      const component = input.component, drawable = input.drawable, texture = input.texture ?? 0;
      if (![component, drawable, texture].every(Number.isInteger) || component < 0 || component > 11 || drawable < 0 || texture < 0) throw Error('Invalid clothing selection');
      const ped = await this.ped(), count = (await this.n('GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS', [ped, component])).integer;
      if (drawable >= count) throw Error(`This clothing slot has ${count} choices`);
      const textures = (await this.n('GET_NUMBER_OF_PED_TEXTURE_VARIATIONS', [ped, component, drawable])).integer;
      if (texture >= textures) throw Error(`This item has ${textures} textures`);
      await this.n('SET_PED_COMPONENT_VARIATION', [ped, component, drawable, texture, 0]);
    } else if (action === 'radio') {
      if (typeof input.value !== 'boolean') throw Error('Invalid radio value');
      await this.n('SET_MOBILE_RADIO_ENABLED_DURING_GAMEPLAY', [input.value]);
    } else if (action === 'weather') {
      if (!gtaCatalog.weather.includes(input.value)) throw Error('Choose a weather preset');
      await this.n('SET_WEATHER_TYPE_NOW_PERSIST', [input.value]);
    } else if (action === 'time') {
      if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23 || !Number.isInteger(input.minute) || input.minute < 0 || input.minute > 59) throw Error('Invalid time');
      await this.n('SET_CLOCK_TIME', [input.hour, input.minute, 0]);
    } else if (action === 'water') {
      if (typeof input.value !== 'boolean') throw Error('Invalid water driving value');
      await this.bridge.setFrameFlag(32, false);
      if (this.waterPlatform) {
        await this.bridge.setWaterPlatform(0, 0);
        await this.n('DELETE_OBJECT', [{ out: 'i32', value: this.waterPlatform }]);
        this.waterPlatform = 0;
      }
      if (input.value) {
        const hash = await this.requestModel('prop_container_ld2', null);
        try {
          const dims = await this.n('GET_MODEL_DIMENSIONS', [hash, { out: 'vec3' }, { out: 'vec3' }]);
          const top = dims.outputs[1][2];
          const object = (await this.n('CREATE_OBJECT_NO_OFFSET', [hash, f(0), f(0), f(-200), false, false, false])).integer;
          if (!object || !Number.isFinite(top)) throw Error('Water platform creation failed');
          this.waterPlatform = object;
          await this.n('SET_ENTITY_VISIBLE', [object, false, false]);
          await this.n('FREEZE_ENTITY_POSITION', [object, true]);
          await this.bridge.setWaterPlatform(object, top);
          await this.bridge.setFrameFlag(32, true);
        } finally { await this.n('SET_MODEL_AS_NO_LONGER_NEEDED', [hash]); }
      }
    } else if (action === 'drop') {
      if (input.confirm !== true) throw Error('Confirm dropping cash; collecting it changes your saved balance');
      const hash = await this.requestModel('prop_money_bag_01', null);
      try {
        const position = (await this.n('GET_OFFSET_FROM_ENTITY_IN_WORLD_COORDS', [await this.ped(), f(0), f(2), f(0.5)])).vector;
        const object = (await this.n('CREATE_AMBIENT_PICKUP', [joaat('PICKUP_MONEY_CASE'), ...position.map(f), 0, 10000, hash, false, true])).integer;
        if (!object) throw Error('GTA did not create the cash pickup');
        return { object, amount: 10000 };
      } finally { await this.n('SET_MODEL_AS_NO_LONGER_NEEDED', [hash]); }
    } else if (action === 'achievements') {
      if (input.confirm !== true) throw Error('Confirm trophy unlock requests; trophies cannot be undone here');
      const accepted = [], rejected = [];
      for (let id = 1; id <= 77; id++) ((await this.n('GIVE_ACHIEVEMENT_TO_PLAYER', [id])).integer ? accepted : rejected).push(id);
      return { accepted, rejected, message: `GTA accepted ${accepted.length} of 77 trophy requests. Check the console trophy list for actual unlocks.` };
    } else if (action === 'waypoint') {
      const blip = (await this.n('GET_FIRST_BLIP_INFO_ID', [8])).integer;
      if (!blip || !(await this.n('DOES_BLIP_EXIST', [blip])).integer) throw Error('Set a waypoint on the map first');
      const [x, y] = (await this.n('GET_BLIP_INFO_ID_COORD', [blip])).vector;
      let ground;
      await this.n('SET_FOCUS_POS_AND_VEL', [f(x), f(y), f(100), f(0), f(0), f(0)]);
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          await this.n('REQUEST_COLLISION_AT_COORD', [f(x), f(y), f(100)]);
          const r = await this.n('GET_GROUND_Z_FOR_3D_COORD', [f(x), f(y), f(1000), { out: 'f32' }, true, false]);
          if (r.integer) { ground = r.outputs[0]; break; }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!Number.isFinite(ground)) throw Error('Destination ground has not streamed in; teleport cancelled');
        const ped = await this.ped(), vehicle = (await this.n('GET_VEHICLE_PED_IS_IN', [ped, false])).integer;
        await this.n('SET_ENTITY_COORDS_NO_OFFSET', [vehicle || ped, f(x), f(y), f(ground + 1), false, false, false]);
      } finally { await this.n('CLEAR_FOCUS'); }
    } else if (action === 'prologue') {
      if (input.confirm !== true) throw Error('Confirm finishing Prologue and advancing story progression');
      if (!this.trainer.profile?.prologue) throw Error('Prologue recovery is not verified for this executable');
      await this.bridge.ensure();
      const t = await this.trainer.target(), program = await this.bridge.locateProgram(4024280498);
      const profile = this.trainer.profile, mission = profile.prologue;
      const length = program.header.readUInt32LE(0x1c);
      if (length !== mission.length) throw Error('Unexpected Prologue1 script version');
      const pointers = await this.bridge.read(program.header.readBigUInt64LE(0x10), Math.ceil(length / 16384) * 8), hash = createHash('sha256');
      for (let offset = 0; offset < length; offset += 16384) hash.update(await this.bridge.read(pointers.readBigUInt64LE(offset / 16384 * 8), Math.min(16384, length - offset)));
      if (hash.digest('hex') !== mission.sha256) throw Error('Prologue bytecode differs; skip refused');
      const registry = await this.bridge.read(BigInt(profile.threadTable), 10), count = registry.readUInt16LE(8);
      if (!count || count > 1024) throw Error('Invalid script-thread collection');
      const threads = await this.bridge.read(registry.readBigUInt64LE(), count * 8); let found;
      for (let i = 0; i < count; i++) {
        const at = threads.readBigUInt64LE(i * 8); if (!at) continue;
        const raw = await this.bridge.read(at, profile.threadNameOffset + 64);
        if (raw.readUInt32LE(profile.threadHashOffset) === 4024280498 && raw.readUInt32LE(8) && raw.readUInt32LE(profile.threadStateOffset) !== 2 && raw.subarray(profile.threadNameOffset).toString().split('\0')[0].toLowerCase() === 'prologue1') {
          if (found) throw Error('Multiple Prologue threads');
          found = { at, id: raw.readUInt32LE(8), stack: raw.readBigUInt64LE(profile.threadStackOffset) };
        }
      }
      if (!found) throw Error('Prologue is not running');
      const locals = await this.bridge.read(found.stack, (mission.stageLocal + 1) * 8), before = locals.subarray(mission.stageLocal * 8, mission.stageLocal * 8 + 4), stage = before.readUInt32LE();
      if (locals.readUInt32LE(2 * 8) !== 1 || locals.readUInt32LE(3 * 8) !== 134 || stage < 1 || stage > 15) throw Error('Prologue state is not eligible for completion');
      await mkdir(this.bridge.recoveryDirectory, { recursive: true });
      await writeFile(path.join(this.bridge.recoveryDirectory, `prologue-before-${Date.now()}.bin`), locals);
      const fresh = await this.bridge.read(found.at, profile.threadStackOffset + 8);
      if (fresh.readUInt32LE(8) !== found.id || fresh.readBigUInt64LE(profile.threadStackOffset) !== found.stack) throw Error('Mission restarted; skip cancelled');
      // Exact bytecode's state 16 invokes the normal mission completion/cleanup
      // function. Do not terminate the script or forge mission-completion stats.
      const after = Buffer.alloc(4); after.writeUInt32LE(mission.completeStage);
      await this.bridge.write(found.stack + BigInt(mission.stageLocal * 8), before, after);
      return { requested: true, previousStage: stage, message: 'Normal Prologue completion requested; wait for the game to finish its transition.' };
    } else if (action === 'money' || action === 'skills') {
      if (input.confirm !== true) throw Error('Confirm this save-affecting change');
      const model = (await this.n('GET_ENTITY_MODEL', [await this.ped()])).unsigned;
      const character = ['player_zero', 'player_one', 'player_two'].map(joaat).indexOf(model);
      if (character < 0) throw Error('Switch to Michael, Franklin or Trevor first');
      if (action === 'money') {
        const hash = joaat(`SP${character}_TOTAL_CASH`), current = await this.n('STAT_GET_INT', [hash, { out: 'i32' }, -1]);
        if (!current.integer || current.outputs[0] < 0) throw Error('Cannot read the active character balance');
        const value = Math.min(2147483647, current.outputs[0] + 10000000);
        if (!(await this.n('STAT_SET_INT', [hash, value, true])).integer) throw Error('GTA refused the balance update');
        return { balance: value };
      }
      for (const stat of ['STAMINA', 'SHOOTING_ABILITY', 'STRENGTH', 'STEALTH_ABILITY', 'FLYING_ABILITY', 'WHEELIE_ABILITY', 'LUNG_CAPACITY']) {
        if (!(await this.n('STAT_SET_INT', [joaat(`SP${character}_${stat}`), 100, true])).integer) throw Error(`GTA refused ${stat}`);
      }
    } else throw Error('This feature is still being implemented for this build');
    return { completed: true };
  }
}
