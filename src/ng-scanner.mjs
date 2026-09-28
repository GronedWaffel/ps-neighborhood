// Independently implemented PS4Debug-NG numeric scan wire transport.
// Command layouts/status ordering were checked against the supplied NG payload.
const SUCCESS = 0x80000000, END = 0xffffffffffffffffn;
const ids = { u8: 0, i8: 1, u16: 2, i16: 3, u32: 4, i32: 5, u64: 6, i64: 7 };
const compares = { exact: 0, greater: 2, less: 3, between: 4, increased: 5, decreased: 7, changed: 9, unchanged: 10, unknown: 11 };
const word = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

export function challengeResponse(challenge) {
  let a = 200, b = 300, c = 400, d = 500;
  return Buffer.from(challenge.map(byte => {
    a = ((a << 18) & 0xfff80000) ^ ((a ^ (a << 6)) >>> 13);
    b = ((b << 2) & 0xffffffe0) ^ ((b ^ (b << 2)) >>> 27);
    c = ((c << 7) & 0xfffff800) ^ ((c ^ (c << 13)) >>> 21);
    d = ((d << 13) & 0xfff00000) ^ ((d ^ (d << 3)) >>> 12);
    return byte ^ ((a ^ b ^ c ^ d) & 255);
  }));
}

export function nativeSpec(type, mode, value, value2) {
  if (!Object.hasOwn(ids, type) || !Object.hasOwn(compares, mode)) throw new Error('Unsupported NG numeric scan');
  const width = Number(type.slice(1)) / 8;
  const seed = Buffer.alloc(['exact', 'greater', 'less', 'between'].includes(mode) ? width * (mode === 'between' ? 2 : 1) : 0);
  for (let o = 0; o < seed.length; o += width) {
    const v = o ? value2 : value;
    if (width === 8) seed[type[0] === 'i' ? 'writeBigInt64LE' : 'writeBigUInt64LE'](BigInt(v), o);
    else seed[type[0] === 'i' ? 'writeIntLE' : 'writeUIntLE'](Number(v), o, width);
  }
  return { typeId: ids[type], compareId: compares[mode], width, seed, previous: ['increased', 'decreased', 'changed', 'unchanged'].includes(mode) };
}

export class NGScanner {
  constructor(client) { this.client = client; this.authenticated = false; }
  async authenticate() {
    if (this.authenticated) return;
    const c = this.client;
    await c.send(0xbdaaccff, Buffer.concat([word(0xbb40e64d), word(2)])); await c.status();
    const length = (await c.receive(2)).readUInt16LE();
    if (length !== 64) throw new Error('Unexpected NG challenge length');
    await c.write(challengeResponse(await c.receive(length))); await c.status(); this.authenticated = true;
  }
  async frames(spec, maxRecords, onRecord, optionalStatus = false) {
    const c = this.client, size = spec.width + 4; let count = 0, first = true;
    while (true) {
      let low = (await c.receive(4)).readUInt32LE();
      // Some NG releases send a second allocation-success status before frames.
      if (first && optionalStatus && low === SUCCESS) low = (await c.receive(4)).readUInt32LE();
      first = false;
      const high = (await c.receive(4)).readUInt32LE(), length = (BigInt(high) << 32n) | BigInt(low);
      if (length === END) return;
      if (length === 0n || length > 0x20000n || length % BigInt(size)) throw new Error('Invalid NG result frame length');
      count += Number(length) / size;
      if (count > maxRecords) throw new Error('NG returned too many scan records');
      const frame = await c.receive(Number(length));
      for (let o = 0; o < frame.length; o += size) onRecord(frame.readUInt32LE(o), frame.subarray(o + 4, o + size));
    }
  }
  start({ pid, base, length, spec, onRecord }) {
    const c = this.client;
    c.packet(pid, base, length);
    if (length % spec.width || BigInt(base) % BigInt(spec.width) || spec.previous) throw new Error('NG initial scan requires naturally aligned whole values');
    return c.transaction(async () => {
      await this.authenticate();
      const body = Buffer.alloc(23);
      body.writeUInt32LE(pid); body.writeBigUInt64LE(BigInt(base), 4); body.writeUInt32LE(length, 12);
      body[16] = spec.typeId; body[17] = spec.compareId; body[18] = spec.width; body.writeUInt32LE(spec.seed.length, 19);
      await c.send(0xbdaacc01, body); await c.status(); if (spec.seed.length) await c.write(spec.seed);
      await this.frames(spec, length / spec.width, onRecord, true); await c.status();
    });
  }
  refine({ pid, base, spec, entries, onRecord, cancelled = () => false }) {
    const c = this.client;
    c.packet(pid, base, spec.width);
    return c.transaction(async () => {
      await this.authenticate();
      const body = Buffer.alloc(18); body.writeUInt32LE(pid); body.writeBigUInt64LE(BigInt(base), 4);
      body[12] = spec.typeId; body[13] = spec.compareId; body.writeUInt32LE(spec.seed.length, 14);
      await c.send(0xbdaacc02, body); await c.status(); if (spec.seed.length) await c.write(spec.seed);
      const size = 4 + (spec.previous ? spec.width : 0), capacity = Math.floor(0x20000 / size) * size;
      let batch = Buffer.alloc(capacity), used = 0;
      const flush = async () => {
        await c.write(Buffer.concat([word(used), batch.subarray(0, used)]));
        await this.frames(spec, used / size, onRecord); used = 0;
      };
      for (const { offset, value } of entries) {
        if (cancelled()) break;
        batch.writeUInt32LE(offset, used);
        if (spec.previous) { if (value.length !== spec.width) throw new Error('Invalid previous NG value'); value.copy(batch, used + 4); }
        used += size;
        if (used === capacity) await flush();
      }
      if (used && !cancelled()) await flush();
      // Finish/drain the current bounded command on cancellation, preserving TCP framing.
      await c.write(word(0xffffffff)); await c.status();
    });
  }
}
