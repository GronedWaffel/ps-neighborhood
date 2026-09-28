import test from 'node:test';
import assert from 'node:assert/strict';
import { weaponCatalog, giveWeapon } from '../src/trainer-weapons.mjs';

function fixture() {
  const segments = new Map(), put = (at, length) => { const b = Buffer.alloc(length); segments.set(BigInt(at), b); return b; };
  const ps = put(0x10000, 0x468), table = put(0x3700730, 2048);
  ps.writeUInt32LE(1, 0x1b8); ps.writeUInt32LE(1, 0x248);
  for (const [id, name, clip] of [[1,'ray_gun_zm',20], [2,'ray_gun_upgraded_zm',40], [3,'mp5k_zm',30]]) {
    const ptr = 0x20000 + id * 0x1000; table.writeBigUInt64LE(BigInt(ptr), id * 8);
    const object = put(ptr, 0x298); object.writeBigUInt64LE(BigInt(ptr + 0x400)); object.writeBigUInt64LE(BigInt(ptr + 0x500), 16); object.writeInt32LE(clip, 0x214);
    put(ptr + 0x400, 96).write(name); put(ptr + 0x500, 0x90).writeInt32LE(4, 0x38);
  }
  const bytes = async (pid, at, length = 4) => {
    for (const [start, b] of segments) if (at >= start && at + BigInt(length) <= start + BigInt(b.length)) return Buffer.from(b.subarray(Number(at-start), Number(at-start)+length));
    throw Error('Unmapped read');
  };
  const state = { writes: [], failCommit: false, allowed: true };
  const target = { base: 0n, pid: 1, player: '0x10000', commandTime: 100, status: { mcpWrites: true, connectionId: 'console' }, maps: [{ start: '0x10000', end: '0x3800000', prot: 3 }] };
  const trainer = { bytes, weaponVerifyDelay: 0, freeze: { active: false }, target: async () => { target.status.mcpWrites = state.allowed; return target; }, enqueue: f => f(), call: async (name, args) => {
    if (name === 'memory_readv') return Promise.all(args.ranges.map(async r => ({ hex: (await bytes(1, BigInt(r.address), r.length)).toString('hex') })));
    if (name !== 'memory_write') throw Error(name);
    const at = BigInt(args.address), data = Buffer.from(args.hex, 'hex');
    assert.equal((await bytes(1, at, data.length)).toString('hex'), args.expectedHex);
    if (state.failCommit && data.length === 28) throw Error('simulated commit failure');
    for (const [start, b] of segments) if (at >= start && at + BigInt(data.length) <= start + BigInt(b.length)) data.copy(b, Number(at-start));
    state.writes.push(args); return { verified: true };
  }};
  return { trainer, state, ps, target };
}
test('Pack-a-Punch replaces the held weapon in its existing slot even with only one primary', async () => {
  const f = fixture(), c = await weaponCatalog(f.trainer, f.target);
  assert.equal(c.held, 'ray_gun_zm'); assert.equal(c.weapons.length, 3);
  const result = await giveWeapon(f.trainer, undefined, true);
  assert.equal(result.weapon, 'ray_gun_upgraded_zm'); assert.equal(result.slot, 0);
  assert.equal(f.ps.readUInt32LE(0x248), 2); assert.equal(f.ps.readUInt32LE(0x428), 40); assert.equal(f.ps.readUInt32LE(0x3ec), 200);
  assert.equal(f.ps.readUInt32LE(0x264), 0);
  assert.equal(Buffer.from(f.state.writes.at(-2).hex, 'hex').length, 28);
  assert.equal(f.ps.readUInt32LE(0x1b8), 2); assert.equal(result.equipped, true);
  await assert.rejects(giveWeapon(f.trainer, 'ray_gun_upgraded_zm'), /already/);
});
test('Give Weapon replaces only the held primary and preserves all bytes belonging to the holstered gun', async () => {
  const f = fixture(); f.ps.writeUInt32LE(3, 0x264); f.ps.writeUInt32LE(12, 0x42c);
  const holsteredRecord = Buffer.from(f.ps.subarray(0x264, 0x280));
  const result = await giveWeapon(f.trainer, 'ray_gun_upgraded_zm');
  assert.equal(result.replaced, 'ray_gun_zm'); assert.equal(result.slot, 0);
  assert.equal(f.ps.readUInt32LE(0x248), 2); assert.equal(f.ps.readUInt32LE(0x264), 3);
  assert.deepEqual(f.ps.subarray(0x264, 0x280), holsteredRecord); assert.equal(f.ps.readUInt32LE(0x42c), 12);
  assert.equal(f.ps.readUInt32LE(0x280), 0); assert.equal(f.ps.readUInt32LE(0x1b8), 2);
  assert.equal((await weaponCatalog(f.trainer, f.target)).primaryCount, 2);
});
test('replaces the held gun in a later slot instead of the first holstered primary', async () => {
  const f = fixture(); f.ps.writeUInt32LE(3, 0x248); f.ps.writeUInt32LE(1, 0x264); f.ps.writeUInt32LE(17, 0x428); f.ps.writeUInt32LE(90, 0x3ec);
  const result = await giveWeapon(f.trainer, 'ray_gun_upgraded_zm');
  assert.equal(result.slot, 1); assert.equal(result.replaced, 'ray_gun_zm');
  assert.equal(f.ps.readUInt32LE(0x248), 3); assert.equal(f.ps.readUInt32LE(0x264), 2);
  assert.equal(f.ps.readUInt32LE(0x428), 17); assert.equal(f.ps.readUInt32LE(0x3ec), 90);
  assert.equal(f.ps.readUInt32LE(0x1b8), 2);
});
test('refuses an already excessive inventory without making the weapon-reset sequence worse', async () => {
  const f = fixture(); f.ps.writeUInt32LE(3, 0x264); f.ps.writeUInt32LE(3, 0x280);
  await assert.rejects(giveWeapon(f.trainer, undefined, true), /exceeds/); assert.equal(f.state.writes.length, 0);
});
test('failed replacement restores held ammo and preserves the holstered gun', async () => {
  const f = fixture(); f.ps.writeUInt32LE(3, 0x264); f.ps.writeUInt32LE(12, 0x42c); f.ps.writeUInt32LE(80, 0x3f0); f.state.failCommit = true;
  await assert.rejects(giveWeapon(f.trainer, undefined, true), /commit failure/);
  assert.equal(f.ps.readUInt32LE(0x264), 3); assert.equal(f.ps.readUInt32LE(0x42c), 12); assert.equal(f.ps.readUInt32LE(0x3f0), 80);
});
test('weapon insertion rolls back ammo on failed publication and rejects unavailable assets or disabled writes', async () => {
  const f = fixture(); f.state.failCommit = true;
  await assert.rejects(giveWeapon(f.trainer, undefined, true), /commit failure/);
  assert.equal(f.ps.readUInt32LE(0x248), 1); assert.equal(f.ps.readUInt32LE(0x428), 0); assert.equal(f.ps.readUInt32LE(0x3ec), 0);
  await assert.rejects(giveWeapon(f.trainer, 'unknown_zm'), /no supported/);
  f.state.allowed = false; await assert.rejects(giveWeapon(f.trainer, undefined, true), /Allow MCP/);
});
