import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Receiver,titleBytes} from '../src/pkg-receiver.mjs';
import {inspectPackage,PackageInstaller} from '../src/packages.mjs';
import {ConsoleManager} from '../src/console-manager.mjs';

test('PS5 receiver uses PS5 app IDs and title formats, preserving PS4 restrictions',async()=>{
 assert.equal(titleBytes('MOUU12023','ps5').toString(),'MOUU12023');
 assert.throws(()=>titleBytes('PPSA34502','ps4'));
 for(const id of ['NPXS20001','../PPSA12','PPSA1234x'])assert.throws(()=>titleBytes(id,'ps5'));
 const r=new Receiver({platform:'ps5'}),calls=[];
 r.command=async(op,body)=>{calls.push({op,body});const b=Buffer.alloc(op===10?12:0);if(op===10){b.writeInt32LE(1);b.writeInt32LE(24,4);b.writeInt32LE(1,8);}return {code:0,body:b};};
 assert.deepEqual(await r.appInfo('PPSA34502'),{exists:true,appId:24,running:true});
 await r.appAction('close','PPSA34502');assert.equal(calls[1].op,11);assert.equal(calls[1].body.readUInt32LE(),2);assert.equal(calls[1].body.subarray(4).toString(),'PPSA34502');
 await r.power('rest');assert.equal(calls[2].body.readUInt32LE(),3);
});

test('PS5 progress requires native completion, not only transferred bytes',async()=>{
 const r=new Receiver({platform:'ps5'}),b=Buffer.alloc(80);b.writeBigUInt64LE(100n,24);b.writeBigUInt64LE(100n,32);b.write('installing',64);
 r.command=async()=>({code:0,body:b});let p=await r.progress(1);assert.equal(p.completed,false);assert.equal(p.nativeStatus,'installing');
 b.writeUInt32LE(1);b.fill(0,64);b.write('completed',64);p=await r.progress(1);assert.equal(p.completed,true);
 const installer=new PackageInstaller({profile:()=>({platform:'ps5'}),ps5Receiver:r});installer.job={mode:'background',consolePlatform:'ps5',taskId:1};await installer.progress();assert.equal(installer.job.state,'installation complete');
 let action;r.control=async(task,value)=>{assert.equal(task,1);action=value;};await installer.control('pause');assert.equal(action,'pause');assert.equal(installer.job.state,'paused');
 b.writeUInt32LE(0);b.fill(0,64);b.write('paused',64);await installer.progress();assert.equal(installer.job.state,'paused');
 b.writeUInt32LE(0);b.writeInt32LE(-1,4);await installer.progress();assert.match(installer.job.state,/error/);
});

test('PS5 patch requests select the dedicated native status/control path without changing PS4 type values',async()=>{
 for(const platform of ['ps4','ps5']){
  const r=new Receiver({platform});let type;r.command=async(op,b)=>{assert.equal(op,3);type=b.readUInt32LE(8);const body=Buffer.alloc(8);body.writeInt32LE(1);return {code:0,body};};
  await r.install({contentId:'EP4433-CUSA00265_00-MINECRAFTPS40000',name:'update.pkg',size:1000,type:0x1a,kind:'Patch'},'http://127.0.0.1/package.pkg');
  assert.equal(type,platform==='ps5'?0x8000001a:0x1a);
 }
});

test('PS5 finalized PKGs validate bounds and homebrew IDs without accepting system packages',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'psn-ps5-pkg-'));t.after(()=>rm(dir,{recursive:true,force:true}));const local=path.join(dir,'browser.pkg');
 const b=Buffer.alloc(0x6000);b.writeUInt32BE(0x7f464948);b.writeUInt16LE(3,6);b.writeBigUInt64LE(0x100n,0x10);b.writeBigUInt64LE(0x1f00n,0x18);b.writeBigUInt64LE(0x2000n,0x58);
 const h=b.subarray(0x2000);h.writeUInt32BE(0x7f434e54);h.writeUInt32BE(1,0x10);h.writeUInt32BE(0x2000,0x18);h.writeBigUInt64BE(0x2000n,0x20);h.writeBigUInt64BE(0x2000n,0x28);h.write('IV9999-MOUU12023_00-XXXXXXXXXXXXXXXX',0x40);h.writeUInt32BE(0x26,0x74);await writeFile(local,b);
 const pkg=await inspectPackage(local,{platform:'ps5'});assert.equal(pkg.platform,'ps5');assert.equal(pkg.titleId,'MOUU12023');await assert.rejects(inspectPackage(local),/PS5 console/);
 h.write('NPXS20001',0x47);await writeFile(local,b);await assert.rejects(inspectPackage(local,{platform:'ps5'}),/content ID/);
 h.write('PPSA12345',0x47);h.writeBigUInt64BE(0x3000n,0x28);await writeFile(local,b);await assert.rejects(inspectPackage(local,{platform:'ps5'}),/truncated/);
});

test('PS5 console actions enforce current library, confirmation, capability and running-title guards',async()=>{
 const calls=[],receiver={ready:true,host:'127.0.0.1',consoleCapabilities:async()=>({launch:true,close:true,uninstall:true,patch:false}),appInfo:async()=>({exists:true,running:true,appId:24}),appAction:async(...args)=>{calls.push(args);return {accepted:true};}};
 const c=new ConsoleManager({profile:()=>({platform:'ps5',host:'127.0.0.1'}),ps5Receiver:receiver,packages:{queue:{}}});
 c.snapshot={host:'127.0.0.1',updatedAt:'now',games:[{titleId:'PPSA34502',managed:true,patchBytes:10}]};
 await assert.rejects(c.action({action:'close',titleId:'PPSA34502',confirmation:'wrong'}),/Confirmation/);
 await assert.rejects(c.action({action:'uninstall',titleId:'PPSA34502',confirmation:'PPSA34502'}),/Close this game/);
 await assert.rejects(c.action({action:'patch',titleId:'PPSA34502',confirmation:'PPSA34502'}),/unavailable/);
 await c.action({action:'close',titleId:'PPSA34502',confirmation:'PPSA34502'});assert.deepEqual(calls,[['close','PPSA34502']]);
});
