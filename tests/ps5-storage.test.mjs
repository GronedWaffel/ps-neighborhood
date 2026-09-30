import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ConsoleManager} from '../src/console-manager.mjs';
import {Workbench} from '../src/workbench.mjs';
import {parseStorage} from '../src/pkg-receiver.mjs';
import {readCatalog} from '../src/console-manager.mjs';
import {DatabaseSync} from 'node:sqlite';
import {readAddons} from '../src/console-content.mjs';

test('PS5 add-on catalog preserves names for PS4 and PS5 content while excluding system titles',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'psn-ps5-addons-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'addcont.db'),db=new DatabaseSync(file);
 db.exec("CREATE TABLE addcont(title_id TEXT,dir_name TEXT,title TEXT); INSERT INTO addcont VALUES('CUSA00265','KMP0000000000001','Map pack'),('PPSA12345','EXTRA00000000001','PS5 add-on'),('NPXS40000','SYSTEM','System item')");db.close();
 const ps5=readAddons(file,{platform:'ps5'});assert.equal(ps5.size,2);assert.equal(ps5.get('CUSA00265')[0].name,'Map pack');assert.equal(ps5.get('PPSA12345')[0].name,'PS5 add-on');assert.equal(readAddons(file).size,1);
});

test('PS5 content catalog reads PS4 and PS5 names without treating system titles as games',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'psn-ps5-catalog-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'app.db'),db=new DatabaseSync(file);
 db.exec("CREATE TABLE tbl_contentinfo(titleId TEXT,titleName TEXT,contentId TEXT,size INTEGER); INSERT INTO tbl_contentinfo VALUES('CUSA12345','PS4 title','cid',100),('PPSA12345','PS5 title','pid',200),('NPXS40000','System','sid',300),('PPSA99999','Not installed','nid',0)");db.close();
 const result=readCatalog(file,{platform:'ps5'});assert.equal(result.size,2);assert.equal(result.get('CUSA12345').name,'PS4 title');assert.equal(result.get('PPSA12345').catalogSize,200);
});

test('PS5 names, separate save layouts, storage mounts and keyless encrypted archives',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'psn-ps5-storage-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const save='/user/home/abcd/savedata_prospero/PPSA12345',meta='/user/home/abcd/savedata_prospero_meta/user/PPSA12345';
 const files=new Map([
 ['/user/app/PPSA12345/app.pkg',Buffer.alloc(16)],
 ['/user/appmeta/PPSA12345/param.json',Buffer.from(JSON.stringify({titleId:'PPSA12345',contentVersion:'01.020.000',localizedParameters:{defaultLanguage:'en-US','en-US':{titleName:'PS5 title'}}}))],
 [save+'/sdimg_save',Buffer.alloc(12,3)],[meta+'/icon.png',Buffer.from('icon')]
 ]);
 let running=false,changed=false;
 const client={cd:async remote=>{client.cwd=remote;},access:async()=>{},close:()=>{},trackProgress:()=>{},list:async root=>{root=client.cwd;
 const entries=new Map();for(const [p,data] of files){if(!p.startsWith(root+'/'))continue;const relative=p.slice(root.length+1),name=relative.split('/')[0],dir=relative.includes('/');entries.set(name,{name,isDirectory:dir,isFile:!dir,size:dir?0:data.length,rawModifiedAt:changed?'new':'old'});}if(!entries.size){const e=Error('Missing');e.code=550;throw e;}return [...entries.values()];
 },downloadTo:async(target,remote)=>{const data=files.get(remote);if(!data){const e=Error('Missing');e.code=550;throw e;}if(typeof target==='string')await writeFile(target,data);else await new Promise((resolve,reject)=>{target.on('error',reject);target.on('finish',resolve);target.end(data);});if(client.changeDuringBackup&&remote===save+'/sdimg_save')changed=true;}};
 const ps5Receiver={ready:true,host:'127.0.0.1',runtimeInfo:{firmware:'13.60'},consoleCapabilities:async()=>({storage:true}),storage:async index=>({index,path:['/user','/mnt/ext0','/mnt/ext1','/user2'][index],mount:index?'/':'/user',total:1000,free:500,available:400,used:500,fsid:'0'})};
 const manager=new ConsoleManager({directory,profile:()=>({platform:'ps5',host:'127.0.0.1',firmware:'13.60'}),packages:{receiver:{ready:true,consoleCapabilities:()=>{throw Error('PS4 receiver invoked');}},queue:{}},ps5Receiver,ps5AppInfo:async()=>({running}),debuggerInfo:()=>({platform:'ps5',firmware:'13.60'}),clientFactory:()=>client});
 manager.refresh();await manager.running;assert.equal(manager.job.state,'complete',manager.job.error);assert.equal(manager.snapshot.games[0].name,'PS5 title');assert.equal(manager.snapshot.games[0].version,'01.020.000');assert.equal(manager.snapshot.drives.length,1);assert.equal(manager.snapshot.saves[0].format,'ps5-encrypted-archive');assert.equal(manager.status().backupReady,true);
 manager.startBackup({id:'abcd:PPSA12345'});await manager.backupRunning;assert.equal(manager.backup.state,'complete',manager.backup.error);
 const manifest=JSON.parse(await readFile(path.join(manager.backup.local,'manifest.json')));assert.equal(manifest.format,'PS5 encrypted save archive');assert.equal(manifest.complete,true);assert.equal(manifest.files.length,2);assert.match(manifest.note,/same-console.user restore/);assert.match(manifest.note,/account portability is not supported/);
 running=true;manager.startBackup({id:'abcd:PPSA12345'});await manager.backupRunning;assert.equal(manager.backup.state,'failed');assert.match(manager.backup.error,/Close/);
 running=false;client.changeDuringBackup=true;manager.startBackup({id:'abcd:PPSA12345'});await manager.backupRunning;assert.equal(manager.backup.state,'failed');assert.match(manager.backup.error,/changed/);
});

