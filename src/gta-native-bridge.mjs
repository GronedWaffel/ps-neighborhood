import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PS5Debug } from './ps5debug.mjs';
import { createHash } from 'node:crypto';

const hex = n => `0x${BigInt(n).toString(16)}`;
const ptr = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

// Host-side queue ownership is serialized. All actual game-native execution is
// performed inside main_persistent, with the original native always forwarded.
export class GTANativeBridge {
  constructor(trainer, directory, recoveryDirectory) {
    this.trainer = trainer; this.call = trainer.call; this.directory = directory;
    this.recoveryDirectory = recoveryDirectory; this.tail = Promise.resolve();
  }
  enqueue(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
  async read(at, length) { return this.trainer.readBytes(this.session.pid, at, length); }
  async validate() {
    const t = await this.trainer.target();
    if (!t.status.mcpWrites) throw Error('Enable MCP compare-and-write');
    if (this.session && (t.pid !== this.session.pid || t.status.connectionId !== this.session.connectionId)) throw Error('GTA session changed; restart the trainer');
    return t;
  }
  async write(at, before, after, statePublication = false) {
    await this.validate();
    const r = await this.call('memory_write', { pid: this.session.pid, address: hex(at), expectedHex: before.toString('hex'), hex: after.toString('hex') });
    if (!r.verified && !(statePublication && ['02000000', '03000000'].includes(r.after))) throw Error('Native bridge write did not verify');
  }
  async locateProgram(hash) {
    const g = await this.read(BigInt(this.trainer.profile.scriptRegistry ?? 0x4688118), 0x58), count = g.readUInt32LE(0x50);
    if (!count || count > 65536) throw Error('Invalid script registry');
    const entries = g.readBigUInt64LE(0x40), buckets = g.readBigUInt64LE(0x48);
    let index = (await this.read(buckets + BigInt((hash % count) * 4), 4)).readInt32LE();
    for (let n = 0; index >= 0 && index < 16384 && n < 16384; n++) {
      const e = await this.read(entries + BigInt(index * 12), 12);
      if (e.readUInt32LE() === hash) {
        const slot = e.readInt32LE(4), stride = g.readUInt32LE(0x1c);
        if (slot < 0 || slot > 16384 || stride !== 16) throw Error('Invalid program slot');
        const p = (await this.read(g.readBigUInt64LE(8) + BigInt(slot * stride), 8)).readBigUInt64LE();
        const header = await this.read(p, 0x78);
        if (header.readUInt32LE(0x58) !== hash) throw Error('Script program identity mismatch');
        return { address: p, header };
      }
      index = e.readInt32LE(8);
    }
    throw Error('Required Story Mode script is not loaded');
  }
  async ensure() {
    const t = await this.validate();
    if (this.session) {
      if (!(await this.read(this.session.slot, 8)).equals(ptr(this.session.base))) throw Error('Native bridge was replaced; restart the trainer');
      return;
    }
    this.session = { pid: t.pid, connectionId: t.status.connectionId };
    this.names = JSON.parse(await readFile(path.join(this.directory, 'native-addresses.json'), 'utf8'));
    const main = await this.locateProgram(1459623836), table = main.header.readBigUInt64LE(0x40), count = main.header.readUInt32LE(0x2c);
    if (!count || count > 8192) throw Error('Invalid native table');
    const natives = await this.read(table, count * 8), original = ptr(BigInt(this.names.PLAYER_ID.handler));
    const slots = [];
    for (let i = 0; i < count; i++) if (natives.subarray(i * 8, i * 8 + 8).equals(original)) slots.push(table + BigInt(i * 8));
    if (slots.length !== 1) {
      // Reattach only to this exact resident build, never to an unknown hook.
      const saved = JSON.parse(await readFile(path.join(this.recoveryDirectory, 'native-bridge-recovery.json'), 'utf8').catch(() => '{}'));
      const image = await readFile(path.join(this.directory, 'gta-bridge.bin'));
      if (slots.length || saved.pid !== t.pid || saved.connectionId !== t.status.connectionId || saved.imageSha256 !== createHash('sha256').update(image).digest('hex') || saved.original !== original.toString('hex')) throw Error('PLAYER_ID is already hooked by a different build; close the old trainer or restart GTA');
      const slot = BigInt(saved.slot), base = Buffer.from(saved.installed, 'hex').readBigUInt64LE();
      if (slot < table || slot >= table + BigInt(count * 8) || (slot - table) % 8n || !(await this.read(slot, 8)).equals(ptr(base))) throw Error('Resident hook identity changed');
      if ((await this.read(base + 0x10000n, 8)).readBigUInt64LE() !== 0x325654474e5350n || !(await this.read(base, 64)).equals(image.subarray(0, 64))) throw Error('Resident menu signature differs');
      this.session = { ...this.session, base, slot, original, attached: true, resident: true };
      return;
    }
    this.session.slot = slots[0]; this.session.original = original;
    const debug = new PS5Debug({ host: t.status.profile.host, port: t.status.profile.debugPort });
    try {
      await debug.connect();
      this.session.base = await debug.transaction(async () => {
        const request = Buffer.alloc(8); request.writeUInt32LE(t.pid); request.writeUInt32LE(0x20000, 4);
        await debug.send(0xbdaa000b, request); await debug.status();
        return (await debug.receive(8)).readBigUInt64LE();
      });
    } finally { debug.close(); }
    const base = this.session.base, maps = await this.call('maps', { pid: t.pid });
    if (!base || !maps.some(m => (m.prot & 7) === 7 && base >= BigInt(m.start) && base + 0x20000n <= BigInt(m.end))) throw Error('Debugger did not allocate executable scratch memory');
    const image = await readFile(path.join(this.directory, 'gta-bridge.bin'));
    if (image.length !== 0x20000) throw Error('Invalid native bridge image');
    image.writeBigUInt64LE(0x325654474e5350n, 0x10000); original.copy(image, 0x10008);
    ['GET_FRAME_COUNT', 'PLAYER_PED_ID', 'GET_VEHICLE_PED_IS_IN', 'IS_HORN_ACTIVE', 'GET_ENTITY_SPEED', 'SET_VEHICLE_FORWARD_SPEED', 'APPLY_FORCE_TO_ENTITY_CENTER_OF_MASS', 'DISABLE_CONTROL_ACTION', 'GET_FRAME_TIME', 'GET_GAME_TIMER', 'GET_ENTITY_COORDS', 'GET_WATER_HEIGHT_NO_WAVES', 'SET_ENTITY_COORDS_NO_OFFSET', 'GET_ENTITY_HEADING', 'SET_ENTITY_HEADING', 'DOES_ENTITY_EXIST'].forEach((name, i) => image.writeBigUInt64LE(BigInt(this.names[name].handler), 0x10550 + i * 8));
    for (let offset = 0; offset < image.length; offset += 4096) await this.write(base + BigInt(offset), Buffer.alloc(4096), image.subarray(offset, offset + 4096));
    await mkdir(this.recoveryDirectory, { recursive: true });
    const imageSha256 = createHash('sha256').update(await readFile(path.join(this.directory, 'gta-bridge.bin'))).digest('hex');
    await writeFile(path.join(this.recoveryDirectory, 'native-bridge-recovery.json'), JSON.stringify({ pid: t.pid, connectionId: t.status.connectionId, slot: hex(this.session.slot), installed: ptr(base).toString('hex'), original: original.toString('hex'), imageSha256 }, null, 2));
    await this.write(this.session.slot, original, ptr(base));
    this.session.attached = true;
  }
  invoke(name, args = []) {
    return this.enqueue(async () => {
      await this.ensure();
      const native = this.names[name];
      if (!native || args.length > 32 || name === 'WAIT') throw Error('Native operation unavailable');
      const base = this.session.base, scratch = Buffer.alloc(1024), body = Buffer.alloc(0x12c), outputs = [];
      let used = 0;
      body.writeUInt32LE(args.length); body.writeBigUInt64LE(BigInt(native.handler), 4);
      args.forEach((arg, i) => {
        const offset = 12 + i * 8;
        if (typeof arg === 'string' || arg?.out) {
          used = (used + 7) & ~7;
          const data = typeof arg === 'string' ? Buffer.from(arg + '\0') : Buffer.alloc(arg.out === 'vec3' ? 24 : 8);
          if (arg?.out === 'i32' && Number.isInteger(arg.value)) data.writeInt32LE(arg.value);
          if (used + data.length > scratch.length) throw Error('Native string/output buffer too large');
          data.copy(scratch, used); body.writeBigUInt64LE(base + 0x10148n + BigInt(used), offset);
          if (arg?.out) outputs.push({ type: arg.out, offset: used });
          used += data.length;
        } else if (arg && typeof arg === 'object' && typeof arg.float === 'number' && Number.isFinite(arg.float)) body.writeFloatLE(arg.float, offset);
        else body.writeBigUInt64LE(BigInt.asUintN(64, BigInt(typeof arg === 'boolean' ? Number(arg) : arg)), offset);
      });
      const stateAt = base + 0x10010n;
      const state = await this.read(stateAt, 4);
      if (![0, 3].includes(state.readUInt32LE())) throw Error('A native command is still in flight');
      await this.write(stateAt, state, Buffer.alloc(4));
      if (used) await this.write(base + 0x10148n, await this.read(base + 0x10148n, scratch.length), scratch);
      await this.write(base + 0x10014n, await this.read(base + 0x10014n, body.length), body);
      const checkpoint = path.join(this.recoveryDirectory, 'last-native-command.json');
      await writeFile(checkpoint, JSON.stringify({ name, phase: 'pending', time: new Date().toISOString() }));
      await this.write(stateAt, Buffer.alloc(4), Buffer.from('01000000', 'hex'), true);
      const deadline = Date.now() + 8000;
      let reply;
      do {
        reply = await this.read(stateAt, 0x138);
        if (reply.readUInt32LE() === 3) break;
        await new Promise(resolve => setTimeout(resolve, 35));
      } while (Date.now() < deadline);
      if (reply.readUInt32LE() !== 3) throw Error('Game did not service the command; leave the pause menu and refresh. The command may still run; do not repeat it.');
      if (reply.readUInt32LE(0x130)) throw Error('Game rejected the native command');
      await writeFile(checkpoint, JSON.stringify({ name, phase: 'complete', time: new Date().toISOString() }));
      const raw = reply.subarray(0x110, 0x130), out = used ? await this.read(base + 0x10148n, used) : Buffer.alloc(0);
      return { integer: raw.readInt32LE(), unsigned: raw.readUInt32LE(), float: raw.readFloatLE(), vector: [0, 8, 16].map(o => raw.readFloatLE(o)), outputs: outputs.map(o => o.type === 'vec3' ? [0, 8, 16].map(n => out.readFloatLE(o.offset + n)) : o.type === 'f32' ? out.readFloatLE(o.offset) : out.readInt32LE(o.offset)) };
    });
  }
  setFrameFlag(mask, enabled) {
    return this.enqueue(async () => {
      if (![1, 2, 4, 8, 16, 32, 64].includes(mask) || typeof enabled !== 'boolean') throw Error('Invalid frame control');
      await this.ensure();
      const at = this.session.base + 0x10548n, before = await this.read(at, 4), after = Buffer.alloc(4);
      after.writeUInt32LE(enabled ? before.readUInt32LE() | mask : before.readUInt32LE() & ~mask);
      await this.write(at, before, after);
      return { enabled };
    });
  }
  setWaterPlatform(handle, top) {
    return this.enqueue(async () => {
      if (!Number.isInteger(handle) || handle < 0 || !Number.isFinite(top) || Math.abs(top) > 100) throw Error('Invalid water platform');
      await this.ensure();
      const at = this.session.base + 0x105f0n, after = Buffer.alloc(12);
      after.writeBigUInt64LE(BigInt(handle)); after.writeFloatLE(top, 8);
      await this.write(at, await this.read(at, 12), after);
    });
  }
  installMenu() {
    return this.enqueue(async () => {
      await this.ensure();
      const at = this.session.base + 0x105fcn;
      const before = await this.read(at, 4), enabled = Buffer.alloc(4); enabled.writeUInt32LE(1);
      await this.write(at, before, enabled);
      this.session.resident = true;
      return { installed: true, message: 'In-game menu installed. Press L1 + D-pad Right. D-pad navigates, Cross selects, Circle goes back. You can close this PC window.' };
    });
  }
  close() {
    return this.enqueue(async () => {
      if (!this.session?.attached) return;
      if ((await this.read(this.session.base + 0x105fcn, 4)).readUInt32LE() === 1) return;
      // Cancel a queued request only while idle; never tear down executing code.
      const stateAt = this.session.base + 0x10010n, state = await this.read(stateAt, 4);
      if (state.readUInt32LE() === 1) await this.write(stateAt, state, Buffer.alloc(4));
      if ((await this.read(stateAt, 4)).readUInt32LE() === 2) throw Error('Native call is still executing; bridge left allocated');
      await this.write(this.session.slot, ptr(this.session.base), this.session.original);
      this.session.attached = false;
      // Keep scratch pages mapped until GTA exits: a native already dispatched
      // before slot restoration may still be returning through this code.
    });
  }
}
