import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PS4Debug, u32, hex } from '../src/protocol.mjs';
import { Scanner } from '../src/scanner.mjs';
import { challengeResponse, nativeSpec } from '../src/ng-scanner.mjs';
import { startServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const OK = u32(0x80000000), END = Buffer.alloc(8, 255);
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
await mkdir('artifacts/tests', { recursive: true });
const scanner = async () => new Scanner(await mkdtemp(path.resolve('artifacts/tests/ng-')));

// A TCP payload fixture, including the real NG status ordering, auth exchange,
// framed results and COUNT's 32 KiB first-read behavior. No production matcher.
async function fixture(t, options = {}) {
  const memory = Buffer.alloc(256 * 1024), base = 0x123456780000n;
  const sockets = new Set(), errors = [], requests = [], batches = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const run = async () => {
      const iterator = socket[Symbol.asyncIterator](); let buffer = Buffer.alloc(0);
      const read = async n => {
        while (buffer.length < n) { const next = await iterator.next(); if (next.done) throw new Error('eof'); buffer = Buffer.concat([buffer, next.value]); }
        const b = Buffer.from(buffer.subarray(0, n)); buffer = buffer.subarray(n); return b;
      };
      const send = async b => { socket.write(b.subarray(0, 1)); await new Promise(r => setImmediate(r)); socket.write(b.subarray(1, 3)); socket.write(b.subarray(3)); };
      const frames = async (records, width) => {
        const data = Buffer.concat(records), size = width + 4, batch = Math.floor(60000 / size) * size;
        if (options.badFrame) { await send(u64(0x20001)); return; }
        for (let i = 0; i < data.length; i += batch) { const part = data.subarray(i, i + batch); await send(Buffer.concat([u64(part.length), part])); }
        await send(END);
      };
      while (!socket.destroyed) {
        const header = await read(12); assert.equal(header.readUInt32LE(), 0xffaabbcc);
        const cmd = header.readUInt32LE(4), b = await read(header.readUInt32LE(8)); requests.push(cmd);
        if (cmd === 0xbd000501) {
          if (options.classic) { await send(u32(0xf0000001)); continue; }
          const brand = Buffer.from('ps4debug-NG by OSR v1.2.2\0'); await send(Buffer.concat([u32(brand.length), brand]));
        } else if (cmd === 0xbdaaccff) {
          assert.equal(b.readUInt32LE(), 0xbb40e64d); assert.equal(b.readUInt32LE(4), 2);
          const challenge = Buffer.alloc(64); await send(Buffer.concat([OK, Buffer.from([64, 0]), challenge]));
          const response = await read(64); assert.deepEqual([...response.subarray(0, 8)], [160, 72, 143, 237, 130, 50, 181, 238]); await send(OK);
        } else if (cmd === 0xbdaa0001) {
          const p = Buffer.alloc(36); p.write('eboot.bin'); p.writeUInt32LE(1, 32); await send(Buffer.concat([OK, u32(1), p]));
        } else if (cmd === 0xbdaa0002) {
          const o = Number(b.readBigUInt64LE(4) - base), n = b.readUInt32LE(12); assert.ok(o >= 0 && o + n <= memory.length);
          await send(Buffer.concat([OK, memory.subarray(o, o + n)]));
        } else if (cmd === 0xbdaa0004) {
          const m = Buffer.alloc(58); m.write('test'); m.writeBigUInt64LE(base, 32); m.writeBigUInt64LE(base + BigInt(memory.length), 40); m.writeUInt16LE(3, 56);
          await send(Buffer.concat([OK, u32(1), m]));
        } else if (cmd === 0xbdaacc01 || cmd === 0xbdaacc02) {
          const initial = cmd === 0xbdaacc01, at = b.readBigUInt64LE(4), type = b[initial ? 16 : 12], cmp = b[initial ? 17 : 13];
          const width = 2 ** Math.floor(type / 2), signed = type % 2, seedLength = b.readUInt32LE(initial ? 19 : 14);
          const previous = [5, 7, 9, 10].includes(cmp);
          const decode = (data, o = 0) => width === 8 ? data[signed ? 'readBigInt64LE' : 'readBigUInt64LE'](o) : data[signed ? 'readIntLE' : 'readUIntLE'](o, width);
          await send(OK); const seed = await read(seedLength);
          const record = (offset, old) => {
            const o = Number(at - base) + offset, now = memory.subarray(o, o + width);
            assert.equal(now.length, width);
            const v = decode(now), target = seed.length ? decode(seed) : null, before = old ? decode(old) : null;
            const match = cmp === 0 ? v === target : cmp === 2 ? v > target : cmp === 3 ? v < target : cmp === 4 ? v >= target && v <= decode(seed, width) : cmp === 5 ? v > before : cmp === 7 ? v < before : cmp === 9 ? !now.equals(old) : cmp === 10 ? now.equals(old) : cmp === 11;
            return match ? Buffer.concat([u32(options.badOffset ? 0xffffffff : offset), now]) : null;
          };
          if (initial) {
            if (options.extraStatus !== false) await send(OK);
            const length = b.readUInt32LE(12); assert.equal(b[18], width); assert.equal(length % width, 0);
            const records = []; for (let o = 0; o < length; o += width) { const r = record(o); if (r) records.push(r); }
            await frames(records, width); await send(OK);
          } else {
            while (true) {
              const length = (await read(4)).readUInt32LE(); if (length === 0xffffffff) break;
              const size = 4 + (previous ? width : 0); assert.ok(length <= 0x20000); assert.equal(length % size, 0); batches.push({ length, size });
              const entries = await read(length), records = []; let last = -1;
              for (let o = 0; o < length; o += size) {
                const offset = entries.readUInt32LE(o); assert.ok(offset > last); last = offset;
                // Conservative client rule protects every possible 32 KiB window.
                assert.ok(Number(at - base) + offset + 32768 <= memory.length);
                const r = record(offset, previous ? entries.subarray(o + 4, o + size) : null); if (r) records.push(r);
              }
              await frames(records, width);
            }
            await send(OK);
          }
        } else throw new Error('Unexpected command ' + cmd.toString(16));
      }
    };
    run().catch(e => { if (!socket.destroyed && e.message !== 'eof') { errors.push(e); socket.destroy(); } });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const client = await new PS4Debug({ host: '127.0.0.1', port: server.address().port, timeout: 2000 }).connect();
  t.after(() => { client.close(); for (const s of sockets) s.destroy(); server.close(); assert.deepEqual(errors, []); });
  await client.detectCapabilities(); return { client, memory, base, requests, batches, port: server.address().port };
}

test('NG challenge uses unsigned 32-bit wrap and typed seeds retain signed/64-bit precision', () => {
  assert.deepEqual([...challengeResponse(Buffer.alloc(8))], [160, 72, 143, 237, 130, 50, 181, 238]);
  assert.equal(nativeSpec('i64', 'between', '-9007199254740993', '-2').seed.readBigInt64LE(), -9007199254740993n);
  assert.equal(nativeSpec('u64', 'exact', '18446744073709551615').seed.readBigUInt64LE(), 0xffffffffffffffffn);
});

for (const extraStatus of [true, false]) test(`NG initial scan handles ${extraStatus ? 'two' : 'one'} status replies, fragmented frames, clipped ranges and subsequent reads`, async t => {
  const { client, memory, base } = await fixture(t, { extraStatus }); memory.writeUInt32LE(123, 8); memory.writeUInt32LE(123, 32);
  const s = await scanner(); t.after(() => s.clear());
  s.start(client, { pid: 1, type: 'u32', mode: 'exact', value: '123', start: hex(base + 1n), end: hex(base + 16n), connectionId: 'ng' }); await s.running;
  assert.equal(s.job.state, 'complete', s.job.error); assert.equal(s.job.backend, 'ng');
  assert.deepEqual((await s.results(s.job.sessionId)).rows.map(r => r.address), [hex(base + 8n)]);
  assert.equal((await client.read(1, base + 32n, 4)).readUInt32LE(), 123);
});

for (const type of ['u8', 'u16', 'u64']) test(`NG ${type} refinements keep whole previous-value records across 128 KiB batches and preserve tail candidates`, async t => {
  const { client, memory, base, batches } = await fixture(t), s = await scanner(), width = Number(type.slice(1)) / 8;
  t.after(() => s.clear());
  s.start(client, { pid: 1, type, mode: 'unknown', connectionId: 'ng' }); await s.running;
  assert.equal(s.job.state, 'complete', s.job.error); assert.equal(s.job.matches, memory.length / width); const id = s.job.sessionId;
  s.start(client, { sessionId: id, mode: 'unchanged', connectionId: 'ng' }); await s.running;
  assert.equal(s.job.state, 'complete', s.job.error); assert.equal(s.job.matches, memory.length / width); assert.equal(s.job.backend, 'hybrid');
  assert.ok(batches.length >= 2); assert.ok(batches.every(b => b.length % (width + 4) === 0));
  memory[8] = 1; memory[memory.length - width] = 2;
  s.start(client, { sessionId: id, mode: 'increased', connectionId: 'ng' }); await s.running;
  assert.equal(s.job.state, 'complete', s.job.error);
  const rows = (await s.results(id)).rows; assert.deepEqual(rows.map(r => r.address), [hex(base + 8n), hex(base + BigInt(memory.length - width))]);
  assert.deepEqual(rows.map(r => r.value), ['1', '2']);
  // Snapshots from the native engine also support explicit host refinement.
  s.start(client, { sessionId: id, mode: 'unchanged', backend: 'host', connectionId: 'ng' }); await s.running;
  assert.equal(s.job.matches, 2); assert.equal(s.job.backend, 'host');
});

test('classic detection leaves the main stream usable and auto scanning falls back; strict NG is explicit', async t => {
  const { client, base, requests } = await fixture(t, { classic: true }), s = await scanner(); t.after(() => s.clear());
  assert.equal(client.capabilities.nativeScan, false);
  s.start(client, { pid: 1, type: 'u32', mode: 'unknown', start: hex(base), end: hex(base + 128n) }); await s.running;
  assert.equal(s.job.state, 'complete', s.job.error); assert.equal(s.job.backend, 'host'); assert.equal(s.job.matches, 32);
  s.start(client, { pid: 1, mode: 'unknown', backend: 'ng' }); await s.running;
  assert.equal(s.job.state, 'failed'); assert.match(s.job.error, /NG unavailable/); assert.ok(!requests.includes(0xbdaaccff));
});

test('float tolerance, wildcard nibble patterns and custom alignment retain host semantics with NG connected', async t => {
  const { client, memory, base } = await fixture(t), s = await scanner(); t.after(() => s.clear());
  memory.writeFloatLE(1.5, 0); Buffer.from('abbc', 'hex').copy(memory, 17);
  for (const opts of [{ type: 'f32', mode: 'exact', value: '1.501', epsilon: .01 }, { type: 'aob', mode: 'exact', value: 'A? BC', alignment: 1 }, { type: 'u16', mode: 'exact', value: '48299', alignment: 1 }]) {
    s.start(client, { pid: 1, start: hex(base), end: hex(base + 64n), ...opts }); await s.running;
    assert.equal(s.job.state, 'complete', s.job.error); assert.equal(s.job.backend, 'host'); assert.equal(s.job.matches, 1);
  }
});

test('native cancellation drains the wire and preserves the last completed snapshot', async t => {
  const { client, base } = await fixture(t), s = await scanner(); t.after(() => s.clear());
  s.start(client, { pid: 1, type: 'u64', mode: 'unknown', connectionId: 'ng' }); await s.running; const id = s.job.sessionId;
  const original = client.ng.frames.bind(client.ng); let calls = 0;
  client.ng.frames = async (...args) => { await original(...args); if (++calls === 1) s.cancel(); };
  s.start(client, { sessionId: id, mode: 'unchanged', connectionId: 'ng' }); await s.running;
  assert.equal(s.job.state, 'cancelled'); assert.equal((await s.results(id)).pass, 1);
  assert.equal((await client.read(1, base, 8)).length, 8); assert.equal(client.connected, true);
});

for (const opts of [{ badFrame: true }, { badOffset: true }]) test(`malformed NG ${opts.badFrame ? 'frame' : 'candidate'} fails without publishing a snapshot`, async t => {
  const { client, base } = await fixture(t, opts), s = await scanner(); t.after(() => s.clear());
  s.start(client, { pid: 1, type: 'u64', mode: 'unknown', start: hex(base), end: hex(base + 64n) }); await s.running;
  assert.equal(s.job.state, 'failed'); assert.equal(s.sessions.size, 0); assert.equal(client.connected, false); assert.match(s.job.error, /NG/);
});

test('real stdio MCP detects NG and shares native scans, pagination and host overrides with the desktop', async t => {
  const { memory, base, port } = await fixture(t); memory.writeUInt32LE(123, 16);
  const directory = await mkdtemp(path.resolve('artifacts/tests/ng-mcp-')), app = await startServer({ directory }); t.after(() => app.close());
  app.workbench.profile = { ...app.workbench.profile, host: '127.0.0.1', debugPort: port };
  const mcp = new Client({ name: 'ng-integration', version: '1' }); t.after(() => mcp.close());
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('src/mcp.mjs')], env: { ...process.env, PSN_DATA: directory } }));
  const call = async (name, args = {}) => { const r = await mcp.callTool({ name: 'psn_' + name, arguments: args }); assert.ok(!r.isError, JSON.stringify(r)); return r.structuredContent.result; };
  assert.equal((await call('connect')).capabilities.nativeScan, true);
  await call('scan_start', { pid: 1, type: 'u32', mode: 'exact', value: '123', backend: 'ng', start: hex(base), end: hex(base + 128n) });
  await app.workbench.scanner.running;
  const job = await call('scan_status'); assert.equal(job.state, 'complete', job.error); assert.equal(job.backend, 'ng');
  const result = await call('scan_results', { sessionId: job.sessionId, offset: 0, limit: 1 });
  assert.equal(result.rows[0].address, hex(base + 16n)); assert.equal(result.backend, 'ng');
  assert.equal(app.workbench.status().scan.sessionId, job.sessionId);
  await call('scan_start', { sessionId: job.sessionId, mode: 'unchanged', backend: 'host' }); await app.workbench.scanner.running;
  assert.equal((await call('scan_status')).backend, 'host');
  assert.equal((await call('scan_results', { sessionId: job.sessionId })).pass, 2);
});
