import { open, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as breathe } from 'node:timers/promises';
import { address, hex, integer } from './protocol.mjs';
import { nativeSpec } from './ng-scanner.mjs';

export const types = {
  u8: [1, 'readUInt8'], i8: [1, 'readInt8'], u16: [2, 'readUInt16LE'], i16: [2, 'readInt16LE'],
  u32: [4, 'readUInt32LE'], i32: [4, 'readInt32LE'], u64: [8, 'readBigUInt64LE'], i64: [8, 'readBigInt64LE'],
  f32: [4, 'readFloatLE'], f64: [8, 'readDoubleLE']
};
export function matcher(type, mode, value, value2, epsilon = 0) {
  if (type === 'aob' || type === 'text') {
    if (mode !== 'exact') throw new Error('Patterns and text support exact searches');
    const tokens = type === 'text' ? [...Buffer.from(String(value), 'utf8')].map(x => x.toString(16).padStart(2, '0')) : String(value).trim().split(/\s+/);
    if (!tokens.length || tokens.length > 1024 || tokens.some(t => !/^[\da-f?]{2}$/i.test(t))) throw new Error('Use byte pairs and wildcards: 48 8B ?? A?');
    const masks = tokens.map(t => [...t].reduce((v, c) => (v << 4) | (c === '?' ? 0 : 15), 0));
    const values = tokens.map(t => parseInt(t.replace(/\?/g, '0'), 16));
    return { width: tokens.length, read: (b, o) => b.subarray(o, o + tokens.length).toString('hex'), test: (b, o) => values.every((v, i) => (b[o + i] & masks[i]) === v) };
  }
  if (!Object.hasOwn(types, type)) throw new Error('Unknown value type');
  const [width, method] = types[type], read = (b, o) => b[method](o);
  const big = type.endsWith('64') && !type.startsWith('f');
  const parse = v => {
    if (String(v ?? '').trim() === '') throw new Error('Enter a scan value');
    const n = big ? BigInt(v) : Number(v);
    if (!big && !Number.isFinite(n)) throw new Error('Scan value must be finite');
    if (!type.startsWith('f')) {
      const bits = BigInt(width * 8), signed = type.startsWith('i');
      if (!big && !Number.isInteger(n)) throw new Error('Integer scan requires an integer');
      const bn = BigInt(n), min = signed ? -(1n << (bits - 1n)) : 0n, max = (1n << (signed ? bits - 1n : bits)) - 1n;
      if (bn < min || bn > max) throw new Error(`Value outside ${type} range`);
    }
    return type === 'f32' ? Math.fround(n) : n;
  };
  const relative = ['changed', 'unchanged', 'increased', 'decreased'];
  const modes = ['exact', 'unknown', 'greater', 'less', 'between', ...relative];
  if (!modes.includes(mode)) throw new Error('Invalid scan comparison');
  const target = mode === 'unknown' || relative.includes(mode) ? null : parse(value);
  const upper = mode === 'between' ? parse(value2) : null;
  if (upper !== null && upper < target) throw new Error('Upper value must be at least the lower value');
  if (!Number.isFinite(epsilon) || epsilon < 0) throw new Error('Epsilon must be non-negative');
  return { width, read, relative: relative.includes(mode), test(b, o, old) {
    const v = read(b, o), before = old ? read(old, o) : null;
    switch (mode) {
      case 'unknown': return true;
      case 'exact': return type.startsWith('f') ? Math.abs(v - target) <= epsilon : v === target;
      case 'greater': return v > target;
      case 'less': return v < target;
      case 'between': return v >= target && v <= upper;
      case 'changed': return !b.subarray(o, o + width).equals(old.subarray(o, o + width));
      case 'unchanged': return b.subarray(o, o + width).equals(old.subarray(o, o + width));
      case 'increased': return v > before;
      case 'decreased': return v < before;
    }
  } };
}

