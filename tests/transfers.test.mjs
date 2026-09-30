import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Workbench } from '../src/workbench.mjs';

await mkdir('artifacts/tests', { recursive: true });
async function ftpFixture(t) {
  const files = new Map([['/data/hello.bin', Buffer.from('PS Neighbourhood FTP test')]]), sockets = new Set(), listeners = new Set();
  const server = net.createServer(control => {
    sockets.add(control); control.on('close', () => sockets.delete(control)); control.on('error', () => {});
    let buffer = '', dataReady, cwd = '/';
    const say = s => control.write(s + '\r\n'); say('220 Test FTP');
    let queue = Promise.resolve();
    control.on('data', b => {
      buffer += b.toString(); let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        queue = queue.then(async () => {
          const [cmd, ...rest] = line.split(' '), arg = rest.join(' ');
          switch (cmd) {
            case 'USER': say('331 Password required'); break;
            case 'PASS': say('230 Logged in'); break;
            case 'FEAT': say('211-Features\r\n UTF8\r\n EPSV\r\n211 End'); break;
            case 'OPTS': case 'TYPE': case 'STRU': say('200 OK'); break;
            case 'PWD': say('257 "' + cwd + '"'); break;
            case 'CWD': if(arg==='/' || [...files.keys()].some(p=>p.startsWith(arg+'/'))){cwd=arg;say('250 Directory changed');}else say('550 Missing directory'); break;
            case 'EPSV': {
              let resolve; dataReady = new Promise(r => resolve = r);
              const passive = net.createServer(s => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); resolve(s); passive.close(); listeners.delete(passive); }); listeners.add(passive);
              await new Promise(r => passive.listen(0, '127.0.0.1', r)); say(`229 Entering Extended Passive Mode (|||${passive.address().port}|)`); break;
            }
            case 'LIST': {
              say('150 Listing'); const data = await dataReady;
              const rows = [...files].filter(([name])=>path.posix.dirname(name)===cwd).map(([name, value]) => `-rw-r--r-- 1 root root ${value.length} Sep 26 12:00 ${path.posix.basename(name)}\r\n`).join('');
              data.end(rows); data.once('close', () => say('226 Transfer complete')); break;
            }
            case 'RETR': { say('150 Opening data'); const data = await dataReady; data.end(files.get(arg)); data.once('close', () => say('226 Transfer complete')); break; }
            case 'STOR': { say('150 Opening data'); const data = await dataReady, chunks = []; data.on('data', b => chunks.push(b)); data.on('end', () => { files.set(arg, Buffer.concat(chunks)); data.end(); say('226 Transfer complete'); }); break; }
            case 'QUIT': say('221 Bye'); control.end(); break;
            default: say('502 Unsupported');
          }
        }).catch(e => { say('550 ' + e.message); });
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of sockets) s.destroy(); for (const s of listeners) s.close(); server.close(); });
  return { port: server.address().port, files };
}
test('FTP browse, binary download, upload and existing-file refusal against a passive server', async t => {
  const fixture = await ftpFixture(t), w = await new Workbench(await mkdtemp(path.resolve('artifacts/tests/ftp-'))).init(); w.profile.host = '127.0.0.1'; w.profile.ftpPort = fixture.port;
  const list = await w.ftp('list', { remote: '/data' }); assert.equal(list[0].name, 'hello.bin');
  assert.deepEqual(await w.ftp('list', {remote:'/'}), []);
  await assert.rejects(w.ftp('list', {remote:'/missing'}), /Missing directory/);
  const result = await w.ftp('download', { remote: '/data/hello.bin' }); assert.deepEqual(await readFile(result.local), fixture.files.get('/data/hello.bin'));
  const local = path.join(w.directory, 'upload.bin'), content = Buffer.from([0, 1, 254, 255, 0, 23]); await writeFile(local, content);
  await w.ftp('upload', { remote: '/data/upload.bin', local }); assert.deepEqual(fixture.files.get('/data/upload.bin'), content);
  await assert.rejects(w.ftp('upload', { remote: '/data/upload.bin', local }), /already exists/);
});
test('payload transport streams exact bytes and reports checksum without claiming execution', async t => {
  const w = await new Workbench(await mkdtemp(path.resolve('artifacts/tests/payload-'))).init(), chunks = [];
  const server = net.createServer(s => { s.on('data', b => chunks.push(b)); s.on('end', () => s.end()); }); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  w.profile.host = '127.0.0.1'; w.profile.payloadPort = server.address().port;
  const data = Buffer.alloc(256 * 1024, 0x9a), file = path.join(w.directory, 'test.bin'); await writeFile(file, data);
  const r = await w.payload({ local: file }); assert.deepEqual(Buffer.concat(chunks), data); assert.equal(r.sha256, createHash('sha256').update(data).digest('hex')); assert.match(r.status, /does not acknowledge/);
});
