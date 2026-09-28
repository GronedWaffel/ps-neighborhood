// Explicit read-only diagnostic. Never invoked by the app or normal test suite.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PS4Debug, address, hex } from '../src/protocol.mjs';
import { Scanner } from '../src/scanner.mjs';

const host = process.argv[2];
if (!host) throw new Error('Usage: node scripts/check-live-scanner.mjs CONSOLE_IP');
const parent = path.resolve('artifacts/live-validation'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(path.join(parent, 'run-')), scanner = new Scanner(directory);
const client = await new PS4Debug({ host, timeout: 5000 }).connect();
try {
  const capabilities = await client.detectCapabilities(), processes = await client.processes();
  const target = processes.find(p => p.name === 'eboot.bin') ?? processes.find(p => p.name === 'SceShellUI');
  if (!target) throw new Error('No game or ShellUI userland process available for a bounded read');
  const maps = await client.maps(target.pid);
  const region = maps.find(m => (m.prot & 5) === 5 && address(m.end) - address(m.start) >= 4096n);
  if (!region) throw new Error('No readable executable mapping for the bounded check');
  const start = address(region.start), end = start + 4096n;
  const data = await client.read(target.pid, start, 64); assert.equal(data.length, 64);
  scanner.start(client, { pid: target.pid, type: 'u32', mode: 'unknown', start: hex(start), end: hex(end), writableOnly: false, connectionId: 'live-check' });
  await scanner.running; assert.equal(scanner.job.state, 'complete', scanner.job.error); assert.equal(scanner.job.matches, 1024);
  const initial = scanner.status();
  scanner.start(client, { sessionId: initial.sessionId, mode: 'unchanged', connectionId: 'live-check' }); await scanner.running;
  assert.equal(scanner.job.state, 'complete', scanner.job.error); assert.ok(scanner.job.matches <= initial.matches);
  const results = await scanner.results(initial.sessionId, 0, 10); assert.equal(results.pass, 2);
  assert.equal((await client.read(target.pid, start, 64)).length, 64);
  const report = { checkedAt: new Date().toISOString(), host, capabilities, process: target, region: { name: region.name, start: hex(start), end: hex(end) }, readBytes: data.length, initialCount: initial.matches, refinedCount: results.count, backend: results.backend, writesPerformed: false, gameRunning: target.name === 'eboot.bin' };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, reportFile: path.join(directory, 'report.json') }));
} finally { await scanner.clear(); client.close(); }
