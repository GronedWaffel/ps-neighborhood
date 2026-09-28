import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Trainer } from '../src/trainer.mjs';

function fixture() {
  const code = Buffer.from('gamecode'), memory = Buffer.alloc(4); memory.writeUInt32LE(7);
  const profile = { name: 'Test', processName: 'codzm.elf', titleId: 'TEST', contentId: 'TEST-CONTENT', fingerprint: { length: code.length, sha256: createHash('sha256').update(code).digest('hex') }, fields: [{ id: 'ammo', label: 'Magazine', offset: '0x200', verified: true, min: 0, max: 8, default: 8 }] };
  const state = { writes: true, title: 'TEST', code, writesPerformed: [], running: true, prot: 3, memory, connectionId: 'first' };
  const call = async (method, args) => {
    switch (method) {
      case 'status': return { mode: 'live', mcpWrites: state.writes, connectionId: state.connectionId };
      case 'processes': return state.running ? [{ name: 'codzm.elf', pid: 123 }] : [];
      case 'process_info': return { titleId: state.title, contentId: 'TEST-CONTENT' };
      case 'maps': return [{ name: 'executable', start: '0x1000', end: '0x1100', prot: 5 }, { name: 'executable', start: '0x1200', end: '0x1300', prot: state.prot }];
      case 'memory_read': return { hex: (args.address === '0x1000' ? state.code : memory).toString('hex') };
      case 'memory_readv': return [{ hex: memory.toString('hex') }];
      case 'memory_write':
        assert.equal(args.expectedHex, memory.toString('hex'));
        if (state.compareRace) { memory.writeUInt32LE(Math.max(0, memory.readUInt32LE() - 1)); throw Error('Memory changed; write refused. Current bytes: ' + memory.toString('hex')); }
        state.writesPerformed.push(args); Buffer.from(args.hex, 'hex').copy(memory);
        if (state.shooting) { memory.writeUInt32LE(state.badReadback ? 0xffffffff : Math.max(0, memory.readUInt32LE() - 1)); return { verified: false, after: memory.toString('hex') }; }
        return { verified: true };
      default: throw Error(method);
    }
  };
  return { trainer: new Trainer(call, profile), state, profile };
}

test('trainer resolves module offsets, reads fields and performs a bounded compare-and-write through MCP', async () => {
  const { trainer, state } = fixture();
  const read = await trainer.read(); assert.equal(read.fields[0].value, 7); assert.equal(read.fields[0].address, '0x1200');
  assert.deepEqual(await trainer.apply('ammo', 8), { field: 'Magazine', before: 7, after: 8, verified: true });
  assert.equal(state.writesPerformed[0].expectedHex, '07000000'); assert.equal((await trainer.read()).fields[0].value, 8);
});

const delay = ms => new Promise(r => setTimeout(r, ms));
test('continuous firing during write read-back does not disarm clip freeze', async () => {
  const f = fixture(); f.profile.fields[0].freeze = true; f.trainer.interval = 5; f.state.shooting = true;
  try {
    await f.trainer.setFreeze('ammo', 8, true); await delay(80);
    assert.equal(f.trainer.freeze.active, true); assert.ok(f.trainer.freeze.races > 2);
    assert.equal(f.state.memory.readUInt32LE(), 7);
    f.state.shooting = false; await delay(30);
    assert.equal(f.state.memory.readUInt32LE(), 8); assert.equal(f.trainer.freeze.active, true);
    f.state.memory.writeUInt32LE(5); f.state.compareRace = true; await delay(30);
    assert.equal(f.trainer.freeze.active, true);
    f.state.compareRace = false; await delay(30); assert.equal(f.state.memory.readUInt32LE(), 8);
  } finally { await f.trainer.close(); }
});
test('freeze still stops for unexpected read-back data and one-shot writes remain strict', async () => {
  const f = fixture(); f.profile.fields[0].freeze = true; f.trainer.interval = 5; f.state.shooting = true;
  await assert.rejects(f.trainer.apply('ammo', 8), /verification/);
  f.state.badReadback = true;
  await assert.rejects(f.trainer.setFreeze('ammo', 8, true), /verification/);
  assert.equal(f.trainer.freeze.active, false); await f.trainer.close();
});
test('clip freeze refills, stops on connection/write-gate loss, and drains before close', async () => {
  for (const change of [f => f.state.connectionId = 'replacement', f => f.state.writes = false]) {
    const f = fixture(); f.profile.fields[0].freeze = true; f.trainer.interval = 5;
    await f.trainer.setFreeze('ammo', 8, true);
    f.state.memory.writeUInt32LE(6); await delay(35);
    assert.equal(f.state.memory.readUInt32LE(), 8);
    change(f); f.state.memory.writeUInt32LE(5); await delay(35);
    assert.equal(f.trainer.freeze.active, false); assert.equal(f.state.memory.readUInt32LE(), 5);
    await f.trainer.close(); const count = f.state.writesPerformed.length; await delay(20);
    assert.equal(f.state.writesPerformed.length, count);
  }
});
test('stopping or replacing a freeze cancels the old loop', async () => {
  const f = fixture(); f.profile.fields[0].freeze = true; f.trainer.interval = 5;
  await f.trainer.setFreeze('ammo', 8, true); await f.trainer.setFreeze('ammo', 7, true);
  f.state.memory.writeUInt32LE(3); await delay(30); assert.equal(f.state.memory.readUInt32LE(), 7);
  await f.trainer.stopFreeze(); f.state.memory.writeUInt32LE(2); await delay(25);
  assert.equal(f.state.memory.readUInt32LE(), 2); await f.trainer.close();
});
test('toggle preserves unrelated bits and float fields use IEEE 754 bytes', async () => {
  const f = fixture(); Object.assign(f.profile.fields[0], { mask: 1, min: 0, max: 1 });
  f.state.memory.writeUInt32LE(0x804); await f.trainer.apply('ammo', 1);
  assert.equal(f.state.memory.readUInt32LE(), 0x805); await f.trainer.apply('ammo', 0);
  assert.equal(f.state.memory.readUInt32LE(), 0x804);
  delete f.profile.fields[0].mask; Object.assign(f.profile.fields[0], { type: 'f32', min: 65, max: 120 });
  await f.trainer.apply('ammo', 92.5); assert.equal(f.state.memory.readFloatLE(), 92.5);
  await assert.rejects(f.trainer.apply('ammo', Infinity), /65–120/);
});

test('trainer refuses wrong builds, missing processes, unmapped fields, write gate, unvalidated fields and invalid values', async () => {
  for (const [change, message] of [
    [f => f.state.title = 'OTHER', /identity/],
    [f => f.state.code = Buffer.from('newbuild'), /fingerprint/],
    [f => f.state.running = false, /not running/],
    [f => f.state.prot = 1, /writable/],
    [f => f.state.writes = false, /Allow MCP/],
    [f => f.profile.fields[0].verified = false, /validated/]
  ]) {
    const f = fixture(); change(f); await assert.rejects(f.trainer.apply('ammo', 8), message); assert.equal(f.state.writesPerformed.length, 0);
  }
  const f = fixture(); await assert.rejects(f.trainer.apply('ammo', 9), /0–8/); await assert.rejects(f.trainer.apply('ammo', NaN), /0–8/); await assert.rejects(f.trainer.apply('unknown', 1), /validated/);
});
