import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GTAStoryTrainer } from '../src/gta-story-trainer.mjs';
import { GTAStoryActions, joaat } from '../src/gta-story-actions.mjs';

function fixture() {
  const memory = Buffer.alloc(0x10000), writes = [];
  const status = { mode: 'live', profile: { platform: 'ps5' }, mcpWrites: true, connectionId: 'one' };
  const identity = { titleId: 'PPSA04263', contentId: 'test' };
  memory.writeBigUInt64LE(0x2000n, 0x1000); memory.writeBigUInt64LE(0x3000n, 0x2008);
  memory.writeFloatLE(200, 0x3250); memory.writeFloatLE(200, 0x3254);
  memory.writeBigUInt64LE(0x5000n, 0x4088); memory.writeBigUInt64LE(0x7000n, 0x4090);
  memory.writeFloatLE(1, 0x5cb0); memory[0x7071] = 8;
  const profile = { ...identity, playerRoot: '0x1000', networkFlag: '0x1008', fingerprints: [{ address: '0x100', length: 16, sha256: createHash('sha256').update(memory.subarray(0x100, 0x110)).digest('hex') }] };
  let statusCalls = 0, replaceOnSecond = false;
  const call = async (name, args) => {
    if (name === 'status') { if (++statusCalls === 2 && replaceOnSecond) status.connectionId = 'two'; return structuredClone(status); }
    if (name === 'processes') return [{ name: 'eboot.bin', pid: 178 }];
    if (name === 'process_info') return identity;
    if (name === 'maps') return [{ start: '0x0', end: '0x10000', prot: 7 }];
    if (name === 'memory_read') return { hex: memory.subarray(Number(BigInt(args.address)), Number(BigInt(args.address)) + args.length).toString('hex') };
    if (name === 'memory_write') {
      const at = Number(BigInt(args.address)), data = Buffer.from(args.hex, 'hex');
      assert.equal(memory.subarray(at, at + data.length).toString('hex'), args.expectedHex);
      data.copy(memory, at); writes.push(args); return { verified: true };
    }
    throw Error(name);
  };
  return { trainer: new GTAStoryTrainer(call, profile), memory, status, writes, identity, replace: () => { replaceOnSecond = true; } };
}
test('ammo controls preserve unrelated flags and each other', async () => {
  const f = fixture();
  await f.trainer.apply('clip', true); assert.equal(f.memory[0x7071], 10);
  await f.trainer.apply('ammo', true); assert.equal(f.memory[0x7071], 11);
  await f.trainer.apply('clip', false); assert.equal(f.memory[0x7071], 9);
});
test('refuse online mode, disabled write gate, wrong game, and mismatched code', async () => {
  for (const change of [f => { f.memory[0x1008] = 1; }, f => { f.status.mcpWrites = false; }, f => { f.identity.titleId = 'PPSA00000'; }, f => { f.memory[0x100] = 1; }]) {
    const f = fixture(); change(f); await assert.rejects(f.trainer.apply('god', true)); assert.equal(f.writes.length, 0);
  }
});
test('refuse a reconnected console between target resolution and write', async () => {
  const f = fixture(); f.replace(); await assert.rejects(f.trainer.apply('god', true), /session or character changed/); assert.equal(f.writes.length, 0);
});
test('reject out-of-range sprint values and arbitrary action names', async () => {
  const f = fixture();
  for (const value of [NaN, Infinity, 0, 1.5, '1.2']) await assert.rejects(f.trainer.apply('run', value), /Invalid control value/);
  const actions = new GTAStoryActions(f.trainer, {});
  await assert.rejects(actions.apply('arbitrary-native-call'), /still being implemented/);
  for (const name of ['money', 'skills', 'model', 'prologue']) await assert.rejects(actions.apply(name), /Confirm/);
  assert.equal(f.writes.length, 0);
});
test('model hashes match the native game convention', () => {
  assert.equal(joaat('player_two'), 2608926626);
  assert.equal(joaat('WEAPON_PISTOL'), 453432689);
});

test('never wanted uses the continuous frame flag and resident menu owns controls', async () => {
  const flags = [];
  const bridge = { setFrameFlag: async (...args) => flags.push(args), installMenu: async () => { bridge.session = { resident: true }; return { installed: true }; } };
  const actions = new GTAStoryActions({}, bridge);
  await actions.apply('neverWanted', { value: true });
  await actions.apply('neverWanted', { value: false });
  assert.deepEqual(flags, [[64, true], [64, false]]);
  assert.equal((await actions.apply('inGameMenu')).installed, true);
  await assert.rejects(actions.apply('upgrades'), /in-game controller menu/);
});
test('max upgrades are idempotent and never touch body, wheel or livery slots', async () => {
  const applied = new Map(), writes = []; let turbo = false;
  const actions = new GTAStoryActions({}, { invoke: async (name, args) => {
    const result = integer => ({ integer, unsigned: integer });
    if (name === 'PLAYER_PED_ID') return result(11);
    if (name === 'GET_VEHICLE_PED_IS_IN') return result(99);
    if (name === 'GET_ENTITY_MODEL') return result(12345);
    if (name === 'GET_NUM_MOD_KITS') return result(1);
    if (name === 'GET_VEHICLE_MOD_KIT') return result(0);
    if (name === 'GET_NUM_VEHICLE_MODS') return result(4);
    if (name === 'GET_VEHICLE_MOD') return result(applied.get(args[1]) ?? -1);
    if (name === 'SET_VEHICLE_MOD') { writes.push(args); applied.set(args[1], args[2]); return result(0); }
    if (name === 'IS_TOGGLE_MOD_ON') return result(Number(turbo));
    if (name === 'TOGGLE_VEHICLE_MOD') { turbo = args[2]; writes.push(args); return result(0); }
    throw Error('Unexpected operation: ' + name);
  } });
  const first = await actions.apply('upgrades'), second = await actions.apply('upgrades');
  assert.equal(first.changed, 6); assert.equal(second.changed, 0);
  assert.deepEqual(writes.map(x => x[1]), [11, 12, 13, 15, 16, 18]);
});
