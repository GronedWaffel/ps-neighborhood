import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PS5Debug} from '../src/ps5debug.mjs';
import {Workbench} from '../src/workbench.mjs';
import {validatePS5Elf} from '../src/platform.mjs';
import {compatibility} from '../src/firmware.mjs';
import {ConsoleManager} from '../src/console-manager.mjs';
import {startServer} from '../src/server.mjs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
const OK=u32(0x80000000),base=0x123456780000n;
async function directory(t){const d=await mkdtemp(path.join(tmpdir(),'psn-ps5-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;}
async function fixture(t,{platform=5,brand='ps5debug-NG by OSR v1.3.1\0'+'1.1'}={}){
 const memory=Buffer.alloc(256);memory.writeUInt32LE(100);const commands=[],sockets=new Set(),errors=[];
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
  (async()=>{
   const it=socket[Symbol.asyncIterator]();let buffer=Buffer.alloc(0);
   const read=async n=>{while(buffer.length<n){const r=await it.next();if(r.done)throw Error('eof');buffer=Buffer.concat([buffer,r.value]);}const b=Buffer.from(buffer.subarray(0,n));buffer=buffer.subarray(n);return b;};
   const send=async b=>{socket.write(b.subarray(0,1));await new Promise(r=>setImmediate(r));socket.write(b.subarray(1));};
   while(!socket.destroyed){
    const h=await read(12);assert.equal(h.readUInt32LE(),0xffaabbcc);const cmd=h.readUInt32LE(4),b=await read(h.readUInt32LE(8));commands.push(cmd);
    if(cmd===0xbd000502)await send(u16(platform));
    else if(cmd===0xbd000500)await send(u16(1360));
    else if(cmd===0xbd000501){const b=Buffer.from(brand);await send(Buffer.concat([u32(b.length),b]));}
    else if(cmd===0xbdaa0001){const p=Buffer.alloc(36);p.write('eboot.bin');p.writeUInt32LE(7,32);await send(Buffer.concat([OK,u32(1),p]));}
    else if(cmd===0xbdaa0004){const m=Buffer.alloc(58);m.write('executable');m.writeBigUInt64LE(base,32);m.writeBigUInt64LE(base+256n,40);m.writeUInt16LE(3,56);await send(Buffer.concat([OK,u32(1),m]));}
    else if(cmd===0xbdaa000a){const i=Buffer.alloc(188);i.writeUInt32LE(7);i.write('eboot.bin',4);i.write('/app0/eboot.bin',44);i.write('PPSA12345',108);await send(Buffer.concat([OK,i]));}
    else if(cmd===0xbdaa0002||cmd===0xbdaa0003){const offset=Number(b.readBigUInt64LE(4)-base),n=b.readUInt32LE(12);assert.ok(offset>=0&&offset+n<=memory.length);await send(OK);if(cmd===0xbdaa0002)await send(memory.subarray(offset,offset+n));else{(await read(n)).copy(memory,offset);await send(OK);}}
    else throw Error('Unexpected opcode '+cmd.toString(16));
   }
  })().catch(e=>{if(!/eof|aborted|ECONNRESET/.test(e.message))errors.push(e);socket.destroy();});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));assert.deepEqual(errors,[]);});
 return {port:server.address().port,memory,commands};
}
function elf(){const b=Buffer.alloc(160);b.set([0x7f,69,76,70,2,1,1]);b.writeUInt16LE(2,16);b.writeUInt16LE(62,18);b.writeBigUInt64LE(64n,32);b.writeUInt16LE(64,52);b.writeUInt16LE(56,54);b.writeUInt16LE(1,56);b.writeUInt32LE(1,64);b.writeBigUInt64LE(120n,72);b.writeBigUInt64LE(0x4000n,80);b.writeBigUInt64LE(40n,96);b.writeBigUInt64LE(64n,104);return b;}

