import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ShadowMount,inspectShadowSource,shadowPath} from '../src/shadowmount.mjs';
import {ShadowApi,parseShadowHttp} from '../src/shadowmount-api.mjs';
import {Workbench} from '../src/workbench.mjs';
const missing=()=>Object.assign(Error('missing'),{code:550});
class FTP {
 constructor(){this.files=new Map();this.dirs=new Set(['/data/games','/user/app']);this.events=[];}
 async access(){} close(){} async cd(p){if(!this.dirs.has(p))throw missing();this.cwd=p;}
 async list(){return [...new Set([...this.files.keys(),...this.dirs].filter(p=>path.posix.dirname(p)===this.cwd).map(p=>path.posix.basename(p)))].map(name=>({name}));}
 async size(p){if(!this.files.has(p))throw missing();return this.files.get(p).length;}
 async ensureDir(p){this.dirs.add(p);}
 async uploadFrom(stream,p){this.events.push(['upload',p]);if(this.fail?.(p))throw Error('Network interrupted');let chunks=[];for await(const b of stream)chunks.push(Buffer.from(b));this.files.set(p,Buffer.concat(chunks));}
 async downloadTo(stream,p){if(!this.files.has(p))throw missing();stream.end(this.files.get(p));}
 async rename(a,b){this.events.push(['rename',a,b]);if(this.files.has(a)){this.files.set(b,this.files.get(a));this.files.delete(a);}else if(this.dirs.has(a)){for(const [k,v] of [...this.files])if(k.startsWith(a+'/')){this.files.set(b+k.slice(a.length),v);this.files.delete(k);}for(const d of [...this.dirs])if(d===a||d.startsWith(a+'/')){this.dirs.delete(d);this.dirs.add(b+d.slice(a.length));}}else throw missing();if(this.afterRename)await this.afterRename(a,b);}
}
async function fixture(t){const directory=await mkdtemp(path.join(os.tmpdir(),'psn-shadow-'));t.after(()=>rm(directory,{recursive:true,force:true}));const local=path.join(directory,'game');await mkdir(path.join(local,'sce_sys'),{recursive:true});await writeFile(path.join(local,'sce_sys/param.json'),JSON.stringify({titleId:'PPSA12345',localizedParameters:{'en-US':{titleName:'Test Game'}}}));await writeFile(path.join(local,'eboot.bin'),'binary');await writeFile(path.join(local,'data.bin'),'game data');const ftp=new FTP(),calls=[];let free=1e10;
 const api={port:10101,async call(route){calls.push(route);return {version:{status:0,api_version:1,shadowmount_version:'1.7'},storage:{destinations:[{path:'/data/games',available_bytes:free}],mounts:[]},settings:{scan_paths:['/data/games']},games:{games:ftp.files.has('/data/games/PPSA12345/sce_sys/param.json')?[{title_id:'PPSA12345',path:'/data/games/PPSA12345'}]:[]},scan:{status:0}}[route];}};
 const manager=await new ShadowMount({directory,profile:()=>({platform:'ps5',host:'console',ftpPort:1337}),receiver:{},api,clientFactory:()=>ftp,pollDelay:1,registrationWait:2}).init();await manager.refresh();await manager.add({local});return {manager,ftp,local,calls,setFree:x=>free=x};}
test('folder is staged, checked, and published with metadata last',async t=>{const {manager:m,ftp,calls,setFree}=await fixture(t);ftp.afterRename=()=>{if(ftp.files.has('/data/games/PPSA12345/sce_sys/param.json'))setFree(1e9);};m.start({destination:'/data/games'});await m.running;assert.equal(m.items[0].state,'complete');assert.equal(m.items[0].registered,true);assert.equal(m.snapshot.destinations[0].available_bytes,1e9);assert.equal(ftp.events.at(-1)[2],'/data/games/PPSA12345/sce_sys/param.json');assert.ok(ftp.events.filter(e=>e[0]==='upload').every(e=>!e[1].endsWith('/param.json')));assert.ok(calls.includes('scan'));assert.equal(m.status().items[0].completedFiles,3);});

