import { mkdir, open, writeFile, rename, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { address, hex, integer } from './protocol.mjs';

function ghidraScript(manifest) {
  const segments = manifest.segments.map(s => `        load(program, folder, ${JSON.stringify(s.file)}, ${JSON.stringify(s.name.replace(/[^a-zA-Z0-9_.-]/g, '_'))}, ${JSON.stringify(s.start.slice(2))}, ${s.length}L, ${!!(s.prot & 2)}, ${!!(s.prot & 4)});`).join('\n');
  return `// Import a PS Neighbourhood memory snapshot into a NEW x86-64 program.
// @category PS Neighbourhood
import java.io.*;
import ghidra.app.script.GhidraScript;
import ghidra.program.database.ProgramDB;
import ghidra.program.model.lang.*;
import ghidra.program.model.mem.MemoryBlock;

public class ImportPSNeighbourhood extends GhidraScript {
    public void run() throws Exception {
        File folder = askDirectory("Select this dump bundle folder", "Import");
        Language language = getLanguage(new LanguageID("x86:LE:64:default"));
        ProgramDB program = new ProgramDB(${JSON.stringify('PSN_' + manifest.id)}, language, language.getCompilerSpecByID(new CompilerSpecID("gcc")), this);
        try {
            int tx = program.startTransaction("Import PS4 RAM");
            boolean success = false;
            try {
${segments}
                success = true;
            } finally { program.endTransaction(tx, success); }
            openProgram(program);
            println("RAM layout restored. Save this program, then run Auto Analyze. Capture is sequential, not an atomic snapshot.");
        } finally { program.release(this); }
    }
    private void load(ProgramDB p, File folder, String file, String name, String start, long size, boolean write, boolean execute) throws Exception {
        monitor.checkCancelled();
        File source = new File(folder, file);
        if (source.length() != size) throw new IOException("Incorrect file size: " + file);
        try (InputStream stream = new FileInputStream(source)) {
            MemoryBlock block = p.getMemory().createInitializedBlock(name + "_" + start, p.getAddressFactory().getDefaultAddressSpace().getAddress(start), stream, size, monitor, false);
            block.setRead(true); block.setWrite(write); block.setExecute(execute);
            block.setComment("PS Neighbourhood RAM snapshot; source " + file);
        }
    }
}
`;
}
export class Dumps {
  constructor(directory) { this.directory = directory; this.job = null; }
  status() { return this.job ? { ...this.job } : null; }
  cancel() { if (this.job?.state === 'running') this.job.cancelled = true; return this.status(); }
  start(client, options, context) {
    if (this.job?.state === 'running') throw new Error('A dump is already running');
    const job = { id: randomUUID(), state: 'running', processed: 0, total: 0, started: Date.now() }; this.job = job;
    this.running = this.run(client, options, context, job).then(result => Object.assign(job, { state: 'complete', ...result, elapsedMs: Date.now() - job.started })).catch(e => Object.assign(job, { state: job.cancelled ? 'cancelled' : 'failed', error: e.message }));
    return { ...job };
  }
  async run(client, options, context, job) {
    integer(options.pid, 1, 0xffffffff, 'PID');
    const maps = await client.maps(options.pid);
    const processInfo = client.info ? await client.info(options.pid) : null;
    let regions;
    if (options.start && options.end) {
      const lo = address(options.start), hi = address(options.end);
      if (hi <= lo) throw new Error('Range end must exceed start');
      regions = maps.filter(m => (m.prot & 1) && address(m.end) > lo && address(m.start) < hi).map(m => ({ ...m, start: hex(address(m.start) < lo ? lo : address(m.start)), end: hex(address(m.end) > hi ? hi : address(m.end)) }));
    } else {
      if (!options.regionStarts?.length) throw new Error('Choose mapped regions or provide start and end addresses');
      const selected = new Set(options.regionStarts.map(s => hex(address(s))));
      regions = maps.filter(m => selected.has(hex(address(m.start))));
      if (regions.length !== selected.size || regions.some(m => !(m.prot & 1))) throw new Error('A selected region is absent or unreadable');
    }
    if (!regions.length) throw new Error('No readable memory in this range');
    regions.sort((a, b) => address(a.start) < address(b.start) ? -1 : 1);
    const total = regions.reduce((n, r) => n + address(r.end) - address(r.start), 0n);
    if (total > 4n * 1024n ** 3n) throw new Error('Limit each dump to 4 GiB; export additional regions separately');
    job.total = Number(total);
    const folder = path.join(this.directory, job.id); await mkdir(folder, { recursive: true }); job.folder = folder;
    const manifest = { format: 'ps-neighbourhood-memory-v1', id: job.id, created: new Date().toISOString(), ...context, pid: options.pid, process: processInfo, architecture: 'x86:LE:64:default', byteOrder: 'little', consistency: 'Sequential live reads; process is not paused. Memory can change during capture.', requestedRange: options.start ? { start: options.start, end: options.end } : null, maps, segments: [] };
    try {
      for (let index = 0; index < regions.length; index++) {
        const region = regions[index], lo = address(region.start), length = Number(address(region.end) - lo);
        const file = `${String(index).padStart(3, '0')}_${lo.toString(16)}.bin`, dest = path.join(folder, file);
        const handle = await open(dest + '.partial', 'wx'), sha = createHash('sha256'); const pages = [];
        try {
          for (let offset = 0; offset < length; offset += 256 * 1024) {
            if (job.cancelled) throw new Error('Dump cancelled');
            const data = await client.read(options.pid, hex(lo + BigInt(offset)), Math.min(256 * 1024, length - offset));
            if (data.length !== Math.min(256 * 1024, length - offset)) throw new Error('Short read during dump');
            await handle.writeFile(data); sha.update(data);
            for (let p = 0; p < data.length; p += 4096) pages.push(createHash('sha256').update(data.subarray(p, p + 4096)).digest('hex'));
            job.processed += data.length;
          }
          await handle.sync();
        } finally { await handle.close(); }
        await rename(dest + '.partial', dest);
        manifest.segments.push({ ...region, file, length, sha256: sha.digest('hex'), pageSize: 4096, pages });
      }
      // A bundle is complete only when the manifest has been atomically committed.
      manifest.completed = new Date().toISOString();
      await writeFile(path.join(folder, 'ImportPSNeighbourhood.java'), ghidraScript(manifest));
      await writeFile(path.join(folder, 'README.txt'), 'PS Neighbourhood RAM bundle\n\nAdd this folder to Ghidra Script Manager script directories, then run ImportPSNeighbourhood.java. Select this folder when prompted. The script creates a new x86-64 program with original virtual addresses and RWX permissions. Save it, then Auto Analyze. Verify file SHA-256 hashes against manifest.json if transporting the bundle.\n\nThese are raw mapped-memory images, not reconstructed ELF/SELF executables. Gaps are omitted and listed in the original maps. ASLR addresses apply to this capture. Reads are sequential and not atomic.\n');
      await writeFile(path.join(folder, 'manifest.json.partial'), JSON.stringify(manifest, null, 2));
      await rename(path.join(folder, 'manifest.json.partial'), path.join(folder, 'manifest.json'));
      return { folder, manifestPath: path.join(folder, 'manifest.json'), segments: manifest.segments.length, bytes: job.total };
    } catch (e) {
      await writeFile(path.join(folder, 'INCOMPLETE.json'), JSON.stringify({ error: e.message, processed: job.processed, manifest }, null, 2)); throw e;
    }
  }
  async manifest(id) {
    if (!/^[\da-f-]{36}$/i.test(id)) throw new Error('Invalid dump ID');
    return JSON.parse(await readFile(path.join(this.directory, id, 'manifest.json'), 'utf8'));
  }
  async list() {
    await mkdir(this.directory, { recursive: true }); const results = [];
    for (const name of await readdir(this.directory)) {
      try { const m = await this.manifest(name); results.push({ id: m.id, pid: m.pid, created: m.created, mode: m.mode, bytes: m.segments.reduce((n, s) => n + s.length, 0), folder: path.join(this.directory, name) }); } catch {}
    }
    return results.sort((a, b) => b.created.localeCompare(a.created));
  }
  async compare(a, b, limit = 1000) {
    integer(limit, 1, 10000, 'Result limit');
    const before = await this.manifest(a), after = await this.manifest(b);
    const changes = []; let changedPages = 0, added = 0, removed = 0;
    const index = new Map();
    for (const s of before.segments) for (let i = 0; i < s.pages.length; i++) index.set(hex(address(s.start) + BigInt(i * s.pageSize)), s.pages[i]);
    for (const s of after.segments) for (let i = 0; i < s.pages.length; i++) {
      const addr = hex(address(s.start) + BigInt(i * s.pageSize)), old = index.get(addr), state = old === undefined ? 'added' : old !== s.pages[i] ? 'changed' : null;
      if (state) { state === 'added' ? added++ : changedPages++; if (changes.length < limit) changes.push({ address: addr, state, size: Math.min(s.pageSize, s.length - i * s.pageSize) }); }
      index.delete(addr);
    }
    removed = index.size;
    for (const addr of index.keys()) if (changes.length < limit) changes.push({ address: addr, state: 'removed' });
    return { before: a, after: b, comparison: 'Absolute virtual addresses and page hashes; ASLR relocation is not normalized.', changedPages, addedPages: added, removedPages: removed, truncated: changedPages + added + removed > limit, changes };
  }
  async read(id, addr, length) {
    integer(length, 1, 1024 * 1024, 'Length'); const a = address(addr), m = await this.manifest(id);
    const segment = m.segments.find(s => a >= address(s.start) && a + BigInt(length) <= address(s.end));
    if (!segment) throw new Error('Read must fit inside one captured segment');
    const f = await open(path.join(this.directory, id, segment.file), 'r');
    try { const data = Buffer.alloc(length); const r = await f.read(data, 0, length, Number(a - address(segment.start))); if (r.bytesRead !== length) throw new Error('Truncated dump file'); return data; } finally { await f.close(); }
  }
}