test('PS5 identity uses raw uint16 replies before memory access, with fragmented packets and host scanning',async t=>{
 const f=await fixture(t),w=await new Workbench(await directory(t)).init();t.after(()=>w.disconnect());
 await w.setProfile({...w.profile,platform:'ps5',debugPort:f.port,firmware:'13.60'});
 const result=await w.connect();assert.equal(result.capabilities.firmware,'13.60');assert.equal(result.capabilities.platformId,5);assert.equal(result.capabilities.capabilityLevel,'1.1');assert.equal(result.capabilities.nativeScan,false);
 assert.deepEqual(f.commands.slice(0,4),[0xbd000502,0xbd000500,0xbd000501,0xbdaa0001]);assert.equal((await w.call('process_info',{pid:7})).titleId,'PPSA12345');
 assert.equal((await w.call('memory_read',{pid:7,address:String(base),length:4})).hex,'64000000');
 await w.call('scan_start',{pid:7,type:'u32',mode:'exact',value:'100',backend:'auto'});await w.scanner.running;assert.equal(w.scanner.status().state,'complete');
 const scan=w.scanner.status();const results=await w.call('scan_results',{sessionId:scan.sessionId});assert.equal(results.count,1);assert.equal(results.backend,'host');
 await w.call('dump_start',{pid:7,start:String(base),end:String(base+256n)});await w.dumps.running;assert.equal(w.dumps.status().state,'complete');
 await assert.rejects(w.call('memory_write',{pid:7,address:String(base),expectedHex:'64000000',hex:'65000000'},'mcp'),/disabled/);
 await w.call('mcp_settings',{writes:true});assert.equal((await w.call('memory_write',{pid:7,address:String(base),expectedHex:'64000000',hex:'65000000'},'mcp')).verified,true);assert.equal(f.memory.readUInt32LE(),101);
});

test('PS5 connections reject the wrong platform and do not enumerate or write memory',async t=>{
 const f=await fixture(t,{platform:4}),w=await new Workbench(await directory(t)).init();await w.setProfile({...w.profile,platform:'ps5',debugPort:f.port});await assert.rejects(w.connect(),/does not identify as PS5/);assert.deepEqual(f.commands,[0xbd000502]);assert.equal(w.status().mode,'disconnected');
});

test('PS5 metadata rejects unknown branding without falling through to PS4 receiver capabilities',async t=>{
 const f=await fixture(t,{brand:'other service'}),c=await new PS5Debug({host:'127.0.0.1',port:f.port}).connect();await assert.rejects(c.detectCapabilities(),/branding/);assert.equal(c.connected,false);
 assert.equal(compatibility('10.01',{firmware:'10.01'},'ps5').hardwareTested,false);
});

test('PS5 profile persists, blocks all PS4 receiver operations and never probes the loader',async t=>{
 const dir=await directory(t),w=await new Workbench(dir).init();let loaderConnections=0;
 const loader=net.createServer(s=>{loaderConnections++;s.end();});await new Promise(r=>loader.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>loader.close(r)));
 await w.setProfile({...w.profile,platform:'ps5',payloadPort:loader.address().port});assert.equal((await new Workbench(dir).init()).profile.platform,'ps5');
 assert.equal(w.packages.receiver,w.ps5Receiver);
 for(const method of ['pkg_load','pkg_install','pkg_queue_start','pkg_control','console_action'])await assert.rejects(w.call(method,{},'mcp'),/desktop/);
 await assert.rejects(w.call('pkg_check',{}),/Load the background receiver/);
 await assert.rejects(w.call('console_load',{},'mcp'),/desktop/);
 const status=await w.call('probe');assert.equal(status[2].skipped,true);assert.equal(status[2].open,null);assert.equal(loaderConnections,0);
 await assert.rejects(w.setProfile({...w.profile,platform:'ps6'}),/platform/);
});

test('PS5 native integer scanner is enabled only for the validated NG version',async t=>{
 const f=await fixture(t,{brand:'ps5debug-NG by OSR v1.3.2\0'+'1.1'}),client=await new PS5Debug({host:'127.0.0.1',port:f.port}).connect();t.after(()=>client.close());
 assert.equal((await client.detectCapabilities()).nativeScan,true);
 assert.deepEqual(f.commands,[0xbd000502,0xbd000500,0xbd000501]);
});

test('PS5 ELF validation rejects PS4 binaries and malformed segment bounds before opening the loader',async t=>{
 assert.equal(validatePS5Elf(elf()).segments,1);assert.throws(()=>validatePS5Elf(Buffer.alloc(160)),/ELF/);
 const bad=elf();bad.writeBigUInt64LE(500n,96);assert.throws(()=>validatePS5Elf(bad),/segment/);
 const dir=await directory(t),w=await new Workbench(dir).init();await w.setProfile({...w.profile,platform:'ps5'});
 const invalid=path.join(dir,'renamed.elf');await writeFile(invalid,Buffer.alloc(160));await assert.rejects(w.payload({local:invalid}),/PS4 .bin/);
});

