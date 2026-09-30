import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PS5Saves,fileHash,saveRelative} from '../src/ps5-saves.mjs';
import {Receiver} from '../src/pkg-receiver.mjs';
import {Workbench} from '../src/workbench.mjs';

async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'psn-saves-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const save={id:'abcd:PPSA12345',titleId:'PPSA12345',userId:'abcd',name:'Test game',root:'/user/home/abcd/savedata_prospero/PPSA12345'};
 const profile={platform:'ps5',host:'192.0.2.1'},m={directory,backup:{},profile:()=>profile,ps5AppInfo:async()=>({running:false}),requireReceiver(){},receiver:{consoleCapabilities:async()=>({saveMount:true}),saveStatus:async()=>({mounted:false})}};
 const tool=new PS5Saves(m),folder=path.join(directory,'export'),slot='sdimg_slot';await mkdir(path.join(folder,slot,'sce_sys'),{recursive:true});
 await writeFile(path.join(folder,slot,'data.bin'),'original');await writeFile(path.join(folder,slot,'sce_sys','param.sfo'),'protected');
 const files=[];for(const p of ['data.bin','sce_sys/param.sfo']){const file=path.join(folder,slot,p);files.push({path:p,size:(await readFile(file)).length,sha256:await fileHash(file)});}
 const manifest={format:'psn-ps5-decrypted-v1',complete:true,host:profile.host,sourceId:save.id,titleId:save.titleId,userId:save.userId,slots:[{name:slot,files,originalSha256:'a'.repeat(64)}]};
 await writeFile(path.join(folder,'manifest.json'),JSON.stringify(manifest));return {directory,save,profile,m,tool,folder,slot,manifest};
}
test('decrypted restore preview accepts edited game files but rejects metadata, added files, stale identity and multiple slots',async t=>{
 const f=await fixture(t);await assert.rejects(f.tool.editPlan(f.save,f.profile,f.folder),/No edited files/);
 await writeFile(path.join(f.folder,f.slot,'data.bin'),'edited');let p=await f.tool.editPlan(f.save,f.profile,f.folder);assert.equal(p.slot.changes[0].path,'data.bin');
 await writeFile(path.join(f.folder,f.slot,'sce_sys','param.sfo'),'corrupt');await assert.rejects(f.tool.editPlan(f.save,f.profile,f.folder),/sce_sys/);
 await writeFile(path.join(f.folder,f.slot,'sce_sys','param.sfo'),'protected');await writeFile(path.join(f.folder,f.slot,'extra.bin'),'extra');await assert.rejects(f.tool.editPlan(f.save,f.profile,f.folder),/adding or removing/);
 await assert.rejects(f.tool.editPlan(f.save,{...f.profile,host:'192.0.2.2'},f.folder),/this console/);
 await rm(path.join(f.folder,f.slot,'extra.bin'));
 const second='sdimg_second';await mkdir(path.join(f.folder,second));await writeFile(path.join(f.folder,second,'data.bin'),'also edited');
 f.manifest.slots.push({name:second,files:[f.manifest.slots[0].files[0]],originalSha256:'b'.repeat(64)});
 await writeFile(path.join(f.folder,'manifest.json'),JSON.stringify(f.manifest));await assert.rejects(f.tool.editPlan(f.save,f.profile,f.folder),/one save container/);
 for(const value of ['../escape','/absolute','sce_sys/../../file','a\\b','CON','file:stream','name.'])assert.throws(()=>saveRelative(value));
});
test('mount-copy cleanup unmounts on errors but never retries an uncertain unmount or removes a possibly mounted image',async t=>{
 const f=await fixture(t),local=path.join(f.directory,'image');await writeFile(local,'image');const calls=[];
 const c={ensureDir:async()=>{},uploadFrom:async()=>{},cd:async()=>{},remove:async p=>calls.push('remove'),removeDir:async p=>calls.push('removeDir')};
 f.m.receiver.saveCommand=async action=>{calls.push(action);return {path:'/stage/mount'};};
 await assert.rejects(f.tool.withImage(c,local,async()=>{throw Error('Download failed');}),/Download failed/);assert.deepEqual(calls,['mount','unmount','remove','removeDir']);
 calls.length=0;f.m.receiver.saveCommand=async action=>{calls.push(action);if(action==='unmount')throw Error('Lost reply');return {path:'/stage/mount'};};
 await assert.rejects(f.tool.withImage(c,local,async()=>{}),/Lost reply/);assert.deepEqual(calls,['mount','unmount']);
});
test('save wire commands validate paths and exact identity stamp before reaching the receiver',async()=>{
 const r=new Receiver({platform:'ps5'}),session=randomUUID(),target={session,userId:'abcd',titleId:'PPSA12345',slot:'sdimg_slot'},calls=[];
 r.command=async(op,body)=>{calls.push({op,body});return {code:0,body:Buffer.alloc(op===21?44:0)};};
 const stamp=await r.saveTargetInfo(target);await r.saveCommit(target,stamp);assert.deepEqual(calls.map(c=>c.op),[21,22]);assert.equal(calls[0].body.toString(),session+'0000abcdPPSA12345sdimg_slot');
 await assert.rejects(r.saveCommit({...target,slot:'sdimg_../../other'},stamp),/Invalid/);await assert.rejects(r.saveCommit(target,'00'),/Invalid/);
 await assert.rejects(new Receiver().saveCommand('mount',session),/Invalid/);assert.equal(calls.length,2);
});
test('restore applies only verified replacements and preserves recovery files after a lost commit response',async t=>{
 const f=await fixture(t),id=randomUUID(),edited=path.join(f.directory,'edited'),original=path.join(f.directory,'original');await writeFile(edited,'edited');await writeFile(original,'original');
 const target={session:id,userId:f.save.userId,titleId:f.save.titleId,slot:f.slot},stamp='00'.repeat(44),remote=f.save.root+'/'+f.slot,incoming=f.save.root+'/.psn-new-'+id+'-'+f.slot,old=f.save.root+'/.psn-old-'+id+'-'+f.slot;
 const plan={id,save:f.save,profile:f.profile,slot:f.slot,edited,original,sha256:await fileHash(edited),originalSha256:await fileHash(original),stamp,target,backup:f.directory,directory:f.directory,createdAt:Date.now()};
 const fs=new Map([[remote,await readFile(original)]]);let uncertain=false,uploads=0,corruptRecovery=false,commits=0;
 const c={uploadFrom:async(local,p)=>{uploads++;fs.set(p,corruptRecovery&&p===old?Buffer.from('corrupt'):await readFile(local));},downloadTo:async(local,p)=>{assert.ok(fs.has(p));await writeFile(local,fs.get(p));},remove:async p=>fs.delete(p)};
 f.m.list=async()=>[];f.m.ftp=async(_,fn)=>fn(c);f.m.receiver.saveTargetInfo=async()=>stamp;
 f.m.receiver.saveCommit=async()=>{commits++;assert.equal(fs.get(old).toString(),'original');fs.set(remote,fs.get(incoming));fs.delete(incoming);if(uncertain)throw Error('Lost response');};
 f.tool.plans.set(id,plan);await assert.rejects(f.tool.apply(id,'wrong'),/Confirm/);assert.equal(uploads,0);
 f.m.receiver.saveTargetInfo=async()=>'11'.repeat(44);await assert.rejects(f.tool.apply(id,f.save.id),/changed/);assert.equal(uploads,0);
 f.m.receiver.saveTargetInfo=async()=>stamp;corruptRecovery=true;await assert.rejects(f.tool.apply(id,f.save.id),/Recovery copy checksum/);assert.equal(commits,0);assert.equal(fs.get(remote).toString(),'original');
 corruptRecovery=false;fs.delete(incoming);fs.delete(old);await f.tool.apply(id,f.save.id);assert.equal(fs.get(remote).toString(),'edited');assert.equal(fs.has(old),false);assert.equal((await readFile(original)).toString(),'original');
 fs.set(remote,await readFile(original));f.tool.plans.set(id,plan);uncertain=true;
 await assert.rejects(f.tool.apply(id,f.save.id),/inspect the console before retrying/);assert.equal(fs.get(old).toString(),'original');
});
test('save operations refuse running games and MCP cannot restore',async t=>{
 const f=await fixture(t);f.m.ps5AppInfo=async()=>({running:true});await assert.rejects(f.tool.export(f.save,f.profile),/Close/);
 const w=new Workbench(f.directory);await assert.rejects(w.call('console_save_restore',{},'mcp'),/desktop/);
});
