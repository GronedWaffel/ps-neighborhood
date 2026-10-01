import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {PackageConversion} from '../src/pkg-conversion.mjs';
import {inspectPackage} from '../src/packages.mjs';
import {PackageQueue} from '../src/package-queue.mjs';
import {Workbench} from '../src/workbench.mjs';

async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'psn-convert-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const local=path.join(directory,'game.pkg'),b=Buffer.alloc(0x6000);b.writeUInt32BE(0x7f464948);b.writeUInt16LE(3,6);b.writeBigUInt64LE(0x100n,0x10);b.writeBigUInt64LE(0x1f00n,0x18);b.writeBigUInt64LE(0x2000n,0x58);
 const h=b.subarray(0x2000);h.writeUInt32BE(0x7f434e54);h.writeUInt32BE(1,0x10);h.writeUInt32BE(0x2000,0x18);h.writeBigUInt64BE(0x2000n,0x20);h.writeBigUInt64BE(0x2000n,0x28);h.write('UP1234-PPSA12345_00-XXXXXXXXXXXXXXXX',0x40);h.writeUInt32BE(0x20,0x74);await writeFile(local,b);
 const script=path.join(directory,'worker.cjs');await writeFile(script,`
 const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
 const [input,work,title]=process.argv.slice(3);
 const content=Buffer.from('image bytes'),output=path.join(work,title+'.ffpfsc'),s=fs.statSync(input);
 fs.writeFileSync(output,content);
 const report={verified:true,titleId:title,source:input,sourceSize:s.size,sourceModifiedUtc:s.mtime.toISOString(),output,imageSize:content.length,imageSha256:crypto.createHash('sha256').update(content).digest('hex'),sourceSha256:'a',decodedSha256:'a'};
 console.log(JSON.stringify({type:'progress',stage:'Testing',done:1,total:2}));
 console.log(JSON.stringify({type:'complete',report}));
 `);
 const profile={platform:'ps5',host:'127.0.0.2',firmware:'13.60'};
 const shadow={items:[{id:'unrelated',local:'other',state:'queued'}],async refresh(){},status(){return {items:this.items};},async add({local}){if(!this.items.some(i=>i.local===local))this.items.push({id:'converted',local,state:'queued'});return this.status();},async save(){},start(args){this.started=args;this.items.find(i=>i.id===args.id).state='complete';this.running=Promise.resolve();},cancel(){this.cancelled=true;}};
 const m=await new PackageConversion({directory,profile:()=>profile,shadow,executable:process.execPath,spawnChild:(exe,args,opts)=>spawn(exe,[script,...args],opts)}).init();
 t.after(()=>m.close());return {directory,local,b,h,script,profile,shadow,m};
}
test('classification uses FIH signature and package type, not extension or filename',async t=>{
 const {local,b,h}=await fixture(t);assert.equal((await inspectPackage(local,{platform:'ps5'})).shadowConvertible,true);
 b[5]=128;await writeFile(local,b);let p=await inspectPackage(local,{platform:'ps5'});assert.equal(p.signing,'retail');assert.equal(p.shadowConvertible,false);
 b[5]=0;h.writeUInt32BE(0x40000000,0x78);await writeFile(local,b);assert.equal((await inspectPackage(local,{platform:'ps5'})).shadowConvertible,false);
 h.writeUInt32BE(0,0x78);h.writeUInt32BE(0x21,0x74);await writeFile(local,b);assert.equal((await inspectPackage(local,{platform:'ps5'})).shadowConvertible,false);
});
test('folder imports require an explicit conversion/native choice for PS5 debug games',async t=>{
 const {directory}=await fixture(t);const queue=new PackageQueue({},p=>inspectPackage(p,{platform:'ps5'}));await queue.addFolder(directory);
 assert.equal(queue.items[0].state,'choose method');assert.equal(queue.status().pending,0);
 queue.useNative(queue.items[0].id);assert.equal(queue.status().pending,1);
});
test('verified conversion preserves source, persists result and transfers only its own queue item',async t=>{
 const {m,local,b,shadow,directory}=await fixture(t);await m.start({local,destination:'/data/games'});await m.running;
 assert.equal(m.job.state,'complete',m.job.error);assert.deepEqual(await readFile(local),b);assert.equal(shadow.items[0].state,'queued');assert.deepEqual(shadow.started,{destination:'/data/games',id:'converted'});assert.equal(shadow.items[1].titleId,'PPSA12345');
 const restored=await new PackageConversion({directory,profile:m.profile,shadow}).init();assert.equal(restored.job.report.verified,true);
});
test('changed image, console mismatch and bad verification never reach transfer',async t=>{
 const {m,local,shadow,profile}=await fixture(t);await m.start({local});await m.running;assert.equal(m.job.state,'ready',m.job.error);
 profile.host='127.0.0.3';await assert.rejects(m.transfer({destination:'/data/games'}),/original target/);profile.host='127.0.0.2';
 await writeFile(m.job.report.output,Buffer.alloc(m.job.report.imageSize));await m.transfer({destination:'/data/games'});await m.running;assert.match(m.job.error,/hash changed/);assert.equal(shadow.started,undefined);
});

test('conversion progress tracks live bytes within a large file and ignores other jobs',async t=>{
 const {m,shadow}=await fixture(t);m.job={state:'transferring',transferId:'image'};
 const item={id:'image',state:'running',processed:0,total:40000};shadow.items.push(item);
 let live={id:'image',state:'running',processed:12000,total:40000,rate:3000,phase:'transferring'};
 shadow.status=()=>({items:shadow.items,job:live});
 assert.equal(m.status().transfer.processed,12000);assert.equal(m.status().transfer.rate,3000);
 live.processed=24000;assert.equal(m.status().transfer.processed,24000);assert.equal(item.processed,0);
 live={id:'unrelated',processed:99999};assert.equal(m.status().transfer.processed,0);
 item.state='complete';item.processed=40000;assert.equal(m.status().transfer.processed,40000);
});
test('cancellation cleans only the private work folder and never transfers',async t=>{
 const {m,script,local,b,shadow}=await fixture(t);await writeFile(script,`const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.argv[4],'partial'),'partial');process.stdin.resume();process.stdin.once('data',()=>process.exit(2));`);
 await m.start({local,destination:'/data/games'});const work=m.job.work;m.cancel();await m.running;
 assert.equal(m.job.state,'cancelled');await assert.rejects(stat(work),/ENOENT/);assert.deepEqual(await readFile(local),b);assert.equal(shadow.started,undefined);
});
test('invalid completion report fails closed and releases the job lock',async t=>{
 const {m,script,local,shadow}=await fixture(t);await writeFile(script,`console.log(JSON.stringify({type:'complete',report:{verified:false}}));`);
 await m.start({local,destination:'/data/games'});await m.running;assert.equal(m.job.state,'failed');assert.equal(m.busy,false);assert.equal(shadow.started,undefined);
});
test('desktop review required and active conversion prevents profile or console mutations',async t=>{
 const {directory}=await fixture(t),w=await new Workbench(directory).init();
 for(const op of ['conversion_plan','conversion_start','conversion_transfer','conversion_cancel'])await assert.rejects(w.call(op,{},'mcp'),/desktop/);
 w.conversion.busy=true;await assert.rejects(w.setProfile({...w.profile}),/conversion/);
 for(const op of ['pkg_install','shadow_start','console_action','payload'])await assert.rejects(w.call(op),/conversion/);
 w.conversion.busy=false;
});