test('PS5 ELF transfer sends exact validated bytes without an empty loader probe; duplicate debugger is refused',async t=>{
 const dir=await directory(t),w=await new Workbench(dir).init(),chunks=[];let connections=0;
 const loader=net.createServer(s=>{connections++;s.on('data',b=>chunks.push(b));s.on('end',()=>s.end());});await new Promise(r=>loader.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>loader.close(r)));
 await w.setProfile({...w.profile,platform:'ps5',payloadPort:loader.address().port});const local=path.join(dir,'test.elf');await writeFile(local,elf());const sent=await w.payload({local});await new Promise(r=>setTimeout(r,10));assert.equal(sent.format,'ELF64');assert.equal(connections,1);assert.deepEqual(Buffer.concat(chunks),elf());
 const debuggerServer=net.createServer(s=>s.end());await new Promise(r=>debuggerServer.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>debuggerServer.close(r)));
 await w.setProfile({...w.profile,debugPort:debuggerServer.address().port});const debug=path.join(dir,'ps5debug.elf');await writeFile(debug,elf());await assert.rejects(w.payload({local:debug}),/already listening/);assert.equal(connections,1);
});

test('real MCP transport shares PS5 identity, reads and receiver restrictions',async t=>{
 const f=await fixture(t),dir=await directory(t),backend=await startServer({directory:dir});t.after(()=>backend.close());await backend.workbench.setProfile({...backend.workbench.profile,platform:'ps5',debugPort:f.port});
 const mcp=new Client({name:'ps5-test',version:'1'});await mcp.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('src/mcp.mjs')],env:{...process.env,PSN_DATA:dir}}));t.after(()=>mcp.close());
 const connected=await mcp.callTool({name:'psn_connect',arguments:{}});assert.equal(connected.structuredContent.result.capabilities.platform,'ps5');
 const read=await mcp.callTool({name:'psn_memory_read',arguments:{pid:7,address:String(base),length:4}});assert.equal(read.structuredContent.result.hex,'64000000');
 const blocked=await mcp.callTool({name:'psn_pkg_check',arguments:{}});assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/Load the background receiver/);
});

test('PS5 FTP inventory includes PPSA and PS4 titles without calling PS4 native APIs',async t=>{
 const dir=await directory(t),dbPath=path.join(dir,'app.db'),db=new DatabaseSync(dbPath);
 db.exec("CREATE TABLE tbl_appbrowse_1(titleId TEXT,titleName TEXT,contentSize INTEGER,category TEXT); INSERT INTO tbl_appbrowse_1 VALUES('PPSA12345','PS5 Test',120,'gd'),('CUSA12345','PS4 Test',80,'gd');");db.close();
 const files=new Map([['/system_data/priv/mms/app.db',await readFile(dbPath)],['/user/app/PPSA12345/app.pkg',Buffer.alloc(120)],['/user/app/CUSA12345/app.pkg',Buffer.alloc(80)]]),paths=[];
 const client={cd:async remote=>{client.cwd=remote;},access:async()=>{},close:()=>{},list:async root=>{root=client.cwd;paths.push(root);const entries=new Map();for(const [file,data] of files){if(!file.startsWith(root+'/'))continue;const rel=file.slice(root.length+1),name=rel.split('/')[0],isDirectory=rel.includes('/');entries.set(name,{name,isDirectory,isFile:!isDirectory,size:isDirectory?0:data.length});}if(!entries.size){const e=Error('Not found');e.code=550;throw e;}return [...entries.values()];},downloadTo:async(local,remote)=>writeFile(local,files.get(remote))};
 const receiver={ready:true,host:'127.0.0.1',consoleCapabilities:()=>{throw Error('Must not invoke PS4 receiver');}};
 const manager=new ConsoleManager({directory:dir,profile:()=>({platform:'ps5',host:'127.0.0.1',ftpPort:2121}),packages:{receiver},clientFactory:()=>client});manager.refresh();await manager.running;
 assert.equal(manager.job.state,'complete',manager.job.error);assert.equal(manager.status().receiverReady,false);assert.equal(manager.snapshot.games.length,2);assert.equal(manager.snapshot.games[0].name,'PS5 Test');assert.equal(manager.snapshot.drives.length,0);assert.deepEqual(manager.snapshot.saves,[]);
});
