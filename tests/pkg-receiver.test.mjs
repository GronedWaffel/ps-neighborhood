import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Receiver } from '../src/pkg-receiver.mjs';

async function listen(s){await new Promise(r=>s.listen(0,'127.0.0.1',r));return s.address().port;}
async function freePort(){const s=net.createServer();const p=await listen(s);await new Promise(r=>s.close(r));return p;}
function reply(id,code,body=Buffer.alloc(0)){const h=Buffer.alloc(16);h.writeUInt32LE(0x52534e50);h.writeUInt32LE(id,4);h.writeInt32LE(code,8);h.writeUInt32LE(body.length,12);return Buffer.concat([h,body]);}
async function fakeConsole(t,{badKey=false}={}){
 let client;const commands=[];
 const loader=net.createServer(socket=>{const chunks=[];socket.on('data',b=>chunks.push(b));socket.on('end',()=>{
  const image=Buffer.concat(chunks),at=image.indexOf('PSNRECEIVERCFG01');assert.ok(at>=0);
  const port=image.readUInt16BE(at+20),key=Buffer.from(image.subarray(at+24,at+56));if(badKey)key[0]^=255;
  client=net.createConnection({host:'127.0.0.1',port});client.on('error',()=>{});
  client.on('connect',()=>{const version=Buffer.alloc(4);version.writeUInt32LE(1);const hello=reply(0,0,Buffer.concat([key,version]));client.write(hello.subarray(0,7));setTimeout(()=>client.write(hello.subarray(7)),10);});
  let buffer=Buffer.alloc(0);client.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=16){const n=buffer.readUInt32LE(12);if(buffer.length<16+n)return;const id=buffer.readUInt32LE(4),op=buffer.readUInt32LE(8),body=Buffer.from(buffer.subarray(16,16+n));buffer=buffer.subarray(16+n);assert.equal(buffer.length,0,'Commands are serialized');commands.push({op,body});let response;
   if(op===2)response=reply(id,0,Buffer.alloc(4));
   else if(op===13){const p=Buffer.alloc(12);p.writeUInt32LE(0x10010000);p.writeUInt32LE(1,4);p.writeUInt32LE(2,8);response=reply(id,0,p);}
   else if(op===3){const result=Buffer.alloc(8);result.writeInt32LE(77);response=reply(id,0,result);}
   else if(op===4){const p=Buffer.alloc(64);p.writeBigUInt64LE(5000000000n,24);p.writeBigUInt64LE(4000000000n,32);response=reply(id,0,p);}
   else response=reply(id,0);
   client.write(response.subarray(0,13));setTimeout(()=>client?.write(response.subarray(13)),5);
  }});
 });});
 const payloadPort=await listen(loader);t.after(async()=>{client?.destroy();await new Promise(r=>loader.close(r));});return {payloadPort,commands};
}
test('our payload protocol authenticates fragmented hello, serializes requests and reports install/progress/control',async t=>{
 const {payloadPort,commands}=await fakeConsole(t),r=new Receiver();t.after(()=>r.close());
 const s=await r.load({host:'127.0.0.1',pcAddress:'127.0.0.1',port:await freePort(),payloadPort});assert.equal(s.ready,true);
 await r.probe();const results=await Promise.all([r.command(1),r.command(1)]);assert.ok(results.every(r=>r.code===0));
 const result=await r.install({size:5000000000,type:0x1a,contentId:'UP0002-CUSA57548_00-TESTPACKAGE00001',name:'test.pkg'},'http://127.0.0.1:9696/key/package.pkg');assert.equal(result.task_id,77);
 const install=commands.find(c=>c.op===3);assert.equal(install.body.readBigUInt64LE(),5000000000n);
 const progress=await r.progress(77);assert.equal(progress.transferred_total,4000000000);
 await r.control(77,'pause');await r.control(77,'resume');await r.close();assert.equal(r.status().ready,false);assert.deepEqual(commands.slice(-3).map(c=>c.op),[5,6,7]);
});
test('a receiver with the wrong session key is refused without commands',async t=>{
 const {payloadPort,commands}=await fakeConsole(t,{badKey:true}),r=new Receiver();
 await assert.rejects(r.load({host:'127.0.0.1',pcAddress:'127.0.0.1',port:await freePort(),payloadPort}),/authentication/);assert.equal(commands.length,0);assert.equal(r.status().ready,false);
});

test('initialization failure preserves transport but never reports the install service ready',async()=>{
 const r=new Receiver();r.ready=true;
 r.runtime=async()=>({firmware:'10.01'});
 const body=Buffer.alloc(4);body.writeUInt32LE(30);
 r.command=async()=>({code:0x80020001|0,body});
 await assert.rejects(r.probe(),/stage 30 \(UserService startup\): 0x80020001/);
 assert.equal(r.status().ready,true);assert.equal(r.status().serviceReady,false);
 assert.match(r.status().error,/UserService startup/);
 r.command=async()=>({code:0,body:Buffer.alloc(4)});
 assert.equal((await r.probe()).serviceReady,true);assert.equal(r.status().error,undefined);
 r.command=async()=>({code:0,body:Buffer.alloc(0)});
 await assert.rejects(r.probe(),/Invalid receiver initialization reply/);
 assert.equal(r.status().serviceReady,false);
});
