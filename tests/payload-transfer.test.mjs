import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {transferPayload} from '../src/payload-transfer.mjs';

async function fixture(t, handle) {
  const sockets=new Set();
  const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});handle(s);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{for(const s of sockets)s.destroy();server.close();});
  return {host:'127.0.0.1',port:server.address().port};
}
test('ELF bytes arrive intact and no timeout fires after a completed transfer',async t=>{
  const chunks=[];let received;const complete=new Promise(r=>received=r);
  const target=await fixture(t,s=>{s.on('data',b=>chunks.push(b));s.on('end',()=>{s.end();received();});});
  const bytes=Buffer.alloc(256*1024,0xa3);
  await transferPayload(bytes,{...target,timeoutMs:60});await complete;
  assert.deepEqual(Buffer.concat(chunks),bytes);await delay(100);
});
test('a stalled transfer rejects without an uncaught or later timeout error',async t=>{
  // Model a transport that never completes a write; TCP buffering varies by OS.
  const socket=new Writable({write(_chunk,_encoding,_callback){}});
  let timer;
  socket.setTimeout=(ms,callback)=>{
    clearTimeout(timer);
    if(callback)socket.once('timeout',callback);
    if(ms)timer=setTimeout(()=>socket.emit('timeout'),ms);
    return socket;
  };
  t.mock.method(net,'createConnection',()=>socket);
  await assert.rejects(transferPayload(Buffer.from('test'),{host:'127.0.0.1',port:1,timeoutMs:20}),/ELF transfer timed out/);
  assert.equal(socket.destroyed,true);
  assert.equal(socket.listenerCount('timeout'),0);
  socket.emit('error',new Error('late transport error'));
  await delay(100);
});
test('connection refusal is returned to the caller',async()=>{
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
  await assert.rejects(transferPayload(Buffer.from('test'),{host:'127.0.0.1',port,timeoutMs:100}),{code:'ECONNREFUSED'});
});
