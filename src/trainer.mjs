import { createHash } from 'node:crypto';
import { address, hex } from './protocol.mjs';

// All live operations go through the public MCP tools, including its write gate.
export class Trainer {
  constructor(call, profile, { interval = 125 } = {}) {
    this.call = call; this.profile = profile; this.tail = Promise.resolve(); this.interval = interval;
    this.freeze = { active: false }; this.generation = 0; this.closed = false;
  }
  enqueue(action) { const result = this.tail.then(action); this.tail = result.catch(() => {}); return result; }
  writable(maps, at, length = 4) {
    if (!maps.some(m => (m.prot & 3) === 3 && at >= address(m.start) && at + BigInt(length) <= address(m.end))) throw new Error('Target is outside writable memory');
  }
  async bytes(pid, at, length = 4) { return Buffer.from((await this.call('memory_read', { pid, address: hex(at), length })).hex, 'hex'); }
  async target({ allowUnequipped = false } = {}) {
    const status = await this.call('status');
    if (status.mode !== 'live') throw new Error('Connect PS Neighborhood to the real console first');
    if((status.profile?.platform||'ps4')!==(this.profile.platform||'ps4'))throw Error('This trainer profile targets a different console platform; a PS5 game build needs its own validated trainer profile');
    const candidates = (await this.call('processes')).filter(p => p.name === this.profile.processName);
    if (candidates.length !== 1) throw new Error('The expected Zombies process is not running');
    const pid = candidates[0].pid, identity = await this.call('process_info', { pid });
    if (identity.titleId !== this.profile.titleId || identity.contentId !== this.profile.contentId) throw new Error('Game identity differs from this trainer profile');
    const maps = await this.call('maps', { pid });
    const executable = maps.filter(m => m.name === 'executable' && (m.prot & 5) === 5).sort((a, b) => address(a.start) < address(b.start) ? -1 : 1)[0];
    if (!executable) throw new Error('Executable mapping not found');
    const base = address(executable.start);
    const code = await this.call('memory_read', { pid, address: hex(base), length: this.profile.fingerprint.length });
    if (createHash('sha256').update(Buffer.from(code.hex, 'hex')).digest('hex') !== this.profile.fingerprint.sha256) throw new Error('Executable fingerprint differs; trainer refused this build');
    let player, commandTime, playerState;
    if (this.profile.player) {
      player = (await this.bytes(pid, base + address(this.profile.player.pointerOffset), 8)).readBigUInt64LE();
      if (!player) throw new Error('Enter a Zombies match: no active player is attached');
      this.writable(maps, player, this.profile.player.size);
      commandTime = (await this.bytes(pid, player)).readUInt32LE();
      playerState = await this.bytes(pid, player, 0x468);
      const health = (await this.bytes(pid, base + address(this.profile.player.healthOffset))).readInt32LE();
      if (health <= 0) throw new Error('Player is not alive; trainer writes are stopped');
    }
    const fields = [];
    for (const f of this.profile.fields) {
      let origin = f.relativeTo === 'player' ? player : base;
      if (f.pointerOffset) {
        origin = (await this.bytes(pid, base + address(f.pointerOffset), 8)).readBigUInt64LE();
        this.writable(maps, origin, 96);
        if (f.dvar) {
          const d = await this.bytes(pid, origin, 96);
          if (d.readBigUInt64LE() !== base + address(f.dvar.nameOffset) || d.readUInt32LE(28) !== f.dvar.type) throw new Error(`${f.label} setting identity changed`);
        }
      }
      let offset = address(f.offset);
      if (f.activeClip) {
        const held = playerState.readUInt32LE(0x1b8);
        const slot = Array.from({ length: 15 }, (_, i) => i).find(i => held && playerState.readUInt32LE(0x248 + i * 28) === held);
        if (slot === undefined) {
          if (allowUnequipped) continue;
          throw new Error('Hold a weapon before using the trainer');
        }
        offset = BigInt(0x428 + slot * 4);
      }
      const at = origin + offset, mirrors = (f.mirrorOffsets || []).map(o => origin + address(o));
      for (const a of [at, ...mirrors]) this.writable(maps, a);
      fields.push({ ...f, address: hex(at), mirrors: mirrors.map(hex), ...(f.activeClip ? { weaponId: playerState.readUInt32LE(0x1b8) } : {}) });
    }
    return { status, pid, identity, fields, player: player && hex(player), commandTime, base, maps };
  }
  async read() {
    const target = await this.target();
    const values = target.fields.length ? await this.call('memory_readv', { pid: target.pid, ranges: target.fields.map(f => ({ address: f.address, length: 4 })) }) : [];
    return { name: this.profile.name, titleId: target.identity.titleId, pid: target.pid, writesEnabled: target.status.mcpWrites, note: this.profile.note,
      freeze: { ...this.freeze }, fields: target.fields.map((f, i) => { const b = Buffer.from(values[i].hex, 'hex'), raw = b.readUInt32LE(); return { ...f, value: f.mask ? Number(Boolean(raw & f.mask)) : f.type === 'f32' ? b.readFloatLE() : raw }; }) };
  }
  apply(id, value) { return this.enqueue(() => this.applyNow(id, value)); }
  async applyNow(id, value, pin) {
      if (this.closed) throw new Error('Trainer is closed');
      const f = this.profile.fields.find(f => f.id === id);
      if (!f?.verified) throw new Error('This field has not been validated for trainer writes');
      if (!(f.type === 'f32' ? Number.isFinite(value) : Number.isSafeInteger(value)) || value < f.min || value > f.max) throw new Error(`Value must be ${f.min}–${f.max}`);
      const target = await this.target();
      if (pin && (target.pid !== pin.pid || target.status.connectionId !== pin.connectionId || target.player !== pin.player || target.fields.find(x => x.id === id)?.address !== pin.address)) throw new Error('Match or connection changed; freeze stopped');
      if (pin && target.fields.find(x => x.id === id)?.weaponId !== pin.weaponId) throw new Error('Equipped weapon changed; enable clip freeze again');
      if (pin && target.commandTime < pin.commandTime) throw new Error('Match clock restarted; freeze stopped');
      if (pin) pin.commandTime = target.commandTime;
      if (!target.status.mcpWrites) throw new Error('Enable Allow MCP compare-and-write in PS Neighborhood → MCP bridge');
      if (target.status.scan?.state === 'running' || target.status.dump?.state === 'running') throw new Error('Finish the current scan or dump first');
      const field = target.fields.find(x => x.id === id);
      let before; const changed = [];
      try {
        for (const at of [field.address, ...field.mirrors]) {
          const current = await this.bytes(target.pid, address(at)), raw = current.readUInt32LE();
          before ??= f.mask ? Number(Boolean(raw & f.mask)) : f.type === 'f32' ? current.readFloatLE() : raw;
          const replacement = Buffer.alloc(4);
          if (f.type === 'f32') replacement.writeFloatLE(value);
          else replacement.writeUInt32LE(f.mask ? (value ? raw | f.mask : raw & ~f.mask) >>> 0 : value);
          if (replacement.equals(current)) continue;
          const result = await this.call('memory_write', { pid: target.pid, address: at, expectedHex: current.toString('hex'), hex: replacement.toString('hex') });
          if (!result.verified) {
            // A shot can consume ammo between PS4Debug's write and its read-back.
            // Only a pinned, single u32 ammo freeze may treat that bounded decrease as a race.
            // One-shot writes and all other fields still require exact verification.
            const after = /^[0-9a-f]{8}$/i.test(result.after || '') ? Buffer.from(result.after, 'hex').readUInt32LE() : undefined;
            if (pin && f.freeze && !f.mask && f.type !== 'f32' && !field.mirrors.length && after !== undefined && after < value) {
              return { field: f.label, before, after, verified: false, raced: true };
            }
            throw new Error('Write verification failed; refresh before another action');
          }
          changed.push({ at, current, replacement });
        }
      } catch (error) {
        // Roll back only bytes still equal to this operation's replacement.
        for (const c of changed.reverse()) {
          try { await this.call('memory_write', { pid: target.pid, address: c.at, expectedHex: c.replacement.toString('hex'), hex: c.current.toString('hex') }); }
          catch { error.message += '; a partial change remains, refresh before retrying'; }
        }
        throw error;
      }
      return { field: f.label, before, after: value, verified: true };
  }
  async setFreeze(id, value, active) {
    await this.stopFreeze();
    if (!active) return { ...this.freeze };
    return this.enqueue(async () => {
      if (!this.profile.fields.find(f => f.id === id)?.freeze) throw new Error('This field does not support freezing');
      const target = await this.target(), field = target.fields.find(f => f.id === id);
      const pin = { pid: target.pid, connectionId: target.status.connectionId, player: target.player, address: field.address, commandTime: target.commandTime, weaponId: field.weaponId };
      const initial = await this.applyNow(id, value, pin);
      const generation = ++this.generation;
      this.freeze = { active: true, field: id, value, writes: Number(initial.verified), races: Number(!!initial.raced) };
      const tick = () => {
        this.timer = setTimeout(() => {
          this.enqueue(async () => {
            if (generation !== this.generation) return;
            try {
              const result = await this.applyNow(id, value, pin);
              if (result.raced) this.freeze.races++;
              else this.freeze.writes++;
            }
            catch (e) {
              if (!e.message.startsWith('Memory changed; write refused')) {
                this.freeze = { ...this.freeze, active: false, error: e.message }; ++this.generation; return;
              }
              this.freeze.races++;
            }
            if (generation === this.generation) tick();
          });
        }, this.interval);
        this.timer.unref?.();
      };
      tick(); return { ...this.freeze };
    });
  }
  async stopFreeze() {
    ++this.generation; clearTimeout(this.timer); this.freeze = { ...this.freeze, active: false };
    await this.tail;
    ++this.generation; clearTimeout(this.timer); this.freeze.active = false;
  }
  async close() { this.closed = true; await this.stopFreeze(); }
}
