import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Receiver } from './pkg-receiver.mjs';
import { PackageQueue } from './package-queue.mjs';

// Wire contract and header layout: flatz/ps4_remote_pkg_installer (README, pkg.h, server.c).
export async function inspectPackage(local) {
  if (typeof local !== 'string' || !path.isAbsolute(local) || path.extname(local).toLowerCase() !== '.pkg') throw Error('Select a complete local .pkg file');
  const file = await open(local, 'r');
  try {
    const st = await file.stat(), header = Buffer.alloc(0x438);
    if (!st.isFile() || st.size < 0x2000 || !Number.isSafeInteger(st.size)) throw Error('Invalid package file size');
    await file.read(header, 0, header.length, 0);
    if (header.readUInt32BE(0) !== 0x7f434e54) throw Error('This is not a PS4 PKG (missing CNT header)');
    const declaredSize = header.readBigUInt64BE(0x430);
    if (declaredSize !== BigInt(st.size)) throw Error('PKG is incomplete or split. Finish downloading or merge its parts first');
    const contentId = header.subarray(0x40, 0x64).toString('ascii').replace(/\0.*$/, '');
    if (!/^[A-Z0-9]{6}-[A-Z0-9]{9}_00-[A-Z0-9]{16}$/.test(contentId)) throw Error('Invalid PS4 content ID');
    const type = header.readUInt32BE(0x74), flags = header.readUInt32BE(0x78);
    if (![0x1a, 0x1b, 0x1c, 0x1e].includes(type)) throw Error('Unsupported PS4 package content type');
    return { local: path.resolve(local), name: path.basename(local), size: st.size, mtimeMs: st.mtimeMs, contentId, titleId: contentId.slice(7, 16), kind: type === 0x1e || (flags & 0x60100000) ? 'Patch' : type === 0x1a ? 'Game / app' : 'Add-on', type };
  } finally { await file.close(); }
}

// The original installer emits bare hexadecimal numbers, which are not valid JSON.
// Normalize only numeric value tokens, never quoted strings and never evaluate code.
export function parseInstallerReply(text) {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|0x[\da-f]+/gi, token => token[0] === '"' ? token : String(BigInt(token))));
}

export function parseRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) throw Error('Invalid range');
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) throw Error('Unsatisfiable range');
  return { start, end, partial: true };
}

