import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm, open } from 'node:fs/promises';
import { PackageInstaller, inspectPackage, parseInstallerReply, parseRange } from '../src/packages.mjs';

async function fixture(t, size = 0x3000) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'psn-pkg-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'test.pkg'), data = Buffer.alloc(Math.min(size, 0x3000), 0x5a);
  data.writeUInt32BE(0x7f434e54); data.fill(0, 0x40, 0x70); data.write('UP0002-CUSA57548_00-CODBO2GAME000001', 0x40, 'ascii');
  // Actual IDs are 36 characters; use a 16-character label.
  data.fill(0, 0x40, 0x70); data.write('UP0002-CUSA57548_00-TESTPACKAGE00001', 0x40, 'ascii');
  data.writeUInt32BE(0x1a, 0x74); data.writeUInt32BE(0, 0x78); data.writeBigUInt64BE(BigInt(size), 0x430);
  await writeFile(local, data); if (size > data.length) { const f = await open(local, 'r+'); await f.truncate(size); await f.close(); }
  return { local, data };
}
async function listen(server) { await new Promise(r => server.listen(0, '127.0.0.1', r)); return server.address().port; }
async function freePort() { const s = http.createServer(); const p = await listen(s); await new Promise(r => s.close(r)); return p; }
test('PKG inspection validates magic and complete size, including files above 4 GiB', async t => {
  const {local} = await fixture(t, 0x100002000); const info = await inspectPackage(local);
  assert.equal(info.size, 0x100002000); assert.equal(info.titleId, 'CUSA57548');
  const f = await open(local, 'r+'); await f.truncate(0x2000); await f.close();
  await assert.rejects(inspectPackage(local), /incomplete or split/);
  await writeFile(local, Buffer.alloc(0x2000)); await assert.rejects(inspectPackage(local), /CNT header/);
});
test('HTTP ranges support suffixes and large offsets; original RPI hexadecimal replies are parsed without eval', () => {
  assert.deepEqual(parseRange('bytes=4294967296-', 4294967300), {start:4294967296,end:4294967299,partial:true});
  assert.deepEqual(parseRange('bytes=-4', 10), {start:6,end:9,partial:true});
  for (const r of ['bytes=9-2','bytes=10-','bytes=-0','bytes=0-1,4-5']) assert.throws(() => parseRange(r,10));
  assert.deepEqual(parseInstallerReply('{"status":"success","bits":0x1A,"length_total":0x100000001,"title":"0xBAD"}'), {status:'success',bits:26,length_total:4294967297,title:'0xBAD'});
});
test('direct install serves only the selected unchanged file, honors range requests, and tracks the real task', async t => {
  const {local,data} = await fixture(t); let source, paused = false;
  const remote = http.createServer(async (req,res) => {
    let body=''; for await (const chunk of req) body+=chunk; const args=JSON.parse(body);
    res.setHeader('Content-Type','application/json');
    if (req.url === '/api/is_exists') return res.end('{"status":"success","exists":false}');
    if (req.url === '/api/install') { source=args.packages[0]; const head=await fetch(source,{method:'HEAD'}); assert.equal(head.headers.get('content-length'),String(data.length)); return res.end('{"status":"success","task_id":42,"title":"Test homebrew"}'); }
    if (req.url === '/api/get_task_progress') return res.end('{"status":"success","error":0,"length_total":0x3000,"transferred_total":0x2000}');
    assert.equal(args.task_id,42); paused=req.url==='/api/pause_task'; res.end('{"status":"success"}');
  });
  const installerPort=await listen(remote); t.after(()=>new Promise(r=>remote.close(r)));
  const p=new PackageInstaller(); t.after(()=>p.close());
  const s=await p.start({mode:'remote',local,host:'127.0.0.1',installerPort,serverPort:await freePort()});
  assert.equal(s.job.taskId,42); assert.equal(s.job.key,undefined);
  await assert.rejects(p.start({mode:'remote',local,host:'127.0.0.1'}),/already hosted/);
  const response=await fetch(source,{headers:{Range:'bytes=50-99'}}); assert.equal(response.status,206); assert.equal(response.headers.get('content-range'),'bytes 50-99/12288'); assert.deepEqual(Buffer.from(await response.arrayBuffer()),data.subarray(50,100));
  const suffix=await fetch(source,{headers:{Range:'bytes=-5'}}); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),data.subarray(-5));
  const withQuery=await fetch(source+'?downloadId=9&source=bgft',{headers:{Range:'bytes=128-255'}});
  assert.equal(withQuery.status,206);assert.deepEqual(Buffer.from(await withQuery.arrayBuffer()),data.subarray(128,256));
  assert.equal((await fetch(source.replace('/package.pkg','/other.pkg')+'?downloadId=9')).status,404);
  assert.equal((await fetch(source.replace(/\/[a-f0-9]{48}\//,'/wrong-key/')+'?downloadId=9')).status,404);
  const audit=p.status().job.httpRequests;assert.ok(audit.some(r=>r.query&&r.status===206));assert.ok(!JSON.stringify(audit).includes(p.job.key));
  assert.equal((await fetch(source,{headers:{Range:'bytes=12288-'}})).status,416);
  assert.equal((await fetch(new URL('/api/session',source))).status,404);
  assert.equal((await fetch(source,{method:'POST'})).status,405);
  assert.equal((await p.progress()).job.progress.transferred_total,8192);
  await p.control('pause'); assert.equal(paused,true); await p.control('resume'); assert.equal(paused,false);
  await writeFile(local,Buffer.alloc(0x2000)); assert.equal((await fetch(source)).status,503);
  await p.close(); assert.equal(p.status().hosting,false);
});
test('failed install reply keeps source available and does not retry a possibly accepted task', async t => {
  const {local}=await fixture(t); let attempts=0;
  const remote=http.createServer((req,res)=>{req.resume(); if(req.url==='/api/install'){attempts++;res.end('lost response');}else res.end('{"status":"success"}');});
  const installerPort=await listen(remote); t.after(()=>new Promise(r=>remote.close(r)));
  const p=new PackageInstaller(); t.after(()=>p.close());
  const s=await p.start({mode:'remote',local,host:'127.0.0.1',installerPort,serverPort:await freePort()});
  assert.equal(s.hosting,true); assert.equal(s.job.state,'submission uncertain'); assert.equal(attempts,1);
});
