import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PS4Debug, address, bytes, hex, u32 } from '../src/protocol.mjs';
import { Scanner, matcher } from '../src/scanner.mjs';
import { DemoConsole } from '../src/demo.mjs';
import { Workbench } from '../src/workbench.mjs';
import { Dumps } from '../src/dumps.mjs';
import { PointerSearch } from '../src/pointers.mjs';
import { startServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

await mkdir('artifacts/tests', { recursive: true });
const dir = () => mkdtemp(path.resolve('artifacts/tests/run-'));

async function fixture(t, mode = 'normal') {
  const mem = Buffer.alloc(4096); mem.writeUInt32LE(100, 0x100);
  const sockets = new Set(); const base = 0x123456789000n;
  const server = net.createServer(s => {
    sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {});
    let buffer = Buffer.alloc(0), awaiting = null;
    const send = data => { s.write(data.subarray(0, 1)); setTimeout(() => { if (!s.destroyed) { s.write(data.subarray(1, 3)); s.write(data.subarray(3)); } }, 2); };
    s.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (true) {
        if (awaiting) {
          if (buffer.length < awaiting.length) return;
          buffer.copy(mem, awaiting.offset, 0, awaiting.length); buffer = buffer.subarray(awaiting.length); awaiting = null; send(u32(0x80000000)); continue;
        }
        if (buffer.length < 12) return;
        assert.equal(buffer.readUInt32LE(), 0xffaabbcc);
        const command = buffer.readUInt32LE(4), length = buffer.readUInt32LE(8);
        if (buffer.length < 12 + length) return;
        const body = Buffer.from(buffer.subarray(12, 12 + length)); buffer = buffer.subarray(12 + length);
        if (mode === 'timeout') continue;
        if (mode === 'bad-count') { send(Buffer.concat([u32(0x80000000), u32(0xffffffff)])); continue; }
        if (command === 0xbdaa0001) { const p = Buffer.alloc(36); p.write('eboot.bin'); p.writeUInt32LE(1337, 32); send(Buffer.concat([u32(0x80000000), u32(1), p])); }
        else if (command === 0xbdaa0004) { const m = Buffer.alloc(58); m.write('test'); m.writeBigUInt64LE(base, 32); m.writeBigUInt64LE(base + 4096n, 40); m.writeUInt16LE(3, 56); send(Buffer.concat([u32(0x80000000), u32(1), m])); }
        else if (command === 0xbdaa0002) { assert.equal(body.readUInt32LE(), 1337); const o = Number(body.readBigUInt64LE(4) - base); send(Buffer.concat([u32(0x80000000), mem.subarray(o, o + body.readUInt32LE(12))])); }
        else if (command === 0xbdaa0003) { awaiting = { offset: Number(body.readBigUInt64LE(4) - base), length: body.readUInt32LE(12) }; send(u32(0x80000000)); }
        else send(u32(0xf0000001));
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const client = await new PS4Debug({ host: '127.0.0.1', port: server.address().port, timeout: mode === 'timeout' ? 50 : 1000 }).connect();
  t.after(() => { client.close(); for (const s of sockets) s.destroy(); server.close(); });
  return { client, base, mem };
}
test('wire protocol handles fragmented/coalesced replies and concurrent callers with 64-bit addresses', async t => {
  const { client, base } = await fixture(t);
  const [processes, maps, data] = await Promise.all([client.processes(), client.maps(1337), client.read(1337, base + 0x100n, 4)]);
  assert.equal(processes[0].pid, 1337); assert.equal(maps[0].start, hex(base)); assert.equal(maps[0].permissions, 'rw-'); assert.equal(data.readUInt32LE(), 100);
  await client.writeMemory(1337, base + 0x100n, u32(777)); assert.equal((await client.read(1337, base + 0x100n, 4)).readUInt32LE(), 777);
});
test('protocol discards timed-out streams and rejects hostile count fields', async t => {
  const { client } = await fixture(t, 'timeout'); await assert.rejects(client.processes(), /timed out/); assert.equal(client.connected, false);
  const bad = await fixture(t, 'bad-count'); await assert.rejects(bad.client.processes(), /Process count/); assert.equal(bad.client.connected, false);
});
test('validation preserves 64-bit precision, signed values, float tolerance and wildcard nibbles', () => {
  assert.equal(address('0xFFFFFFFFFFFFFFFF'), 0xffffffffffffffffn);
  assert.throws(() => address(Number.MAX_SAFE_INTEGER + 1)); assert.throws(() => bytes('0G')); assert.throws(() => matcher('u8', 'exact', '300'));
  const b = Buffer.from('488b05deadbeef', 'hex'); assert.ok(matcher('aob', 'exact', '48 8? ?? DE').test(b, 0));
  const f = Buffer.alloc(4); f.writeFloatLE(1.5); assert.ok(matcher('f32', 'exact', '1.501', null, .01).test(f, 0));
  const big = Buffer.alloc(8); big.writeBigInt64LE(-9007199254740993n); assert.ok(matcher('i64', 'exact', '-9007199254740993').test(big, 0));
});

test('text and AOB defaults search every byte, including long patterns at unaligned addresses',async()=>{
 const demo=new DemoConsole(),scan=new Scanner(await dir(),{chunkSize:128});
 const text='An unaligned string '.repeat(5);demo.memory.write(text,0x513);
 for(const [type,value] of [['text',text],['aob',Buffer.from(text).toString('hex').match(/../g).join(' ')]]){
  scan.start(demo,{pid:1337,type,mode:'exact',value,start:'0x100000500',end:'0x100000700',connectionId:'demo'});await scan.running;
  assert.equal(scan.job.state,'complete',scan.job.error);const result=await scan.results(scan.job.sessionId);assert.equal(result.count,1);assert.equal(result.rows[0].address,'0x100000513');
 }
});
test('disk-backed unknown scan retains all candidates, refines changes, and keeps previous results on cancellation', async () => {
  const demo = new DemoConsole(), scan = new Scanner(await dir(), { chunkSize: 128 });
  const opts = { pid: 1337, type: 'u32', mode: 'unknown', start: '0x100000000', end: '0x100001000', connectionId: 'demo' };
  scan.start(demo, opts); await scan.running; assert.equal(scan.job.state, 'complete'); assert.equal(scan.job.matches, 1024);
  const id = scan.job.sessionId; demo.tick();
  scan.start(demo, { sessionId: id, mode: 'changed', connectionId: 'demo' }); await scan.running;
  const results = await scan.results(id); assert.equal(results.count, 2); assert.equal(results.rows[0].address, '0x100000100'); assert.equal(results.rows[0].value, '93');
  scan.start(demo, { sessionId: id, mode: 'unchanged', connectionId: 'demo' }); scan.cancel(); await scan.running;
  assert.equal(scan.job.state, 'cancelled'); assert.equal((await scan.results(id)).count, 2);
  scan.start(demo, { sessionId: id, mode: 'changed', connectionId: 'other' }); await scan.running; assert.match(scan.job.error, /connection changed/);
});
test('AOB finds patterns crossing chunk boundaries and no candidates are duplicated', async () => {
  const demo = new DemoConsole(); Buffer.from('aabbccddee', 'hex').copy(demo.memory, 126);
  const scan = new Scanner(await dir(), { chunkSize: 128 });
  scan.start(demo, { pid: 1337, type: 'aob', mode: 'exact', value: 'AA BB ?? DD EE', alignment: 1, start: '0x100000000', end: '0x100000300', connectionId: 'x' });
  await scan.running; const r = await scan.results(scan.job.sessionId); assert.equal(r.count, 1); assert.equal(r.rows[0].address, '0x10000007E');
});
test('scans reject oversized ranges before memory reads', async () => {
  const scan = new Scanner(await dir(), { maxBytes: 1024 }); scan.start(new DemoConsole(), { pid: 1337, type: 'u32', mode: 'unknown' }); await scan.running; assert.equal(scan.job.state, 'failed'); assert.match(scan.job.error, /exceeds/);
});
test('RAM bundles hash correctly, retain map metadata, support offline reads/scans and page diffs', async () => {
  const d = new Dumps(await dir()), demo = new DemoConsole();
  const opts = { pid: 1337, start: '0x100000000', end: '0x100002000' };
  d.start(demo, opts, { mode: 'demo' }); await d.running; assert.equal(d.job.state, 'complete'); const a = d.job.id;
  const m = await d.manifest(a), data = await readFile(path.join(d.job.folder, m.segments[0].file));
  assert.equal(createHash('sha256').update(data).digest('hex'), m.segments[0].sha256); assert.equal(m.segments[0].start, opts.start); assert.equal(m.segments[0].prot, 3);
  assert.match(await readFile(path.join(d.job.folder, 'ImportPSNeighborhood.java'), 'utf8'), /new ProgramDB/);
  assert.equal((await d.read(a, '0x100000100', 4)).readUInt32LE(), 100);
  demo.tick(); d.start(demo, opts, { mode: 'demo' }); await d.running; const diff = await d.compare(a, d.job.id); assert.equal(diff.changedPages, 1); assert.equal(diff.addedPages, 0);
  const scan = new Scanner(await dir()); scan.start({ maps: async () => m.segments, read: (_, a2, n) => d.read(a, a2, n) }, { pid: 1337, type: 'u32', mode: 'exact', value: '100', connectionId: a }); await scan.running;
  assert.ok((await scan.results(scan.job.sessionId)).rows.some(r => r.address === '0x100000100'));
});
test('failed dumps are explicitly incomplete and never listed as successful', async () => {
  const d = new Dumps(await dir()), demo = new DemoConsole(); demo.read = async () => { throw new Error('Console disconnected'); };
  d.start(demo, { pid: 1337, regionStarts: ['0x100000000'] }, {}); await d.running;
  assert.equal(d.job.state, 'failed'); assert.equal((await d.list()).length, 0); assert.ok((await stat(path.join(d.job.folder, 'INCOMPLETE.json'))).size);
});
test('offline reverse pointer search discovers multi-level chains that resolve to the target', async () => {
  const d = new Dumps(await dir()), demo = new DemoConsole(); demo.memory.writeBigUInt64LE(0x1000001f0n, 0x300);
  d.start(demo, { pid: 1337, start: '0x100000000', end: '0x100001000' }, { mode: 'demo' }); await d.running;
  const p = new PointerSearch(d); p.start({ dumpId: d.job.id, target: '0x100000100', maxDepth: 2, maxOffset: 32 }); await p.running;
  assert.equal(p.job.state, 'complete');
  const chain = p.results().rows.find(r => r.base === '0x100000300' && r.depth === 2); assert.deepEqual(chain.offsets, ['0x10', '0x0']);
  const w = await new Workbench(await dir()).init(); w.dumps = d;
  assert.equal((await w.pointer({ dumpId: d.job.id, base: chain.base, offsets: chain.offsets })).address, '0x100000100');
});
test('typed structures, pointers, strings, expected-byte writes and MCP write gating', async () => {
  const w = await new Workbench(await dir()).init(); await w.connect(true);
  assert.equal((await w.pointer({ pid: 1337, base: '0x100000200', offsets: ['0'] })).address, '0x100000100');
  assert.equal((await w.inspect({ pid: 1337, address: '0x100000100', fields: [{ name: 'health', type: 'u32', offset: 0 }] }))[0].value, '100');
  assert.match((await w.strings({ pid: 1337, address: '0x100000120', length: 32 })).rows[0].text, /PS NEIGHBORHOOD/);
  const args = { pid: 1337, address: '0x100000100', expectedHex: '64000000', hex: '65000000' };
  await assert.rejects(w.call('memory_write', args, 'mcp'), /disabled/);
  assert.equal((await w.call('memory_write', args)).verified, true); await assert.rejects(w.call('memory_write', args), /Memory changed/);
  await w.disconnect();
});
test('local HTTP origin/auth checks and real stdio MCP handshake, schemas, resources, tool calls and dumps', async t => {
  const directory = await dir(), app = await startServer({ directory }); t.after(() => app.close());
  assert.equal((await fetch(app.url + '/api/session', { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(app.url + '/api/call', { method: 'POST', body: '{}' })).status, 401);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('src/mcp.mjs')], env: { ...process.env, PSN_DATA: directory } });
  const client = new Client({ name: 'psn-integration-tests', version: '1.0' }); t.after(() => client.close()); await client.connect(transport);
  const listing = await client.listTools(); assert.ok(listing.tools.length >= 29); assert.ok(listing.tools.some(x => x.name === 'psn_dump_start'));
  const connect = await client.callTool({ name: 'psn_connect', arguments: { demo: true } }); assert.equal(connect.isError, undefined);
  const result = await client.callTool({ name: 'psn_memory_read', arguments: { pid: 1337, address: '0x100000100', length: 4 } }); assert.equal(result.structuredContent.result.hex, '64000000');
  const invalid = await client.callTool({ name: 'psn_memory_read', arguments: { pid: 1337, address: '0x100000100', length: -1 } }); assert.equal(invalid.isError, true);
  const start = await client.callTool({ name: 'psn_dump_start', arguments: { pid: 1337, start: '0x100000100', end: '0x100000200' } }); assert.equal(start.isError, undefined);
  await app.workbench.dumps.running;
  const dump = await client.callTool({ name: 'psn_dump_status', arguments: {} }); assert.equal(dump.structuredContent.result.state, 'complete');
  assert.equal((await client.listResources()).resources.length, 3); assert.equal((await client.listPrompts()).prompts.length, 1);
  const resource = await client.readResource({ uri: 'psn://workspace' }); assert.equal(JSON.parse(resource.contents[0].text).mode, 'demo');
  await client.close();
});