export class PackageInstaller {
  constructor() { this.server = null; this.job = null; this.busy = false; this.streams = new Set(); this.sources = new Map(); this.receiver = new Receiver(); this.queue = new PackageQueue(this, inspectPackage); }
  status() {
    const { key, ...job } = this.job || {};
    return { hosting: !!this.server?.listening, receiver: this.receiver.status(), job: this.job ? job : null, queue: this.queue.status(), interfaces: Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => entries.filter(e => e.family === 'IPv4' && !e.internal).map(e => ({ name, address: e.address }))) };
  }
  async request(host, port, method, args, timeout = 10000) {
    if (net.isIP(host) !== 4 || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('Enter a valid PS4 IPv4 address and installer port');
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(args);
      const req = http.request({ host, port, path: '/api/' + method, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy(Error('Installer response too large')); });
        res.on('error', reject);
        res.on('end', () => {
          try { const result = parseInstallerReply(text); if (res.statusCode !== 200 || result.status !== 'success') throw Error(result.error || result.message || JSON.stringify(result)); resolve(result); }
          catch (e) { reject(Error('Remote installer: ' + e.message)); }
        });
      });
      const timer = setTimeout(() => req.destroy(Error('Remote installer timed out. Open Remote Package Installer on the PS4 and keep it in the foreground')), timeout);
      req.once('close', () => clearTimeout(timer)); req.once('error', reject); req.end(body);
    });
  }
  async check(host, port = 12800, mode = 'background') {
    if (mode === 'background') { if (this.receiver.host !== host) throw Error('Load the background receiver on this console first'); return this.receiver.probe(); }
    const result = await this.request(host, port, 'is_exists', { title_id: 'CUSA00000' });
    return { ready: true, host, port, result };
  }
  async route(host, port) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(3000, () => socket.destroy(Error('Cannot reach Remote Package Installer on the PS4')));
      socket.once('error', reject);
      socket.once('connect', () => { const local = socket.localAddress; socket.destroy(); resolve(local); });
    });
  }
  async loadReceiver({host, payloadPort = 9090, pcAddress, receiverPort = 9697}) {
    // Choose the route without opening/consuming a BinLoader TCP connection.
    if (!pcAddress) pcAddress = await new Promise((resolve,reject) => {
      const socket=dgram.createSocket('udp4');
      socket.once('error',e=>{socket.close();reject(e);});
      socket.connect(payloadPort,host,()=>{const address=socket.address().address;socket.close();resolve(address);});
    });
    await this.receiver.load({host,payloadPort,pcAddress,port:receiverPort});
    await this.receiver.probe(); return this.status();
  }
  async start({ local, host, installerPort = 12800, pcAddress, serverPort = 9696, mode = 'background', payloadPort = 9090, receiverPort = 9697 }, fromQueue = false) {
    if (this.busy || (!fromQueue && (this.server || this.queue.running || this.queue.processing))) throw Error('A package is already hosted or queued. Finish or stop sharing it before starting another');
    this.busy = true;
    try {
      const pkg = await inspectPackage(local);
      if (!Number.isInteger(serverPort) || serverPort < 1024 || serverPort > 65535) throw Error('PC serving port must be 1024–65535');
      if (!['background','remote'].includes(mode)) throw Error('Unknown package installer mode');
      if (mode === 'background') { await this.loadReceiver({host,payloadPort,pcAddress,receiverPort}); pcAddress = this.receiver.pcAddress; }
      else { await this.check(host, installerPort, mode); pcAddress ||= await this.route(host, installerPort); }
      const localAddresses = Object.values(os.networkInterfaces()).flat().filter(Boolean).map(e => e.address);
      if (net.isIP(pcAddress) !== 4 || !localAddresses.includes(pcAddress)) throw Error('PC address must belong to a local network adapter');
      if (this.server && (this.job.host!==host || this.job.pcAddress!==pcAddress || this.job.serverPort!==serverPort)) throw Error('Stop sharing before changing the queue network settings');
      this.job = { ...pkg, mode, host, installerPort, pcAddress, serverPort, key: randomBytes(24).toString('hex'), state: 'starting', bytesServed: 0, requests: 0, httpRequests: [], startedAt: new Date().toISOString() };
      this.sources.set(this.job.key, this.job);
      await this.host();
      const url = `http://${pcAddress}:${serverPort}/${this.job.key}/package.pkg`;
      // A lost response may still have created a PS4 task. Keep serving and never auto-retry.
      try {
        const result = mode === 'background' ? await this.receiver.install(pkg,url) : await this.request(host, installerPort, 'install', { type: 'direct', packages: [url] }, 90000);
        if (!Number.isInteger(result.task_id) || result.task_id < 0) throw Error('Installer did not return a task ID');
        Object.assign(this.job, { taskId: result.task_id, title: result.title, state: 'submitted' });
      } catch (e) { Object.assign(this.job, { state: 'submission uncertain', error: e.message + '. Check PS4 Downloads before retrying; the file remains available.' }); }
      return this.status();
    } finally { this.busy = false; }
  }
  async host() {
    if (this.server) return;
    const binding = this.job;
    const server = http.createServer(async (req, res) => {
      let file, job;
      try {
        if (req.socket.remoteAddress?.replace(/^::ffff:/, '') !== binding.host) { res.writeHead(404); return res.end(); }
        // BGFT may append download parameters. Authenticate the exact path;
        // query parameters never choose a different file or alter its bytes.
        const requestPath = req.url.split('?', 1)[0];
        job = this.sources.get(requestPath.split('/')[1]);
        if (!job) { res.writeHead(404); return res.end(); }
        const entry = { at: new Date().toISOString(), method: req.method, path: requestPath.replaceAll(job.key, 'SESSION').slice(0, 160), query: req.url.includes('?'), range: req.headers.range?.slice(0, 100) };
        job.httpRequests ||= [];job.httpRequests.push(entry);if(job.httpRequests.length>32)job.httpRequests.shift();
        res.on('close', () => {entry.status=res.statusCode;entry.completed=res.writableFinished;});
        if (requestPath !== `/${job.key}/package.pkg`) { res.writeHead(404); return res.end(); }
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
        file = await open(job.local, 'r');
        const st = await file.stat();
        if (st.size !== job.size || st.mtimeMs !== job.mtimeMs) throw Error('Source PKG changed. Restore the original file before resuming');
        let range;
        try { range = parseRange(req.headers.range, job.size); }
        catch { res.writeHead(416, { 'Content-Range': `bytes */${job.size}` }); return res.end(); }
        const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': range.end - range.start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
        if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${job.size}`;
        res.writeHead(range.partial ? 206 : 200, headers);
        job.requests++; job.lastRequestAt = new Date().toISOString();
        if (req.method === 'HEAD') return res.end();
        const stream = file.createReadStream({ start: range.start, end: range.end, autoClose: false, highWaterMark: 1024 * 1024 });
        this.streams.add(stream); stream.on('data', data => { job.bytesServed += data.length; });
        try { await pipeline(stream, res); } finally { this.streams.delete(stream); }
      } catch (e) { if (job && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') job.servingError = e.message; if (!res.headersSent) res.writeHead(503); res.end(); }
      finally { await file?.close(); }
    });
    server.requestTimeout = 0;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(binding.serverPort, binding.pcAddress, resolve); });
    this.server = server;
  }
  async progress() {
    const job = this.job;
    if (!job || job.taskId === undefined) return this.status();
    try {
      const p = job.mode === 'background' ? await this.receiver.progress(job.taskId) : await this.request(job.host, job.installerPort, 'get_task_progress', { task_id: job.taskId });
      job.progress = p; delete job.pollError;
      if (Number(p.error)) { job.state = 'PS4 reported an error'; job.error = 'PS4 download error 0x' + (Number(p.error) >>> 0).toString(16).toUpperCase().padStart(8, '0'); }
      else if (Number(p.length_total) > 0 && Number(p.transferred_total) >= Number(p.length_total)) job.state = 'transfer complete · check PS4 installation';
      else if (job.state !== 'paused') job.state = 'installing';
    } catch (e) { job.pollError = e.message; }
    return this.status();
  }
  async control(action) {
    if (!['pause', 'resume'].includes(action) || this.job?.taskId === undefined) throw Error('Select an active installer task');
    if (action === 'resume' && !this.server) throw Error('The source is no longer hosted; start a new install from the original file');
    if (this.job.mode === 'background') await this.receiver.control(this.job.taskId,action);
    else await this.request(this.job.host, this.job.installerPort, action + '_task', { task_id: this.job.taskId });
    this.job.state = action === 'pause' ? 'paused' : 'installing'; return this.status();
  }
  async close() {
    if (this.busy) throw Error('Wait for the installation submission to finish');
    this.queue.interrupt();
    const server = this.server; this.server = null;
    for (const stream of this.streams) stream.destroy();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    this.sources.clear();
    if (this.job) this.job.state = 'sharing stopped';
    return this.status();
  }
}
