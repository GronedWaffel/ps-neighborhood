import { createHash } from 'node:crypto';

const hex = value => `0x${BigInt(value).toString(16)}`;

// Player-only data fields derived from this build's native handlers. No shared
// health/ammo instruction patches: those can inadvertently affect mission NPCs.
export class GTAStoryTrainer {
  constructor(call, profile) {
    this.call = call;
    this.profile = profile;
    this.tail = Promise.resolve();
  }
  enqueue(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  async readBytes(pid, at, length) {
    const data = Buffer.from((await this.call('memory_read', { pid, address: hex(at), length })).hex, 'hex');
    if (data.length !== length) throw Error('Incomplete debugger read');
    return data;
  }
  mapped(maps, at, length, write = false) {
    if (!maps.some(m => (m.prot & (write ? 3 : 1)) === (write ? 3 : 1) && at >= BigInt(m.start) && at + BigInt(length) <= BigInt(m.end))) {
      throw Error('Player state is outside the expected mapped memory');
    }
  }
  async target() {
    const status = await this.call('status');
    if (status.mode !== 'live' || status.profile?.platform !== 'ps5') throw Error('Connect PS Neighborhood to your PS5');
    const processes = (await this.call('processes')).filter(p => p.name === 'eboot.bin');
    if (processes.length !== 1) throw Error('A single running GTA V process is required');
    const pid = processes[0].pid;
    const info = await this.call('process_info', { pid });
    if (info.titleId !== this.profile.titleId || info.contentId !== this.profile.contentId) throw Error('This trainer does not match the running game');
    const maps = await this.call('maps', { pid });
    for (const f of this.profile.fingerprints) {
      const bytes = await this.readBytes(pid, BigInt(f.address), f.length);
      if (createHash('sha256').update(bytes).digest('hex') !== f.sha256) throw Error('GTA executable version mismatch; writes refused');
    }
    if ((await this.readBytes(pid, BigInt(this.profile.networkFlag), 1))[0] !== 0) throw Error('This trainer supports Story Mode only');
    const root = (await this.readBytes(pid, BigInt(this.profile.playerRoot), 8)).readBigUInt64LE();
    this.mapped(maps, root, 16);
    const player = (await this.readBytes(pid, root + 8n, 8)).readBigUInt64LE();
    this.mapped(maps, player, 0x1098, true);
    const raw = await this.readBytes(pid, player, 0x1098);
    const health = raw.readFloatLE(0x250), maxHealth = raw.readFloatLE(0x254);
    if (!Number.isFinite(health) || !Number.isFinite(maxHealth) || maxHealth <= 0 || maxHealth > 100000 || health < 0 || health > maxHealth * 10) throw Error('Player state is not ready');
    const playerInfo = raw.readBigUInt64LE(0x1088), weapons = raw.readBigUInt64LE(0x1090);
    this.mapped(maps, playerInfo, Number(this.profile.runOffset ?? 0xcb0) + 4, true);
    this.mapped(maps, weapons, 0x72, true);
    return { pid, status, root, player, playerInfo, weapons, health, maxHealth };
  }
  field(t, id) {
    switch (id) {
      case 'god': return { address: t.player + 0x158n, length: 4, mask: 0x100 };
      case 'clip': return { address: t.weapons + 0x71n, length: 1, mask: 2 };
      case 'ammo': return { address: t.weapons + 0x71n, length: 1, mask: 1 };
      case 'run': return { address: t.playerInfo + BigInt(this.profile.runOffset ?? 0xcb0), length: 4, float: true };
      default: throw Error('This control has no verified implementation for this build');
    }
  }
  decode(f, raw) {
    return f.float ? raw.readFloatLE() : Boolean((f.length === 1 ? raw[0] : raw.readUInt32LE()) & f.mask);
  }
  state() {
    return this.enqueue(async () => {
      const t = await this.target(), values = {};
      for (const id of ['god', 'clip', 'ammo', 'run']) {
        const f = this.field(t, id);
        values[id] = this.decode(f, await this.readBytes(t.pid, f.address, f.length));
      }
      return { titleId: this.profile.titleId, version: this.profile.version, health: t.health, maxHealth: t.maxHealth, writable: t.status.mcpWrites, values };
    });
  }
  apply(id, value) {
    return this.enqueue(async () => {
      const t = await this.target(), f = this.field(t, id);
      if (!t.status.mcpWrites) throw Error('Enable Allow MCP compare-and-write in PS Neighborhood');
      if (t.health <= 0) throw Error('Wait until your character is alive');
      if (f.float ? typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 1.49 : typeof value !== 'boolean') throw Error('Invalid control value');
      const before = await this.readBytes(t.pid, f.address, f.length), after = Buffer.from(before);
      if (f.float) after.writeFloatLE(value);
      else {
        const old = f.length === 1 ? before[0] : before.readUInt32LE();
        const next = (value ? old | f.mask : old & ~f.mask) >>> 0;
        if (f.length === 1) after[0] = next; else after.writeUInt32LE(next);
      }
      // Resolve again immediately before writing. A character switch/restart
      // invalidates the original address, even if the PID happened to survive.
      const current = await this.target();
      if (current.status.connectionId !== t.status.connectionId || current.pid !== t.pid || current.player !== t.player || this.field(current, id).address !== f.address) throw Error('Game session or character changed; refresh and try again');
      if (before.equals(after)) return { id, value: this.decode(f, after), verified: true, unchanged: true };
      const result = await this.call('memory_write', { pid: t.pid, address: hex(f.address), expectedHex: before.toString('hex'), hex: after.toString('hex') });
      if (!result.verified) throw Error('Game changed this value during verification; refresh before retrying');
      return { id, value: this.decode(f, after), verified: true };
    });
  }
}
