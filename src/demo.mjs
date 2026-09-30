import { address, hex } from './protocol.mjs';

export class DemoConsole {
  constructor() {
    this.connected = true; this.memory = Buffer.alloc(2 * 1024 * 1024); this.base = 0x100000000n;
    for (let i = 0; i < this.memory.length; i += 4) this.memory.writeUInt32LE((i * 13) % 10007, i);
    this.memory.writeUInt32LE(100, 0x100); this.memory.writeFloatLE(100, 0x104);
    this.memory.writeUInt32LE(30, 0x108); this.memory.write('PS NEIGHBORHOOD // MEMORY LAB', 0x120);
    this.memory.writeBigUInt64LE(this.base + 0x100n, 0x200);
    Buffer.from('488b05deadbeef4885c0', 'hex').copy(this.memory, 0x400);
  }
  async processes() { return [{ pid: 100, name: 'SceShellCore [simulation]' }, { pid: 1337, name: 'eboot.bin [memory lab]' }]; }
  async maps(pid) { this.validate(pid); return [
    { name: 'eboot.bin · lab memory', start: hex(this.base), end: hex(this.base + BigInt(this.memory.length)), offset: '0x0', prot: 3, permissions: 'rw-' }
  ]; }
  validate(pid) { if (!this.connected) throw new Error('Disconnected'); if (![100, 1337].includes(pid)) throw new Error('Process not found'); }
  async info(pid) { this.validate(pid); return { pid, name: 'eboot.bin', titleId: 'DEMO00001', path: '/app0/eboot.bin', contentId: 'SIMULATED CONSOLE' }; }
  range(pid, a, length) { this.validate(pid); const o = Number(address(a) - this.base); if (o < 0 || o + length > this.memory.length) throw new Error('Unmapped memory'); return o; }
  async read(pid, a, length) { const o = this.range(pid, a, length); return Buffer.from(this.memory.subarray(o, o + length)); }
  async writeMemory(pid, a, data) { data.copy(this.memory, this.range(pid, a, data.length)); }
  tick() { this.memory.writeUInt32LE(Math.max(0, this.memory.readUInt32LE(0x100) - 7), 0x100); this.memory.writeUInt32LE(this.memory.readUInt32LE(0x108) + 1, 0x108); }
  close() { this.connected = false; }
}
