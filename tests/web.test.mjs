import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createWebRelay} from '../src/web-relay.mjs';
import {startServer} from '../src/server.mjs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const origin='https://psneighborhood.test';
async function fixture(t,{approve=true,callTimeout=1500}={}){
  const relay=createWebRelay({origin,pollTimeout:200,callTimeout});await new Promise(r=>relay.server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+relay.server.address().port;await mkdir('artifacts/tests',{recursive:true});const directory=await mkdtemp(path.resolve('artifacts/tests/web-')),actions=[];
  const app=await startServer({directory,webOptions:{origin:url,allowLocal:true},native:async(name,args)=>{actions.push({name,args});return name==='confirm-web'?approve:{name,args};}});
  t.after(async()=>{await app.close();relay.close();});
  const post=async(route,data={},headers={})=>fetch(url+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
  async function pair(){const state=await app.web.start();const r=await post('/web/pair',{code:state.code});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));const cookie=r.headers.get('set-cookie').split(';')[0],token=cookie.split('=')[1];return {cookie,token};}
  async function call(auth,method,args={}){const r=await post('/api/call',{method,args},{Cookie:auth.cookie,Authorization:'Bearer '+auth.token});const b=await r.json();if(!r.ok)throw Error(b.error);return b.result;}
  return {relay,url,app,actions,post,pair,call};
}
test('website requires explicit companion approval and protects both session authorities',async t=>{
  const f=await fixture(t,{approve:false});assert.equal((await fetch(f.url+'/api/session')).status,401);
  const s=await f.app.web.start();const r=await f.post('/web/pair',{code:s.code});assert.equal(r.status,400);assert.match((await r.json()).error,/declined/);
  assert.equal((await f.post('/api/call',{method:'status',args:{}})).status,401);
  assert.equal((await f.post('/bridge/poll',{}, {Authorization:'Bearer '+s.code})).status,403);
  assert.equal((await f.post('/web/pair',{code:s.code},{Origin:'https://hostile.test'})).status,403);
  assert.equal(f.app.web.state.paired,false);
});
test('full website routes and MCP share one workspace with independent write permissions',async t=>{
  const f=await fixture(t),auth=await f.pair();
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('src/mcp.mjs')],env:{...process.env,PSN_DATA:f.app.directory}}),mcp=new Client({name:'web-parity',version:'1'});t.after(()=>mcp.close());await mcp.connect(transport);
  await f.call(auth,'connect',{demo:true});
  const processes=await f.call(auth,'processes');assert.ok(processes.some(p=>p.pid===1337));
  const memory=await mcp.callTool({name:'psn_memory_read',arguments:{pid:1337,address:'0x100000100',length:4}});assert.equal(memory.structuredContent.result.hex,'64000000');
  const write={pid:1337,address:'0x100000100',expectedHex:'64000000',hex:'65000000'};
  const denied=await mcp.callTool({name:'psn_memory_write',arguments:write});assert.equal(denied.isError,true);
  assert.equal((await f.call(auth,'memory_write',write)).verified,true);
  const again=await mcp.callTool({name:'psn_memory_read',arguments:{pid:1337,address:'0x100000100',length:4}});assert.equal(again.structuredContent.result.hex,'65000000');
  await f.call(auth,'scan_start',{pid:1337,type:'u32',mode:'exact',value:'101',start:'0x100000000',end:'0x100001000'});await f.app.workbench.scanner.running;
  assert.equal((await f.call(auth,'scan_status')).state,'complete');
  await f.call(auth,'dump_start',{pid:1337,start:'0x100000100',end:'0x100000200'});await f.app.workbench.dumps.running;
  assert.equal((await f.call(auth,'dump_status')).state,'complete');
  for(const name of ['choose-file','choose-folder','open-exports','open-saves','confirm-save-restore','confirm-console','mcp-config'])assert.equal((await f.call(auth,'native:'+name,{test:true})).name,name);
  for(const method of ['console_status','shadow_status','conversion_status','pkg_status','watch_list','dump_list'])await f.call(auth,method);
  await assert.rejects(f.call(auth,'native:execute-shell'),/Unknown native/);
  await assert.rejects(f.call({...auth,token:'0'.repeat(64)},'status'),/disconnected/);
  const cookieLeak=await fetch(f.app.url+'/api/session',{headers:{Origin:origin}});assert.equal(cookieLeak.status,403);
  const reuse=await f.post('/web/pair',{code:f.app.web.session.code});assert.equal(reuse.status,400);
});
test('website revocation ends access without disconnecting local MCP/console workspace',async t=>{
  const f=await fixture(t),auth=await f.pair();await f.call(auth,'connect',{demo:true});
  await f.post('/web/disconnect',{}, {Cookie:auth.cookie,Authorization:'Bearer '+auth.token});
  assert.equal((await fetch(f.url+'/api/session',{headers:{Cookie:auth.cookie}})).status,401);
  await assert.rejects(f.call(auth,'status'),/disconnected/);assert.equal(f.app.workbench.mode,'demo');
  await new Promise(r=>setTimeout(r,50));assert.equal(f.app.web.state.active,false);
});
test('timed-out website commands are never automatically executed twice',async t=>{
  const f=await fixture(t,{callTimeout:60}),auth=await f.pair();let count=0;
  f.app.web.call=async()=>{count++;await new Promise(r=>setTimeout(r,150));return true;};
  await assert.rejects(f.call(auth,'status'),/may still be running/);await new Promise(r=>setTimeout(r,200));assert.equal(count,1);
});
test('revoking a queued website control prevents its later execution',async t=>{
  const f=await fixture(t),auth=await f.pair();let release;f.app.workbench.controlTail=new Promise(r=>release=r);
  const result=f.call(auth,'connect',{demo:true}).catch(e=>e);await new Promise(r=>setTimeout(r,50));f.app.web.stop();release();assert.ok(await result instanceof Error);assert.notEqual(f.app.workbench.mode,'demo');
});
test('website loads the same UI and supplies every desktop preload capability',async()=>{
  const preload=await readFile('desktop/preload.cjs','utf8'),boot=await readFile('ui/boot.js','utf8');
  for(const name of [...preload.matchAll(/(\w+):\s*(?:\([^)]*\)|\w+)\s*=>/g)].map(m=>m[1]))assert.ok(boot.includes(name+':'),name);
  assert.match(boot,/import\('\.\/app\.js'\)/);
});