test('targeted converted-image transfer leaves unrelated queue entries untouched',async t=>{
 const {manager:m,ftp}=await fixture(t);const local=path.join(m.directory,'PPSA33333.ffpfsc');await writeFile(local,'verified image');await m.add({local});
 const target=m.items[1];target.titleId='PPSA33333';m.start({destination:'/data/games',id:target.id});await m.running;
 assert.equal(target.state,'complete');assert.equal(m.items[0].state,'queued');assert.ok(ftp.files.has('/data/games/PPSA33333.ffpfsc'));
});

test('converted images refuse to replace an already installed title',async t=>{
 const {manager:m,ftp}=await fixture(t);const local=path.join(m.directory,'PPSA33333.ffpfsc');await writeFile(local,'verified image');await m.add({local});
 const target=m.items[1];target.titleId='PPSA33333';ftp.dirs.add('/user/app/PPSA33333');m.start({destination:'/data/games',id:target.id});await m.running;
 assert.equal(target.state,'failed');assert.match(target.error,/already installed/);assert.equal(ftp.events.length,0);
});
test('interrupted copy resumes completed files without exposing a game',async t=>{const {manager:m,ftp}=await fixture(t);ftp.fail=p=>p.endsWith('/eboot.bin');m.start({destination:'/data/games'});await m.running;assert.equal(m.items[0].state,'failed');assert.ok(!ftp.files.has('/data/games/PPSA12345/sce_sys/param.json'));ftp.fail=null;m.start({destination:'/data/games'});await m.running;assert.equal(m.items[0].state,'complete');assert.equal(ftp.events.filter(e=>e[0]==='upload'&&e[1].endsWith('/data.bin')).length,1);});
test('published folder recovers after metadata rename interruption',async t=>{const {manager:m,ftp}=await fixture(t);ftp.afterRename=()=>{if(ftp.files.has('/data/games/PPSA12345/sce_sys/param.json'))throw Error('Lost final acknowledgment');};m.start({destination:'/data/games'});await m.running;assert.equal(m.items[0].state,'failed');ftp.afterRename=null;m.start({destination:'/data/games'});await m.running;assert.equal(m.items[0].state,'complete');});
test('space refusal, existing game and changed source never publish',async t=>{const {manager:m,ftp,local,setFree}=await fixture(t);setFree(1);m.start({destination:'/data/games'});await m.running;assert.match(m.items[0].error,/free space/);assert.equal(ftp.events.length,0);setFree(1e10);ftp.dirs.add('/data/games/PPSA12345');m.start({destination:'/data/games'});await m.running;assert.match(m.items[0].error,/already exists/);assert.equal(ftp.events.length,0);await writeFile(path.join(local,'eboot.bin'),'changed binary');m.start({destination:'/data/games'});await m.running;assert.match(m.items[0].error,/source changed/);});
test('cancellation retains staging and can be retried',async t=>{const {manager:m,ftp}=await fixture(t);const upload=ftp.uploadFrom.bind(ftp);ftp.uploadFrom=async(s,p)=>{await upload(s,p);if(p.endsWith('/data.bin'))m.cancel();};m.start({destination:'/data/games'});await m.running;assert.equal(m.items[0].state,'cancelled');assert.ok(!ftp.files.has('/data/games/PPSA12345/sce_sys/param.json'));ftp.uploadFrom=upload;m.start({destination:'/data/games'});await m.running;assert.equal(m.items[0].state,'complete');});
test('image publishes only after transfer and supports published retry',async t=>{const {manager:m,ftp,local}=await fixture(t);m.items=[];const image=path.join(path.dirname(local),'test.ffpkg');await writeFile(image,'image bytes');await m.add({local:image});m.start({destination:'/data/games'});await m.running;assert.equal(m.items[0].state,'complete');assert.equal(ftp.files.get('/data/games/test.ffpkg').toString(),'image bytes');m.items[0].state='interrupted';m.start({destination:'/data/games'});await m.running;assert.equal(m.items[0].state,'complete');});
test('source formats and normalized console paths are validated',async t=>{const {local}=await fixture(t);assert.equal((await inspectShadowSource(local)).titleId,'PPSA12345');for(const p of ['/','/data/../user','/data//games','/data/games/'])assert.throws(()=>shadowPath(p));await writeFile(path.join(local,'bad.psn-pending'),'x');await assert.rejects(inspectShadowSource(local),/reserved filename/);});
test('bridge parses framing and rejects errors and incomplete data',()=>{const json=JSON.stringify({status:0,api_version:1});assert.equal(parseShadowHttp(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: '+Buffer.byteLength(json)+'\r\n\r\n'+json)).api_version,1);assert.equal(parseShadowHttp(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'+json.length.toString(16)+'\r\n'+json+'\r\n0\r\n\r\n')).status,0);assert.throws(()=>parseShadowHttp(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n'+json)),/Incomplete/);assert.throws(()=>parseShadowHttp(Buffer.from('HTTP/1.1 409 Busy\r\n\r\n{"status":16,"error":"game running"}')),/game running/);});
test('API uses authenticated companion and fixed routes only',async()=>{let sent;const receiver={ready:true,host:'console',runtimeInfo:{revision:106},command:async(op,body)=>{sent={op,body};return {code:0,body:Buffer.from('HTTP/1.1 200 OK\r\n\r\n{"status":0}')};}};const api=new ShadowApi({receiver,profile:()=>({host:'console'})});await api.call('games');assert.equal(sent.op,23);assert.equal(sent.body.readUInt16LE(),10101);assert.equal(sent.body.readUInt16LE(2),3);await assert.rejects(api.call('../arbitrary'),/Unsupported/);receiver.runtimeInfo.revision=105;await assert.rejects(api.call('games'),/revision 106/);});
test('fresh profiles discover internal storage and can prepare missing folders despite the alias omission',async t=>{
 const {manager:m,ftp}=await fixture(t);let custom=[],readOnly=false;const prior=m.api.call.bind(m.api);m.api.call=async route=>route==='settings'?{scan_paths:custom}:route==='storage'?{destinations:[],mounts:[{mount_point:'/user',read_only:readOnly,available_bytes:1e10}]}:prior(route);
 await m.refresh();assert.equal(m.snapshot.destinations.length,0);await m.prepare();assert.ok(ftp.dirs.has('/user/data/homebrew'));assert.equal(m.snapshot.destinations[0].path,'/user/data/homebrew');
 const restored=await new ShadowMount({directory:m.directory,profile:m.profile,receiver:{},api:m.api,clientFactory:()=>ftp}).init();assert.equal(restored.internalReady,undefined);await restored.refresh();assert.equal(restored.snapshot.destinations.length,1);
 // A saved preparation flag cannot resurrect a deleted folder or another console's directory.
 ftp.dirs.delete('/user/data/homebrew');restored.internalReady='console';await restored.refresh();assert.equal(restored.snapshot.destinations.length,0);assert.equal(restored.snapshot.internalStorage.canPrepare,true);
 ftp.access=async()=>{throw Error('FTP unavailable');};await restored.refresh();assert.equal(restored.snapshot.destinations.length,0);assert.match(restored.snapshot.internalStorage.error,/FTP unavailable/);ftp.access=async()=>{};
 custom=['/mnt/usb0'];await m.refresh();assert.equal(m.snapshot.destinations.length,0);await assert.rejects(m.prepare(),/Custom/);custom=[];readOnly=true;await m.refresh();assert.equal(m.snapshot.destinations.length,0);
 await assert.rejects(m.prepare(),/read-only/);assert.equal(ftp.dirs.has('/user/data/homebrew'),false);
});
test('existence checks do not accept ftpsrv UINT64_MAX missing-file SIZE replies',async t=>{const {manager:m,ftp}=await fixture(t);ftp.size=async()=>18446744073709552000;assert.equal(await m.exists(ftp,'/data/games/missing'),false);ftp.files.set('/data/games/existing',Buffer.from('x'));assert.equal(await m.exists(ftp,'/data/games/existing'),true);});
test('a matching existing console installation is preserved before copying or publishing',async t=>{
 const {manager:m,ftp}=await fixture(t);ftp.dirs.add('/user/app/PPSA12345');m.start({destination:'/data/games'});await m.running;assert.match(m.items[0].error,/already installed/);assert.equal(ftp.events.length,0);
 ftp.dirs.delete('/user/app/PPSA12345');const upload=ftp.uploadFrom.bind(ftp);ftp.uploadFrom=async(s,p)=>{await upload(s,p);if(p.endsWith('/param.json.psn-pending'))ftp.dirs.add('/user/app/PPSA12345');};m.start({destination:'/data/games'});await m.running;assert.match(m.items[0].error,/already installed/);assert.ok(!ftp.dirs.has('/data/games/PPSA12345'));
});
test('ftpsrv transfers disable its virtual decrypted SELF size/download mode',async t=>{
 const {manager:m,ftp}=await fixture(t);const commands=[];ftp.access=async()=>({message:'220 Welcome to ftpsrv.elf'});ftp.send=async cmd=>{commands.push(cmd);return {message:'226 SELF transfer mode '+(commands.length===1?'enabled':'disabled')};};
 m.start({destination:'/data/games'});await m.running;assert.equal(m.items[0].state,'complete');assert.deepEqual(commands,['SELF','SELF']);
});
test('13.60 batch registration requires confirmation and backs up only the changed config',async t=>{
 const {manager:m,ftp}=await fixture(t);m.receiver={ready:true,host:'console',runtimeInfo:{firmware:'13.60'}};ftp.dirs.add('/data/shadowmount');const original=Buffer.from('# keep this\nquiet_mode=true\napp_install_all=false\n');ftp.files.set('/data/shadowmount/config.ini',original);
 await assert.rejects(m.repairRegistration({}),/Confirm/);let scanArgs;const call=m.api.call.bind(m.api);m.api.call=(route,args)=>{if(route==='scan')scanArgs=args;return call(route,args);};
 const r=await m.repairRegistration({confirmation:'batch-registration'});assert.equal(r.enabled,true);assert.equal(ftp.files.get('/data/shadowmount/config.ini').toString(),'# keep this\nquiet_mode=true\napp_install_all=true\n');const {readFile}=await import('node:fs/promises');assert.deepEqual(await readFile(r.backup),original);assert.deepEqual(scanArgs,{reset_attempts:true});
});
test('refresh reconciles delayed recognition across data aliases and persists it',async t=>{
 const {manager:m}=await fixture(t);const item=m.items[0];Object.assign(item,{state:'complete',target:'/user/data/homebrew/PPSA12345',registered:false,registrationNote:'Awaiting detection'});
 const call=m.api.call.bind(m.api);m.api.call=(route,args)=>route==='games'?Promise.resolve({games:[{title_id:'PPSA12345',path:'/data/homebrew/PPSA12345'}]}):call(route,args);
 item.host='other-console';await m.refresh();assert.equal(item.registered,false);item.host='console';await m.refresh();assert.equal(item.registered,true);assert.equal(item.registrationNote,undefined);
 const restored=await new ShadowMount({directory:m.directory,profile:m.profile,receiver:{},api:m.api}).init();assert.equal(restored.items[0].registered,true);
});
test('ShadowMount console mutations stay desktop-only and active copies block conflicting controls',async t=>{
 const {manager:m}=await fixture(t);const w=await new Workbench(m.directory).init();
 for(const op of ['shadow_load','shadow_prepare','shadow_start','shadow_cancel','shadow_action','shadow_scan','shadow_remove','shadow_repair_registration'])await assert.rejects(w.call(op,{},'mcp'),/desktop/);
 w.mode='demo';await assert.rejects(w.call('shadow_refresh'),/memory lab/);w.mode='disconnected';w.shadow.busy=true;
 for(const op of ['payload','ftp_upload','console_action','pkg_install','console_load'])await assert.rejects(w.call(op),/ShadowMount/);
 await assert.rejects(w.setProfile({...w.profile}),/ShadowMount/);w.shadow.busy=false;await w.shadow.close();
});
