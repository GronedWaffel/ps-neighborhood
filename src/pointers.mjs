import { randomUUID } from 'node:crypto';
import { setImmediate as breathe } from 'node:timers/promises';
import { address, hex, integer } from './protocol.mjs';

// Reverse pointer search over an immutable RAM capture. Each pass indexes the
// previous pass's target addresses; no quadratic all-pointers/all-targets loop.
export class PointerSearch {
  constructor(dumps) { this.dumps = dumps; this.job = null; this.rows = []; }
  status() { if (!this.job) return null; return { ...this.job, count: this.rows.length }; }
  cancel() { if (this.job?.state === 'running') this.job.cancelled = true; return this.status(); }
  start(options) {
    if (this.job?.state === 'running') throw new Error('A pointer search is already running');
    const job = { id: randomUUID(), state: 'running', depth: 0, processed: 0, total: 0, truncated: false }; this.job = job; this.rows = [];
    this.running = this.run(options, job).then(() => { job.state = 'complete'; }).catch(e => { job.state = job.cancelled ? 'cancelled' : 'failed'; job.error = e.message; }); return this.status();
  }
  async run({ dumpId, target, maxDepth = 3, maxOffset = 4096, maxResults = 10000, alignment = 8, moduleName }, job) {
    integer(maxDepth, 1, 5, 'Depth'); integer(maxOffset, 0, 1048576, 'Maximum offset'); integer(maxResults, 1, 50000, 'Maximum results'); integer(alignment, 1, 8, 'Alignment');
    const m = await this.dumps.manifest(dumpId); const total = m.segments.reduce((n, s) => n + s.length, 0);
    if (total > 512 * 1048576) throw new Error('Pointer searches are limited to 512 MiB captures; export a smaller subset');
    const destination = address(target); let frontier = [{ target: destination, offsets: [], addresses: [hex(destination)] }];
    job.total = total * maxDepth; job.dumpId = dumpId; job.target = hex(destination); let generated = 0;
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      job.depth = depth; frontier.sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0); const next = [];
      for (const region of m.segments) {
        const lo = address(region.start);
        for (let offset = 0; offset < region.length; offset += 256 * 1024) {
          if (job.cancelled) throw new Error('Pointer search cancelled');
          const span = Math.min(256 * 1024, region.length - offset), length = Math.min(span + 7, region.length - offset), start = lo + BigInt(offset);
          const data = await this.dumps.read(dumpId, hex(start), length);
          const first = Number((BigInt(alignment) - start % BigInt(alignment)) % BigInt(alignment));
          for (let i = first; i < span && i + 8 <= data.length; i += alignment) {
            if (i % 8192 === first) { await breathe(); if (job.cancelled) throw new Error('Pointer search cancelled'); }
            const ptr = data.readBigUInt64LE(i); if (ptr === 0n) continue;
            let left = 0, right = frontier.length;
            while (left < right) { const mid = (left + right) >>> 1; if (frontier[mid].target < ptr) left = mid + 1; else right = mid; }
            const at = hex(start + BigInt(i));
            for (let j = left; j < frontier.length && frontier[j].target <= ptr + BigInt(maxOffset); j++) {
              const parent = frontier[j]; if (parent.addresses.includes(at)) continue;
              const offsets = [hex(parent.target - ptr), ...parent.offsets], addresses = [at, ...parent.addresses];
              next.push({ target: address(at), offsets, addresses });
              if (!moduleName || region.name.includes(moduleName)) this.rows.push({ base: at, offsets, depth, module: region.name, regionStart: region.start, regionOffset: hex(address(at) - lo), target: hex(destination) });
              // Limit all intermediate paths, not just displayed roots, to bound combinatorial growth.
              if (++generated >= maxResults) { job.truncated = true; job.note = 'Path budget reached; narrow the offset, depth or captured regions. Results are incomplete.'; return; }
            }
          }
          job.processed += span;
        }
      }
      frontier = next;
    }
    job.note = 'Candidates are valid only in this capture. Re-resolve against another capture or live session before using a trainer.';
  }
  results(offset = 0, limit = 100) {
    integer(offset, 0, 50000, 'Offset'); integer(limit, 1, 1000, 'Limit');
    return { ...this.status(), offset, rows: this.rows.slice(offset, offset + limit) };
  }
}