test('PS5 save-use checks fail closed when debugger or game identity is unavailable',async()=>{
 const w=new Workbench('unused');w.profile.platform='ps5';await assert.rejects(w.ps5AppInfo('PPSA12345'),/Connect/);
 w.mode='live';w.client={connected:true,processes:async()=>[{name:'eboot.bin',pid:4}],info:async()=>({titleId:''})};await assert.rejects(w.ps5AppInfo('PPSA12345'),/Cannot identify/);
 w.client.info=async()=>({titleId:'PPSA12345'});assert.equal((await w.ps5AppInfo('PPSA12345')).running,true);assert.equal((await w.ps5AppInfo('PPSA98765')).running,false);
});

test('PS5 storage parsing retains its separate mount list and rejects corrupt capacities',()=>{
 const b=Buffer.alloc(120);b.writeBigUInt64LE(1000n);b.writeBigUInt64LE(500n,8);b.writeBigUInt64LE(400n,16);b.write('/user2',32);
 assert.equal(parseStorage(b,3,'ps5').path,'/user2');b.writeBigUInt64LE(501n,16);assert.throws(()=>parseStorage(b,3,'ps5'),/Invalid/);
});

test('PS5 revision 104 storage decodes M.2 devices, USB slots, placeholders and large capacities',()=>{
 const b=Buffer.alloc(224);b.writeBigUInt64LE(8000000000000n);b.writeBigUInt64LE(7000000000000n,8);b.writeBigUInt64LE(6900000000000n,16);
 b.write('/mnt/ext1',32);b.write('bfs',120);b.write('/dev/nvme1',136);
 const d=parseStorage(b,2,'ps5');assert.equal(d.label,'M.2 SSD');assert.equal(d.mountFrom,'/dev/nvme1');assert.equal(d.used,1000000000000);assert.equal(d.placeholder,false);
 b.fill(0,136);b.write('nvme1',136);assert.equal(parseStorage(b,2,'ps5').label,'M.2 SSD');
 assert.equal(parseStorage(b,17,'ps5').path,'/mnt/usb7');assert.throws(()=>parseStorage(b,18,'ps5'),/Invalid/);assert.throws(()=>parseStorage(b,2,'ps4'),/Invalid/);
 b.fill(0,120);b.write('tmpfs',120);b.write('tmpfs',136);assert.equal(parseStorage(b,1,'ps5').placeholder,true);
});
