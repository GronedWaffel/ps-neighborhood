import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, stat, open, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { Client as FtpClient } from 'basic-ftp';
import { PS4Debug, probe, address, hex, bytes, integer } from './protocol.mjs';
import { Scanner, types } from './scanner.mjs';
import { Dumps } from './dumps.mjs';
import { DemoConsole } from './demo.mjs';
import { PointerSearch } from './pointers.mjs';
import { PackageInstaller, inspectPackage } from './packages.mjs';
import { ConsoleManager } from './console-manager.mjs';
import {firmwareProfile} from './firmware.mjs';

export class Workbench extends EventEmitter {
  constructor(directory) {
    super(); this.directory = directory; this.client = null; this.mode = 'disconnected'; this.connectionId = randomUUID();
    this.profile = { host: '127.0.0.1', debugPort: 744, ftpPort: 2121, payloadPort: 9090, firmware: 'auto' };
    this.scanner = new Scanner(path.join(directory, 'scans')); this.dumps = new Dumps(path.join(directory, 'exports'));
    this.pointers = new PointerSearch(this.dumps);
    this.packages = new PackageInstaller();
    this.console = new ConsoleManager({directory,profile:()=>this.profile,packages:this.packages,log:(action,detail)=>this.log(action,detail)});
    this.watches = []; this.activity = []; this.mcpWrites = false; this.transfer = null; this.controlTail = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    try { const saved = JSON.parse(await readFile(path.join(this.directory, 'workspace.json'), 'utf8')); this.profile = { ...this.profile, ...saved.profile }; this.watches = saved.watches || []; } catch {}
    return this;
  }
  async save() { await writeFile(path.join(this.directory, 'workspace.json'), JSON.stringify({ profile: this.profile, watches: this.watches }, null, 2)); }
  log(action, detail, source = 'desktop') {
    const entry = { time: new Date().toISOString(), action, detail, source }; this.activity.unshift(entry); this.activity.length = Math.min(200, this.activity.length);
    this.emit('activity', entry);
  }
  status() { return { mode: this.client?.connected ? this.mode : 'disconnected', capabilities: this.client?.capabilities ?? { nativeScan: false, reason: this.mode === 'demo' ? 'Simulated memory lab uses host scanning' : 'No NG payload detected' }, profile: this.profile, connectionId: this.connectionId, scan: this.scanner.status(), dump: this.dumps.status(), pointers: this.pointers.status(), transfer: this.transfer, mcpWrites: this.mcpWrites, activity: this.activity.slice(0, 40), watchCount: this.watches.length }; }
  requireClient() { if (!this.client?.connected) throw new Error('Connect to PS4Debug or open the memory lab first'); return this.client; }
  async setProfile(p) {
    this.console.guard();
    if(this.packages.server || this.packages.queue.processing)throw Error('Stop sharing packages before changing consoles');
    if (!net.isIP(p.host)) throw new Error('Console host must be an IP address');
    for (const k of ['debugPort', 'ftpPort', 'payloadPort']) integer(p[k], 1, 65535, k);
    if (this.client?.connected) throw new Error('Disconnect before editing the console profile');
    this.profile = { host: p.host, debugPort: p.debugPort, ftpPort: p.ftpPort, payloadPort: p.payloadPort, firmware: firmwareProfile(p.firmware??this.profile.firmware) }; await this.save(); return this.profile;
  }
  async connect(demo = false) {
    await this.disconnect(); const client = demo ? new DemoConsole() : await new PS4Debug({ host: this.profile.host, port: this.profile.debugPort }).connect();
    try { const processes = await client.processes(); if (!demo) await client.detectCapabilities(); this.client = client; this.mode = demo ? 'demo' : 'live'; this.connectionId = randomUUID(); this.log('Connected', demo ? 'Simulated memory lab' : this.profile.host); return { ...this.status(), processes }; }
    catch (e) { client.close(); throw e; }
  }
  async disconnect() {
    this.scanner.cancel(); this.dumps.cancel();
    this.client?.close(); await Promise.allSettled([this.scanner.running, this.dumps.running]);
    await this.scanner.clear(); this.client = null; this.mode = 'disconnected'; this.connectionId = randomUUID(); this.mcpWrites = false; return this.status();
  }
  async read({ pid, address: a, length = 256, dumpId }) {
    integer(pid ?? 1, 1, 0xffffffff, 'PID'); integer(length, 1, 1024 * 1024, 'Length'); address(a);
    const data = dumpId ? await this.dumps.read(dumpId, a, length) : await this.requireClient().read(pid, a, length);
    return { address: hex(address(a)), length, hex: data.toString('hex'), ascii: data.toString('latin1').replace(/[^\x20-\x7e]/g, '.'), source: dumpId || this.mode };
  }
  async readv({ pid, ranges }) {
    if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > 128) throw new Error('Provide 1–128 ranges');
    if (ranges.reduce((n, r) => n + integer(r.length, 1, 1048576, 'Length'), 0) > 1048576) throw new Error('Batched read limit is 1 MiB');
    const result = []; for (const r of ranges) result.push(await this.read({ pid, ...r })); return result;
  }
  async inspect({ pid, address: a, fields, dumpId }) {
    if (!Array.isArray(fields) || fields.length < 1 || fields.length > 64) throw new Error('Provide 1–64 structure fields');
    let length = 0;
    for (const f of fields) { integer(f.offset, 0, 65528, 'Field offset'); if (!Object.hasOwn(types, f.type)) throw new Error('Invalid field type'); length = Math.max(length, f.offset + types[f.type][0]); }
    const data = Buffer.from((await this.read({ pid, address: a, length, dumpId })).hex, 'hex');
    return fields.map(f => ({ ...f, address: hex(address(a) + BigInt(f.offset)), value: String(data[types[f.type][1]](f.offset)) }));
  }
  async strings({ pid, address: a, length = 4096, minLength = 4, encoding = 'ascii', dumpId }) {
    integer(minLength, 2, 128, 'Minimum length'); if (!['ascii', 'utf16le'].includes(encoding)) throw new Error('Use ascii or utf16le');
    const data = Buffer.from((await this.read({ pid, address: a, length, dumpId })).hex, 'hex'), step = encoding === 'utf16le' ? 2 : 1, rows = [];
    let begin = -1, text = '';
    for (let i = 0; i <= data.length; i += step) {
      const code = i + step <= data.length ? (step === 2 ? data.readUInt16LE(i) : data[i]) : 0;
      if (code >= 32 && code <= 126) { if (begin < 0) begin = i; text += String.fromCharCode(code); }
      else { if (text.length >= minLength) rows.push({ address: hex(address(a) + BigInt(begin)), text }); text = ''; begin = -1; }
      if (rows.length >= 1000) return { rows, truncated: true };
    }
    return { rows, truncated: false };
  }
  async pointer({ pid, base, offsets = [], dumpId }) {
    if (offsets.length > 16) throw new Error('Maximum pointer depth is 16'); let at = address(base); const hops = [];
    for (const offset of offsets) {
      const delta = BigInt(offset); if (delta < -0x7fffffffn || delta > 0x7fffffffn) throw new Error('Pointer offsets must fit signed 32-bit');
      const data = Buffer.from((await this.read({ pid, address: hex(at), length: 8, dumpId })).hex, 'hex');
      const pointer = data.readBigUInt64LE(); if (!pointer) throw new Error(`Null pointer at ${hex(at)}`);
      const next = address(pointer + delta); hops.push({ readAt: hex(at), pointer: hex(pointer), offset: String(offset), result: hex(next) }); at = next;
    }
    return { address: hex(at), hops, semantics: 'For each offset: address = read_u64(address) + offset' };
  }
  async write({ pid, address: a, expectedHex, hex: newHex }, source) {
    if (source === 'mcp' && !this.mcpWrites) throw new Error('MCP memory writes are disabled in the desktop');
    if (this.scanner.job?.state === 'running' || this.dumps.job?.state === 'running') throw new Error('Finish scans and dumps before writing');
    const data = bytes(newHex), expected = bytes(expectedHex);
    if (data.length !== expected.length || data.length > 4096) throw new Error('Expected bytes and replacement must have equal length, at most 4096 bytes');
    const c = this.requireClient(), current = await c.read(pid, a, data.length);
    if (!current.equals(expected)) throw new Error(`Memory changed; write refused. Current bytes: ${current.toString('hex')}`);
    await c.writeMemory(pid, a, data);
    const after = await c.read(pid, a, data.length), verified = after.equals(data);
    this.log('Memory write', `${pid} @ ${a} · ${data.length} bytes · ${verified ? 'verified' : 'verification mismatch'}`, source);
    return { verified, before: current.toString('hex'), after: after.toString('hex'), note: 'Compare and write is not atomic with a running process.' };
  }
  async watchAdd(o) {
    integer(o.pid, 1, 0xffffffff, 'PID'); address(o.address); if (!Object.hasOwn(types, o.type)) throw new Error('Unknown watch type');
    if (this.watches.length >= 128) throw new Error('Watch list is limited to 128 entries');
    const maps = await this.requireClient().maps(o.pid), region = maps.find(m => address(o.address) >= address(m.start) && address(o.address) < address(m.end));
    const watch = { id: randomUUID(), pid: o.pid, address: hex(address(o.address)), type: o.type, label: String(o.label || 'Untitled watch').slice(0, 80), host: this.profile.host, mode: this.mode, module: region?.name, regionStart: region?.start, regionOffset: region ? hex(address(o.address) - address(region.start)) : null };
    this.watches.push(watch); await this.save(); return watch;
  }
  async watchRead() {
    const rows = [];
    for (const w of this.watches) {
      try {
        if (w.mode !== this.mode || w.host !== this.profile.host) throw new Error('Different console/session mode');
        const b = await this.requireClient().read(w.pid, w.address, types[w.type][0]); rows.push({ ...w, value: String(b[types[w.type][1]]()), hex: b.toString('hex') });
      } catch (e) { rows.push({ ...w, error: e.message }); }
    }
    return rows;
  }
  async ftp(action, o = {}) {
    if (this.mode === 'demo') throw new Error('FTP requires the real console; leave memory lab first');
    const remote = String(o.remote || '/'); if (!remote.startsWith('/') || /[\r\n\0]/.test(remote)) throw new Error('Enter an absolute PS4 path');
    const ftp = new FtpClient(10000);
    try {
      await ftp.access({ host: this.profile.host, port: this.profile.ftpPort, user: 'anonymous', password: 'ps-neighbourhood', secure: false });
      if (action === 'list') return (await ftp.list(remote)).map(f => ({ name: f.name, size: f.size, directory: f.isDirectory, modified: f.modifiedAt?.toISOString() }));
      if (this.transfer?.state === 'running') throw new Error('A transfer is already running');
      this.transfer = { state: 'running', action, remote, bytes: 0 };
      ftp.trackProgress(info => { this.transfer.bytes = info.bytesOverall; });
      if (action === 'download') {
        const folder = path.join(this.directory, 'downloads'); await mkdir(folder, { recursive: true });
        const target = path.join(folder, `${randomUUID()}-${path.posix.basename(remote).replace(/[^\w.-]/g, '_')}`);
        await ftp.downloadTo(target + '.partial', remote); await rename(target + '.partial', target);
        this.transfer.local = target;
      } else if (action === 'upload') {
        if (!o.local || !(await stat(o.local)).isFile()) throw new Error('Choose a local file');
        if ((await ftp.list(path.posix.dirname(remote))).some(f => f.name === path.posix.basename(remote))) throw new Error('A remote file already exists at that path; choose another name');
        await ftp.uploadFrom(o.local, remote);
      } else throw new Error('Unknown FTP action');
      this.transfer.state = 'complete'; this.log('FTP ' + action, remote); return this.transfer;
    } catch (e) { if (this.transfer?.state === 'running') Object.assign(this.transfer, { state: 'failed', error: e.message }); throw e; }
    finally { ftp.close(); }
  }
  async payload({ local }) {
    if (this.mode === 'demo') throw new Error('Leave memory lab before sending a payload');
    const info = await stat(local); if (!info.isFile() || info.size < 1 || info.size > 32 * 1048576) throw new Error('Select a payload file of 1 byte–32 MiB');
    const hash = createHash('sha256'); for await (const b of createReadStream(local)) hash.update(b);
    const socket = net.createConnection({ host: this.profile.host, port: this.profile.payloadPort });
    socket.setTimeout(10000, () => socket.destroy(new Error('Payload transfer timed out')));
    await pipeline(createReadStream(local), socket);
    const result = { bytes: info.size, sha256: hash.digest('hex'), status: 'Bytes sent; BinLoader does not acknowledge successful execution.' };
    this.log('Payload sent', path.basename(local)); return result;
  }
  async call(method, args = {}, source = 'desktop') {
    // Serialize connection changes and writes across UI and MCP. Scans/dumps remain
    // cancellable jobs and individual wire requests are independently serialized.
    const controls = ['connect', 'disconnect', 'profile', 'memory_write', 'watch_add', 'watch_remove'];
    if (controls.includes(method)) {
      const run = this.controlTail.then(() => this.dispatch(method, args, source)); this.controlTail = run.catch(() => {}); return run;
    }
    return this.dispatch(method, args, source);
  }
  async dispatch(method, args, source) {
    if (method.startsWith('console_') && this.mode==='demo' && method!=='console_status')throw Error('Leave the memory lab before using console management');
    if (source==='mcp' && ['console_action','console_load'].includes(method))throw Error('Game and power controls are available in the desktop Console page');
    if (['pkg_install','pkg_queue_start','pkg_load','pkg_stop','console_load'].includes(method))this.console.guard();
    if (source === 'mcp' && (['pkg_load', 'pkg_install', 'pkg_control', 'pkg_stop'].includes(method)||method.startsWith('pkg_queue_'))) throw new Error('Load the receiver and control package installations in the desktop PKG installer');
    if (method.startsWith('pkg_') && this.mode === 'demo' && !['pkg_inspect', 'pkg_status', 'pkg_stop','pkg_queue_add','pkg_queue_remove','pkg_queue_clear','pkg_queue_stop'].includes(method)) throw new Error('Leave the memory lab before using the PS4 package installer');
    if (source === 'mcp' && ['payload', 'ftp_upload', 'profile', 'mcp_settings', 'demo_tick'].includes(method)) throw new Error('This action is available only in the desktop');
    switch (method) {
      case 'console_status': return this.console.status();
      case 'console_refresh': return this.console.refresh();
      case 'console_backup': return this.console.startBackup(args);
      case 'console_action': return this.console.action(args);
      case 'console_load': {
        this.console.guardTransfers();this.console.busy=true;
        try {if(this.packages.receiver.ready){await this.packages.receiver.close();await new Promise(resolve=>setTimeout(resolve,250));}await this.packages.loadReceiver({...args,host:this.profile.host,payloadPort:this.profile.payloadPort});}
        finally {this.console.busy=false;}
        return this.console.refresh();
      }
      case 'pkg_inspect': return inspectPackage(args.local);
      case 'pkg_queue_add': return this.packages.queue.addFolder(args.folder,args.recursive!==false);
      case 'pkg_queue_remove': return this.packages.queue.remove(args.id);
      case 'pkg_queue_clear': return this.packages.queue.clear();
      case 'pkg_queue_start': return this.packages.queue.start({...args,host:this.profile.host,payloadPort:this.profile.payloadPort});
      case 'pkg_queue_stop': return this.packages.queue.stop();
      case 'pkg_status': return args.refresh ? this.packages.progress() : this.packages.status();
      case 'pkg_check': return this.packages.check(this.profile.host, args.installerPort ?? 12800, args.mode ?? 'background');
      case 'pkg_load': return this.packages.loadReceiver({ ...args, host: this.profile.host, payloadPort: this.profile.payloadPort });
      case 'pkg_install': { const result = await this.packages.start({ ...args, host: this.profile.host, payloadPort: this.profile.payloadPort }); this.log('PKG install', `${result.job.name} · ${result.job.state}`, source); return result; }
      case 'pkg_control': return this.packages.control(args.action);
      case 'pkg_stop': return this.packages.close();
      case 'status': return this.status();
      case 'profile': return this.setProfile(args);
      case 'probe': return Promise.all([this.profile.debugPort, this.profile.ftpPort, this.profile.payloadPort].map(p => probe(this.profile.host, p)));
      case 'connect': return this.connect(args.demo === true);
      case 'disconnect': return this.disconnect();
      case 'processes': return this.requireClient().processes();
      case 'maps': return this.requireClient().maps(args.pid);
      case 'process_info': return this.requireClient().info(args.pid);
      case 'memory_read': return this.read(args);
      case 'memory_readv': return this.readv(args);
      case 'memory_inspect': return this.inspect(args);
      case 'memory_strings': return this.strings(args);
      case 'pointer_resolve': return this.pointer(args);
      case 'pointer_search': return this.pointers.start(args);
      case 'pointer_status': return this.pointers.status();
      case 'pointer_results': return this.pointers.results(args.offset, args.limit);
      case 'pointer_cancel': return this.pointers.cancel();
      case 'memory_write': return this.write(args, source);
      case 'scan_start': {
        if (this.dumps.job?.state === 'running') throw new Error('Wait for the dump to finish');
        this.log('Scan started', `${args.mode || 'exact'} · ${args.type || 'refinement'}`, source);
        if (args.dumpId) {
          const m = await this.dumps.manifest(args.dumpId);
          return this.scanner.start({ maps: async () => m.segments, read: (_, a, n) => this.dumps.read(args.dumpId, a, n) }, { ...args, pid: m.pid, connectionId: args.dumpId });
        }
        return this.scanner.start(this.requireClient(), { ...args, connectionId: this.connectionId });
      }
      case 'scan_status': return this.scanner.status();
      case 'scan_cancel': return this.scanner.cancel();
      case 'scan_results': return this.scanner.results(args.sessionId, args.offset ?? 0, args.limit ?? 100);
      case 'dump_start': {
        if (this.scanner.job?.state === 'running') throw new Error('Wait for the scan to finish');
        this.log('Dump started', `PID ${args.pid}`, source);
        return this.dumps.start(this.requireClient(), args, { host: this.profile.host, firmwareProfile: this.profile.firmware, mode: this.mode });
      }
      case 'dump_status': return this.dumps.status();
      case 'dump_cancel': return this.dumps.cancel();
      case 'dump_list': return this.dumps.list();
      case 'dump_manifest': { const m = await this.dumps.manifest(args.id); return { ...m, segments: m.segments.map(({ pages, ...s }) => ({ ...s, pageCount: pages.length })), note: 'Per-page hashes are stored in the local manifest; omitted from this response to keep MCP output bounded.' }; }
      case 'dump_compare': return this.dumps.compare(args.before, args.after, args.limit);
      case 'watch_add': return this.watchAdd(args);
      case 'watch_list': return this.watches;
      case 'watch_read': return this.watchRead();
      case 'watch_remove': this.watches = this.watches.filter(w => w.id !== args.id); await this.save(); return this.watches;
      case 'ftp_list': return this.ftp('list', args);
      case 'ftp_download': return this.ftp('download', args);
      case 'ftp_upload': return this.ftp('upload', args);
      case 'payload': return this.payload(args);
      case 'demo_tick': if (this.mode !== 'demo') throw new Error('Memory lab only'); this.client.tick(); return { changed: true };
      case 'mcp_settings': this.mcpWrites = args.writes === true; return { writes: this.mcpWrites };
      default: throw new Error('Unknown operation');
    }
  }
}
