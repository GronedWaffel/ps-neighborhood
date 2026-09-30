import net from 'node:net';
import { NGScanner } from './ng-scanner.mjs';

export const hex = n => '0x' + BigInt(n).toString(16).toUpperCase();
export function address(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Use a hex string for 64-bit addresses');
  if (typeof value === 'string' && !/^(0x[\da-f]+|\d+)$/i.test(value)) throw new Error('Address must be decimal or 0x-prefixed hexadecimal');
  const n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error('Address is outside uint64 range');
  return n;
}
export function integer(n, min, max, label = 'Value') {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${label} must be ${min}–${max}`);
  return n;
}
export function bytes(value) {
  const s = String(value).replace(/\s/g, '');
  if (!s || s.length % 2 || !/^[\da-f]+$/i.test(s)) throw new Error('Enter complete hexadecimal bytes, e.g. 64 00 00 00');
  return Buffer.from(s, 'hex');
}
export const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const cstring = b => b.toString('utf8').split('\0')[0];

// A single ordered command stream. TCP packets may split or coalesce arbitrarily.
export class PS4Debug {
  constructor({ host, port = 744, timeout = 8000 }) {
    this.host = host; this.port = port; this.timeout = timeout;
    this.tail = Promise.resolve(); this.buffer = Buffer.alloc(0); this.pending = null; this.failure = null;
    this.capabilities = { nativeScan: false, reason: 'NG capabilities have not been detected' };
    this.ng = new NGScanner(this);
  }
  async connect() {
    if (!net.isIP(this.host)) throw new Error('Enter a console IP address');
    integer(this.port, 1, 65535, 'Port');
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.setNoDelay(true);
    this.socket.on('data', data => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > 4 * 1024 * 1024) return this.fail(new Error('Unexpected oversized PS4Debug response'));
      this.flush();
    });
    this.socket.on('error', err => this.fail(err));
    this.socket.on('close', () => this.fail(new Error('Debugger connection closed. Check the existing service before reconnecting; do not load a duplicate payload.')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.destroy(); reject(new Error(`Connection timed out: ${this.host}:${this.port}`)); }, this.timeout);
      this.socket.once('connect', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', err => { clearTimeout(timer); reject(err); });
    });
    return this;
  }
  get connected() { return !!this.socket && !this.socket.destroyed && !this.failure; }
  async detectCapabilities() {
    // An unsupported extension may close its stream. Probe a disposable connection
    // so classic PS4Debug's working command stream is never left out of sync.
    const probe = new PS4Debug({ host: this.host, port: this.port, timeout: Math.min(this.timeout, 1500) });
    try {
      await probe.connect();
      const branding = await probe.transaction(async () => {
        await probe.send(0xbd000501);
        const length = integer((await probe.receive(4)).readUInt32LE(), 1, 512, 'Branding length');
        return cstring(await probe.receive(length));
      });
      this.capabilities = { nativeScan: /ps4debug[- ]ng\b/i.test(branding), branding, reason: /ps4debug[- ]ng\b/i.test(branding) ? 'PS4Debug-NG numeric scanning detected' : 'Payload does not identify as PS4Debug-NG' };
    } catch {
      this.capabilities = { nativeScan: false, reason: 'NG branding unavailable; classic host scanning available' };
    } finally { probe.close(); }
    return this.capabilities;
  }
  fail(err) { this.failure ??= err; if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(this.failure); this.pending = null; } this.socket?.destroy(); }
  close() { this.fail(new Error('Disconnected')); }
  flush() {
    const p = this.pending;
    if (p && this.buffer.length >= p.length) {
      const result = this.buffer.subarray(0, p.length);
      this.buffer = this.buffer.subarray(p.length); this.pending = null;
      clearTimeout(p.timer); p.resolve(result);
    }
  }
  receive(length) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending = { length, resolve, reject, timer: setTimeout(() => this.fail(new Error('PS4Debug response timed out; connection discarded to preserve framing')), this.timeout) };
      this.flush();
    });
  }
  async send(command, body = Buffer.alloc(0)) {
    if (!this.connected) throw this.failure || new Error('Not connected');
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0xffaabbcc); header.writeUInt32LE(command, 4); header.writeUInt32LE(body.length, 8);
    await this.write(Buffer.concat([header, body]));
  }
  write(data) { return new Promise((resolve, reject) => this.socket.write(data, e => e ? reject(e) : resolve())); }
  async status() {
    const status = (await this.receive(4)).readUInt32LE();
    if (status !== 0x80000000) throw new Error(`PS4Debug status ${hex(status)}`);
  }
  transaction(fn) {
    const run = this.tail.then(async () => { try { return await fn(); } catch (e) { this.fail(e); throw e; } });
    this.tail = run.catch(() => {}); return run;
  }
  processes() { return this.transaction(async () => {
    await this.send(0xbdaa0001); await this.status();
    const count = integer((await this.receive(4)).readUInt32LE(), 0, 4096, 'Process count');
    const b = await this.receive(count * 36);
    return Array.from({ length: count }, (_, i) => ({ name: cstring(b.subarray(i * 36, i * 36 + 32)), pid: b.readUInt32LE(i * 36 + 32) }));
  }); }
  maps(pid) { integer(pid, 1, 0xffffffff, 'PID'); return this.transaction(async () => {
    await this.send(0xbdaa0004, u32(pid)); await this.status();
    const count = integer((await this.receive(4)).readUInt32LE(), 0, 65536, 'Map count');
    const b = await this.receive(count * 58);
    return Array.from({ length: count }, (_, i) => {
      const o = i * 58, prot = b.readUInt16LE(o + 56);
      return { name: cstring(b.subarray(o, o + 32)), start: hex(b.readBigUInt64LE(o + 32)), end: hex(b.readBigUInt64LE(o + 40)), offset: hex(b.readBigUInt64LE(o + 48)), prot, permissions: [prot & 1 ? 'r' : '-', prot & 2 ? 'w' : '-', prot & 4 ? 'x' : '-'].join('') };
    });
  }); }
  info(pid) { integer(pid, 1, 0xffffffff, 'PID'); return this.transaction(async () => {
    await this.send(0xbdaa000a, u32(pid)); await this.status(); const b = await this.receive(188);
    return { pid: b.readUInt32LE(), name: cstring(b.subarray(4, 44)), path: cstring(b.subarray(44, 108)), titleId: cstring(b.subarray(108, 124)), contentId: cstring(b.subarray(124, 188)) };
  }); }
  packet(pid, addr, length) {
    integer(pid, 1, 0xffffffff, 'PID'); integer(length, 1, 1024 * 1024, 'Read/write size');
    const a = address(addr); if (a + BigInt(length) > 0x10000000000000000n) throw new Error('Address range overflows uint64');
    const b = Buffer.alloc(16); b.writeUInt32LE(pid); b.writeBigUInt64LE(a, 4); b.writeUInt32LE(length, 12); return b;
  }
  read(pid, addr, length) { const b = this.packet(pid, addr, length); return this.transaction(async () => {
    await this.send(0xbdaa0002, b); await this.status(); return Buffer.from(await this.receive(length));
  }); }
  writeMemory(pid, addr, data) { const b = this.packet(pid, addr, data.length); return this.transaction(async () => {
    await this.send(0xbdaa0003, b); await this.status(); await this.write(data); await this.status();
  }); }
}

export async function probe(host, port, timeout = 5000) {
  return new Promise(resolve => {
    const s = net.connect({ host, port }); const start = Date.now();
    const done = (open, error) => { s.destroy(); resolve({ port, open, latencyMs: Date.now() - start, error }); };
    s.setTimeout(timeout); s.once('connect', () => done(true)); s.once('timeout', () => done(false, 'Timed out')); s.once('error', e => done(false, e.code));
  });
}