// Snapshots and candidate bitmaps live on disk. Memory use is bounded by chunk size,
// independent of how many matches an unknown-value scan produces.
export class Scanner {
  constructor(directory, { chunkSize = 256 * 1024, maxBytes = 512 * 1024 * 1024 } = {}) {
    this.directory = directory; this.chunkSize = chunkSize; this.maxBytes = maxBytes;
    this.sessions = new Map(); this.job = null;
  }
  status() { return this.job ? { ...this.job } : null; }
  cancel() { if (this.job?.state === 'running') this.job.cancelled = true; return this.status(); }
  start(client, options) {
    if (this.job?.state === 'running') throw new Error('A scan is already running');
    const job = { id: randomUUID(), state: 'running', phase: 'Preparing', processed: 0, total: 0, matches: 0, started: Date.now() };
    this.job = job;
    this.running = this.run(client, options, job).then(s => { job.sessionId = s.id; job.state = 'complete'; job.phase = 'Complete'; job.elapsedMs = Date.now() - job.started; }).catch(e => { job.state = job.cancelled ? 'cancelled' : 'failed'; job.error = e.message; });
    return { ...job };
  }
  async run(client, options, job) {
    const previous = options.sessionId ? this.sessions.get(options.sessionId) : null;
    if (options.sessionId && !previous) throw new Error('Scan session expired. Start a new scan.');
    const type = previous?.type ?? options.type ?? 'u32';
    const m = matcher(type, options.mode ?? 'exact', options.value, options.value2, options.epsilon ?? 0);
    if (m.relative && !previous) throw new Error('This comparison needs an initial scan');
    if (previous && m.width !== previous.width) throw new Error('Keep the pattern width unchanged when refining');
    if (previous && previous.connectionId !== options.connectionId) throw new Error('Console connection changed. Start a new scan.');
    const pid = previous?.pid ?? integer(options.pid, 1, 0xffffffff, 'PID');
    const alignment = previous?.alignment ?? integer(options.alignment ?? (type==='aob'||type==='text'?1:m.width), 1, 64, 'Alignment');
    const requestedBackend = options.backend ?? previous?.requestedBackend ?? 'auto';
    if (!['auto', 'host', 'ng'].includes(requestedBackend)) throw new Error('Scan backend must be auto, host, or ng');
    const nativeReason = !client.capabilities?.nativeScan ? 'NG unavailable on this source' : !/^[ui](8|16|32|64)$/.test(type) ? 'Host preserves float, text and wildcard semantics' : alignment !== m.width ? 'Host preserves custom alignment' : null;
    if (requestedBackend === 'ng' && nativeReason) throw new Error(`NG scan unavailable: ${nativeReason}`);
    const native = requestedBackend !== 'host' && !nativeReason;
    const spec = native ? nativeSpec(type, options.mode ?? 'exact', options.value, options.value2) : null;
    job.backend = native ? 'ng' : 'host'; job.backendReason = native ? 'NG numeric scan; bounded host reads for refinement tails' : requestedBackend === 'host' ? 'Host engine selected' : nativeReason;
    job.nativeCommands = 0; job.hostReads = 0;
    const id = previous?.id ?? randomUUID(), pass = (previous?.pass ?? 0) + 1;
    let chunks = previous?.chunks;
    if (!chunks) {
      const maps = await client.maps(pid);
      const start = options.start ? address(options.start) : null, end = options.end ? address(options.end) : null;
      if (start !== null && end !== null && end <= start) throw new Error('Range end must exceed start');
      chunks = []; let total = 0;
      for (const region of maps) {
        if (!(region.prot & 1) || (options.writableOnly !== false && !(region.prot & 2))) continue;
        let lo = address(region.start), hi = address(region.end);
        if (start !== null && start > lo) lo = start;
        if (end !== null && end < hi) hi = end;
        if (hi <= lo || hi - lo < BigInt(m.width)) continue;
        total += Number(hi - lo);
        if (total > this.maxBytes) throw new Error(`Selected memory exceeds ${this.maxBytes / 1048576} MiB. Select a smaller address range.`);
        for (let a = lo; a < hi; a += BigInt(this.chunkSize)) {
          const span = Number(hi - a > BigInt(this.chunkSize) ? BigInt(this.chunkSize) : hi - a);
          const length = Number(hi - a > BigInt(span + m.width - 1) ? BigInt(span + m.width - 1) : hi - a);
          const first = Number((BigInt(alignment) - a % BigInt(alignment)) % BigInt(alignment));
          chunks.push({ address: hex(a), length, span, first, slots: Math.max(0, Math.ceil((Math.min(span, length - m.width + 1) - first) / alignment)) });
        }
      }
      if (!chunks.length) throw new Error('No readable memory matches the selected range and permissions');
    }
    job.total = chunks.reduce((n, c) => n + c.span, 0); job.phase = previous ? 'Refining candidates' : 'Reading memory';
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, `${id}-${pass}.snapshot`);
    const output = await open(file, 'wx'); let input;
    let committed = false;
    try {
      if (previous) input = await open(previous.file, 'r');
      let position = 0; const nextChunks = [];
      for (const chunk of chunks) {
        if (job.cancelled) throw new Error('Scan cancelled');
        let before, oldBits;
        if (input) {
          before = Buffer.alloc(chunk.length); oldBits = Buffer.alloc(Math.ceil(chunk.slots / 8));
          await input.read(before, 0, before.length, chunk.position);
          await input.read(oldBits, 0, oldBits.length, chunk.position + chunk.length);
        }
        // Empty candidate chunks need no further network traffic.
        const active = !oldBits || oldBits.some(v => v !== 0);
        let current;
        const bits = Buffer.alloc(Math.ceil(chunk.slots / 8));
        if (native && active && chunk.slots) {
          current = Buffer.alloc(chunk.length);
          let lastOffset = -1;
          const accept = (o, data) => {
            const i = (o - chunk.first) / alignment;
            if (!Number.isInteger(i) || i < 0 || i >= chunk.slots || o <= lastOffset || (oldBits && (o > chunk.length - 32768 || !(oldBits[i >> 3] & (1 << (i & 7)))))) throw new Error('NG returned an invalid, duplicate or unsolicited candidate');
            lastOffset = o;
            data.copy(current, o);
            if (m.test(current, o, before)) { bits[i >> 3] |= 1 << (i & 7); job.matches++; }
          };
          if (!oldBits) {
            await client.ng.start({ pid, base: address(chunk.address) + BigInt(chunk.first), length: chunk.slots * alignment, spec, onRecord: (o, data) => accept(o + chunk.first, data) });
            job.nativeCommands++;
          } else {
            // NG COUNT starts each batch with a 32 KiB read. Keep every possible
            // window inside this selected chunk; read the tail via classic READ.
            const limit = chunk.length - 32768;
            const candidate = i => oldBits[i >> 3] & (1 << (i & 7));
            function* entries() {
              for (let i = 0; i < chunk.slots; i++) {
                const o = chunk.first + i * alignment;
                if (o > limit) break;
                if (candidate(i)) yield { offset: o, value: before.subarray(o, o + m.width) };
              }
            }
            if (!entries().next().done) {
              await client.ng.refine({ pid, base: chunk.address, spec, entries: entries(), onRecord: accept, cancelled: () => job.cancelled });
              job.nativeCommands++;
            }
            if (job.cancelled) throw new Error('Scan cancelled');
            let tailStart = -1;
            for (let i = 0; i < chunk.slots; i++) {
              const o = chunk.first + i * alignment;
              if (o > limit && candidate(i)) { tailStart = o; break; }
            }
            if (tailStart >= 0) {
              const tail = await client.read(pid, address(chunk.address) + BigInt(tailStart), chunk.length - tailStart);
              if (tail.length !== chunk.length - tailStart) throw new Error('Incomplete memory read');
              tail.copy(current, tailStart); job.hostReads++;
              for (let i = (tailStart - chunk.first) / alignment; i < chunk.slots; i++) {
                const o = chunk.first + i * alignment;
                if (candidate(i) && m.test(current, o, before)) { bits[i >> 3] |= 1 << (i & 7); job.matches++; }
              }
            }
          }
          job.backend = job.nativeCommands ? job.hostReads ? 'hybrid' : 'ng' : 'host';
        } else {
          current = active ? await client.read(pid, chunk.address, chunk.length) : before;
          if (active) job.hostReads++;
        }
        if (current.length !== chunk.length) throw new Error('Incomplete memory read');
        if (active && !native) for (let i = 0; i < chunk.slots; i++) {
          if (i % 32768 === 0) { await breathe(); if (job.cancelled) throw new Error('Scan cancelled'); }
          if (oldBits && !(oldBits[i >> 3] & (1 << (i & 7)))) continue;
          const o = chunk.first + i * alignment;
          if (m.test(current, o, before)) { bits[i >> 3] |= 1 << (i & 7); job.matches++; }
        }
        nextChunks.push({ ...chunk, position });
        await output.writeFile(current); await output.writeFile(bits); position += current.length + bits.length;
        job.processed += chunk.span;
        await breathe();
      }
      if (job.cancelled) throw new Error('Scan cancelled');
      const session = { id, pass, pid, type, width: m.width, alignment, file, chunks: nextChunks, count: job.matches, backend: job.backend, requestedBackend, connectionId: options.connectionId, created: new Date().toISOString() };
      this.sessions.set(id, session); committed = true;
      return session;
    } finally {
      await output.close(); await input?.close();
      if (!committed) await unlink(file).catch(() => {});
      if (committed && previous) await unlink(previous.file).catch(() => {});
    }
  }
  async results(id, offset = 0, limit = 100) {
    integer(offset, 0, 1e9, 'Offset'); integer(limit, 1, 1000, 'Limit');
    const s = this.sessions.get(id); if (!s) throw new Error('Scan session not found');
    if (this.job?.state === 'running') throw new Error('Wait for the current scan before paging results');
    const rows = [], f = await open(s.file, 'r'); let seen = 0;
    try {
      for (const chunk of s.chunks) {
        const bits = Buffer.alloc(Math.ceil(chunk.slots / 8)); await f.read(bits, 0, bits.length, chunk.position + chunk.length);
        let data;
        for (let i = 0; i < chunk.slots; i++) {
          if (!(bits[i >> 3] & (1 << (i & 7)))) continue;
          if (seen++ < offset) continue;
          if (!data) { data = Buffer.alloc(chunk.length); await f.read(data, 0, data.length, chunk.position); }
          const o = chunk.first + i * s.alignment;
          const value = types[s.type] ? String(data[types[s.type][1]](o)) : data.subarray(o, o + s.width).toString('hex');
          rows.push({ address: hex(address(chunk.address) + BigInt(o)), value, hex: data.subarray(o, o + s.width).toString('hex') });
          if (rows.length >= limit) break;
        }
        if (rows.length >= limit) break;
        await breathe();
      }
    } finally { await f.close(); }
    return { sessionId: id, pid: s.pid, type: s.type, pass: s.pass, count: s.count, backend: s.backend, offset, rows };
  }
  async clear() {
    this.cancel(); await this.running;
    for (const s of this.sessions.values()) await unlink(s.file).catch(() => {});
    this.sessions.clear(); this.job = null;
  }
}
