import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import net from 'node:net';
import {createSupportRelay} from '../src/support-relay.mjs';
import {SupportSession,SupportExecutor} from '../src/support-session.mjs';
import {supportRequest,relayUrl} from '../src/support-protocol.mjs';
import {createSupportMcp} from '../src/support-operator.mjs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const key='a'.repeat(64),delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn){for(let i=0;i<100;i++){if(fn())return;await delay(10);}throw Error('Condition not reached');}
async function fixture(t,options={}){
  const relay=createSupportRelay({operatorKey:key,...options});relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const base='http://127.0.0.1:'+relay.server.address().port;t.after(()=>relay.close());return {relay,base};
}
function workbench(){return {mode:'disconnected',profile:{platform:'ps5',host:'127.0.0.1',debugPort:744,ftpPort:2121,payloadPort:9021},conversion:{},shadow:{},console:{},packages:{},scanner:{},dumps:{},log(){},async disconnect(){}};}
const request=(base,route,token,body={})=>supportRequest(base,route,token,body);
async function pair(base,s){return request(base,'/claim',key,{code:s.code});}

test('relay requires operator authentication, binds one operator and separates roles',async t=>{
  const {base}=await fixture(t);const s=await request(base,'/sessions');
  await assert.rejects(request(base,'/claim','bad',{code:s.code}),/authentication/);
  const c=await pair(base,s);await assert.rejects(pair(base,s),/unavailable/);
  await assert.rejects(request(base,`/sessions/${s.id}/poll`,c.controller),/Owner only/);
  await assert.rejects(request(base,`/sessions/${s.id}/call`,s.owner,{method:'status',args:{}}),/operator/);
  await assert.rejects(request(base,`/sessions/${s.id}/poll`,'wrong'),/credential/);
  await request(base,`/sessions/${s.id}/revoke`,s.owner);await assert.rejects(request(base,`/sessions/${s.id}/call`,c.controller,{method:'status',args:{}}),/ended/);
});
test('end-to-end owner polling, command result, permissions and immediate revoke',async t=>{
  const {base}=await fixture(t);const w=workbench();let calls=0,closed=0;
  const owner=new SupportSession(w,{relay:base,allowLocal:true,pollMs:5,executorFactory:()=>({async run(method,args,signal){calls++;signal.throwIfAborted();return {method,answer:args.value};},close(){closed++;}})});t.after(()=>owner.stop());
  const s=await owner.start();const c=await pair(base,s);await waitFor(()=>owner.state.paired);
  const result=await request(base,`/sessions/${c.id}/call`,c.controller,{method:'status',args:{value:7}});assert.equal(result.result.answer,7);assert.equal(calls,1);
  owner.stop();assert.equal(owner.state.active,false);assert.equal(closed,1);
  await assert.rejects(request(base,`/sessions/${c.id}/call`,c.controller,{method:'status',args:{}}),/ended|disconnected/);
});
test('disconnect aborts a running operation and invalidates pending calls',async t=>{
  const {base}=await fixture(t);let started=false,aborted=false;
  const owner=new SupportSession(workbench(),{relay:base,allowLocal:true,pollMs:5,executorFactory:()=>({run(m,a,signal){started=true;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));},{once:true}));},close(){}})});t.after(()=>owner.stop());
  const s=await owner.start(),c=await pair(base,s);const command=request(base,`/sessions/${c.id}/call`,c.controller,{method:'status',args:{}});const rejection=assert.rejects(command,/disconnected/);
  await waitFor(()=>started);owner.stop();await rejection;assert.equal(aborted,true);
});
test('profile change, lost relay and expired pairing end the session',async t=>{
  const {base}=await fixture(t);const w=workbench(),owner=new SupportSession(w,{relay:base,allowLocal:true,pollMs:5});t.after(()=>owner.stop());
  await owner.start();w.profile.host='127.0.0.2';await waitFor(()=>!owner.state.active);assert.match(owner.state.events[0].text,/profile changed/);
  const disconnected=new SupportSession(workbench(),{relay:base,allowLocal:true,pollMs:5,request:async(base,route,...args)=>{if(route.endsWith('/poll'))throw Error('network lost');return supportRequest(base,route,...args);}});
  await disconnected.start();await waitFor(()=>!disconnected.state.active);assert.match(disconnected.state.events[0].text,/network lost/);
});
test('relay enforces command serialization, deadlines, one-time delivery and expiry',async t=>{
  let now=Date.now();const {base}=await fixture(t,{now:()=>now,commandMs:100});const s=await request(base,'/sessions'),c=await pair(base,s);
  const command=request(base,`/sessions/${s.id}/call`,c.controller,{method:'status',args:{}});const reject=assert.rejects(command,/timed out/);
  await delay(10);const p=await request(base,`/sessions/${s.id}/poll`,s.owner);assert.equal(p.job.method,'status');
  assert.equal((await request(base,`/sessions/${s.id}/poll`,s.owner)).job,null);
  await assert.rejects(request(base,`/sessions/${s.id}/call`,c.controller,{method:'status',args:{}}),/capacity is busy/);await reject;
  const next=await request(base,'/sessions');now+=16000;await assert.rejects(request(base,`/sessions/${next.id}/poll`,next.owner),/ended/);
});
test('owner enforces operation allowlist, no PC paths, and actions off by default',async()=>{
  const exec=new SupportExecutor(workbench().profile),signal=new AbortController().signal;
  for(const method of ['profile','ftp_upload','pkg_install','console_action','dump_manifest','support_start'])await assert.rejects(exec.run(method,{},signal),/not available/);
  await assert.rejects(exec.run('memory_read',{pid:60,address:'0x1000',dumpId:'../../secret'},signal));
  await assert.rejects(exec.run('payload_send',{name:'x.elf',sha256:'a'.repeat(64),base64:'AAAA'},signal),/not enabled/);
  await assert.rejects(exec.run('memory_write',{pid:60,address:'0x1000',expectedHex:'00',hex:'01'},signal),/not enabled/);
  assert.throws(()=>relayUrl('http://example.com'),/HTTPS/);
});
test('memory writes require matching bytes and disconnect prevents the write after a read',async()=>{
  let written=0;const exec=new SupportExecutor(workbench().profile,{actions:true});const controller=new AbortController();
  exec.client={connected:true,close(){},async read(){controller.abort();return Buffer.from('00','hex');},async writeMemory(){written++;}};
  await assert.rejects(exec.run('memory_write',{pid:60,address:'0x1000',expectedHex:'00',hex:'01'},controller.signal));assert.equal(written,0);
});
test('FTP diagnostics return actual bytes and close the connection',async()=>{
  let closed=0;const exec=new SupportExecutor(workbench().profile,{ftpFactory:()=>({async access(){},async downloadTo(sink,path){assert.equal(path,'/data/etaHEN/startup.log');sink.end(Buffer.from('Toolbox ready\n'));await once(sink,'finish');},close(){closed++;}})});
  const result=await exec.run('ftp_read',{remote:'/data/etaHEN/startup.log'},new AbortController().signal);assert.equal(result.content,'Toolbox ready\n');assert.equal(closed,1);
});
test('ELF send validates checksum and delivers bytes to a real TCP receiver',async t=>{
  const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
  const data=Buffer.alloc(128);data.set([0x7f,69,76,70,2,1,1]);data.writeUInt16LE(3,16);data.writeUInt16LE(62,18);data.writeBigUInt64LE(64n,32);data.writeUInt16LE(64,52);data.writeUInt16LE(56,54);data.writeUInt16LE(1,56);data.writeUInt32LE(1,64);data.writeBigUInt64LE(128n,96);data.writeBigUInt64LE(128n,104);
  const received=new Promise(resolve=>server.once('connection',s=>{const chunks=[];s.on('data',b=>chunks.push(b));s.on('end',()=>resolve(Buffer.concat(chunks)));}));
  const exec=new SupportExecutor({...workbench().profile,payloadPort:server.address().port},{actions:true});const args={name:'test.elf',sha256:createHash('sha256').update(data).digest('hex'),base64:data.toString('base64')};
  await assert.rejects(exec.run('payload_send',{...args,sha256:'0'.repeat(64)},new AbortController().signal),/checksum/);
  await exec.run('payload_send',args,new AbortController().signal);assert.deepEqual(await received,data);
});
test('remote MCP advertises and invokes scoped tools, never local workspace operations',async t=>{
  const {base}=await fixture(t);const owner=new SupportSession(workbench(),{relay:base,allowLocal:true,pollMs:5,executorFactory:()=>({async run(method,args){return {method,args};},close(){}})});t.after(()=>owner.stop());
  const s=await owner.start(),c=await pair(base,s),dir=await mkdtemp(path.join(os.tmpdir(),'psn-support-test-')),file=path.join(dir,'session.json');t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(file,JSON.stringify({...c,relay:base,testOnly:true}));
  const client=new Client({name:'support-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('src/support-operator.mjs'),'mcp'],env:{...process.env,PSN_SUPPORT_CONNECTION:file}}));t.after(()=>client.close());
  const names=(await client.listTools()).tools.map(t=>t.name);assert(names.includes('psn_support_ftp_read'));assert(names.includes('psn_support_payload_send'));assert(!names.includes('psn_pkg_inspect'));
  const result=await client.callTool({name:'psn_support_processes',arguments:{}});assert.equal(result.structuredContent.result.method,'processes');
});
test('chunked payloads keep polling responsive and require owner action permission',async t=>{
  const {base}=await fixture(t);let executed=0;
  const owner=new SupportSession(workbench(),{relay:base,allowLocal:true,pollMs:5,executorFactory:()=>({async run(method,args){executed++;return {chars:args.base64.length};},close(){}})});t.after(()=>owner.stop());
  const s=await owner.start({actions:true}),c=await pair(base,s);const base64=Buffer.alloc(2*1048576,7).toString('base64');
  const result=await request(base,`/sessions/${c.id}/call`,c.controller,{method:'payload_send',args:{name:'test.elf',sha256:'a'.repeat(64),base64}});
  assert.equal(result.result.chars,base64.length);assert.equal(executed,1);assert(owner.state.active);owner.stop();
  const next=await owner.start(),other=await pair(base,next);
  await assert.rejects(request(base,`/sessions/${other.id}/call`,other.controller,{method:'payload_send',args:{name:'test.elf',sha256:'a'.repeat(64),base64}}),/not enabled/);assert.equal(executed,1);
});
