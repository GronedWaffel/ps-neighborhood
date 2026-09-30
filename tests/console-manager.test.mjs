import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {ConsoleManager,safeName} from '../src/console-manager.mjs';
import {Receiver,parseStorage} from '../src/pkg-receiver.mjs';
import {Workbench} from '../src/workbench.mjs';

test('recursive inventory supports FTP servers that ignore LIST paths and rejects missing directories',async()=>{
  const entry=(name,isDirectory,size=0)=>({name,isDirectory,isFile:!isDirectory,size});
  const directories=new Map([['/',[entry('user',true)]],['/user',[entry('captures',true)]],['/user/captures',[entry('clip.mp4',false,1234)]]]);
  let cwd='/',listings=0;
  const client={cd:async remote=>{if(!directories.has(remote)){const e=Error('Missing directory');e.code=550;throw e;}cwd=remote;},list:async()=>{assert.ok(++listings<=3,'Unexpected repeated directory traversal');return directories.get(cwd);}};
  const manager=new ConsoleManager({});
  const files=await manager.walk(client,'/user');
  assert.deepEqual(files.map(f=>[f.remote,f.size]),[['/user/captures/clip.mp4',1234]]);
  assert.deepEqual(await manager.list(client,'/missing',true),[]);
  await assert.rejects(manager.list(client,'/missing'),/Missing directory/);
  assert.equal(listings,2);
});

async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'psn-console-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const dbFile=path.join(directory,'fixture.db'),db=new DatabaseSync(dbFile);
  db.exec("CREATE TABLE tbl_appbrowse_123(titleId TEXT,titleName TEXT,contentSize INTEGER,category TEXT); INSERT INTO tbl_appbrowse_123 VALUES('CUSA12345','Example Game',1000,'gd'),('NPXS20001','System',1000,'gd'); CREATE TABLE tbl_appinfo(titleId TEXT,key TEXT,val TEXT); INSERT INTO tbl_appinfo VALUES('CUSA12345','APP_VER','01.02')");db.close();
  const root='/user/home/123abc/savedata/CUSA12345',meta='/user/home/123abc/savedata_meta/user/CUSA12345';
  const files=new Map([['/system_data/priv/mms/app.db',await readFile(dbFile)],['/user/app/CUSA12345/app.pkg',Buffer.alloc(100)],['/user/patch/CUSA12345/patch.pkg',Buffer.alloc(40)],[root+'/sdimg_save',Buffer.alloc(16,3)],[root+'/save.bin',Buffer.alloc(96,4)],[meta+'/icon.png',Buffer.from('image')]]);
  let stamp='2026-09-27',running=false;
  const operations=[];
  const client={cd:async remote=>{client.cwd=remote;},access:async()=>{},close:()=>{},trackProgress:()=>{},list:async remote=>{remote=client.cwd;
    const entries=new Map();for(const [p,data] of files){if(!p.startsWith(remote+'/'))continue;const rel=p.slice(remote.length+1),name=rel.split('/')[0],dir=rel.includes('/');entries.set(name,{name,isDirectory:dir,isFile:!dir,size:dir?0:data.length,rawModifiedAt:stamp});}
    if(!entries.size){const e=Error('Not found');e.code=550;throw e;}return [...entries.values()];
  },downloadTo:async(local,remote)=>{if(!files.has(remote)){const e=Error('Missing');e.code=550;throw e;}if(typeof local==='string')await writeFile(local,files.get(remote));else await new Promise((resolve,reject)=>{local.on('error',reject);local.on('finish',resolve);local.end(files.get(remote));});if(client.changeDuringBackup&&remote===root+'/save.bin')stamp='changed';}};
  const caps=Object.fromEntries(['storage','appInfo','launch','close','uninstall','patch','shutdown','restart','rest'].map(k=>[k,true]));
  const receiver={ready:true,host:'192.0.2.1',consoleCapabilities:async()=>caps,storage:async index=>({index,path:['/user','/mnt/ext0','/mnt/ext1'][index],mount:index?'/':'/user',fsid:'user',total:10000,free:9000,available:8000,used:1000}),appInfo:async titleId=>({exists:true,appId:running?0x60000001:-1,running}),appAction:async(action,titleId)=>{operations.push({action,titleId});return {accepted:true};},power:async action=>{operations.push({action});return {accepted:true};}};
  const packages={receiver,queue:{processing:false},busy:false,server:null};
  const manager=new ConsoleManager({directory,profile:()=>({host:'192.0.2.1',ftpPort:2121}),packages,clientFactory:()=>client});
  manager.refresh();await manager.running;assert.equal(manager.job.state,'complete',manager.job.error);
  return {manager,client,files,root,meta,receiver,packages,operations,setRunning:v=>{running=v},directory};
}
test('console inventory separates game, patch and save sizes; ignores unmounted external roots',async t=>{
  const {manager}=await fixture(t);const s=manager.status();assert.equal(s.games.length,1);assert.equal(s.games[0].name,'Example Game');assert.equal(s.games[0].version,'01.02');assert.equal(s.games[0].baseBytes,100);assert.equal(s.games[0].patchBytes,40);assert.equal(s.drives.length,1);assert.equal(s.saves[0].bytes,117);assert.equal(s.capabilities.launch,true);
});
test('save backup keeps container/key/metadata together and verifies a checksum manifest',async t=>{
  const {manager,files,root}=await fixture(t);manager.startBackup({id:'123abc:CUSA12345'});await manager.backupRunning;
  assert.equal(manager.backup.state,'complete',manager.backup.error);const manifest=JSON.parse(await readFile(path.join(manager.backup.local,'manifest.json')));
  assert.equal(manifest.complete,true);assert.equal(manifest.files.length,3);assert.equal(manifest.format,'PS4 encrypted save backup');
  const f=manifest.files.find(f=>f.relative==='savedata/sdimg_save');assert.equal(f.sha256,createHash('sha256').update(files.get(root+'/sdimg_save')).digest('hex'));
});
test('attached extended storage is measured separately from the internal disk',async t=>{
  const f=await fixture(t),original=f.receiver.storage;f.receiver.storage=async index=>index===1?{index,path:'/mnt/ext0',mount:'/mnt/ext0',fsid:'external',total:50000,free:40000,available:40000,used:10000}:original(index);
  f.files.set('/mnt/ext0/user/app/CUSA22222/app.pkg',Buffer.alloc(900));f.manager.refresh();await f.manager.running;assert.equal(f.manager.job.state,'complete');
  assert.equal(f.manager.snapshot.drives.length,2);assert.equal(f.manager.snapshot.games.find(g=>g.titleId==='CUSA22222').baseBytes,900);assert.equal(f.manager.snapshot.categories.find(c=>c.drive==='/mnt/ext0'&&c.category==='games').bytes,900);
});

test('PS5 inventory measures direct M.2 and nested USB layouts without counting placeholders or device aliases',async t=>{
  const f=await fixture(t);
  f.manager.profile=()=>({platform:'ps5',host:'192.0.2.1',ftpPort:2121});
  const drives=[
    {index:0,path:'/user',mount:'/user',mountFrom:'/dev/ssd0.user'},
    {index:1,path:'/mnt/ext0',mount:'/mnt/ext0',mountFrom:'/dev/da0'},
    {index:2,path:'/mnt/ext1',mount:'/mnt/ext1',mountFrom:'nvme1'},
    {index:3,path:'/user2',mount:'/user2',mountFrom:'/dev/nvme1'},
    {index:4,path:'/mnt/ext2',mount:'/mnt/ext2',mountFrom:'tmpfs',placeholder:true}
  ];
  f.manager.ps5Receiver={...f.receiver,storage:async i=>{if(!drives[i])throw Error('Not mounted');return {...drives[i],total:4000000000000,free:3000000000000,available:2900000000000,used:1000000000000};}};
  f.files.set('/mnt/ext0/user/app/CUSA22222/app.pkg',Buffer.alloc(200));
  f.files.set('/mnt/ext1/app/PPSA33333/app.pkg',Buffer.alloc(300));
  f.files.set('/mnt/ext1/patch/PPSA33333/patch.pkg',Buffer.alloc(30));
  f.files.set('/mnt/ext2/app/PPSA44444/app.pkg',Buffer.alloc(400));
  f.manager.refresh();await f.manager.running;assert.equal(f.manager.job.state,'complete',f.manager.job.error);
  const s=f.manager.status();assert.deepEqual(s.drives.map(d=>d.path),['/user','/mnt/ext0','/mnt/ext1']);
  assert.equal(s.games.length,3);assert.equal(s.games.find(g=>g.titleId==='CUSA22222').totalBytes,200);
  const m2=s.games.find(g=>g.titleId==='PPSA33333');assert.equal(m2.totalBytes,330);assert.deepEqual(m2.locations,['/mnt/ext1']);
  assert.equal(s.categories.find(c=>c.drive==='/mnt/ext1'&&c.category==='patches').bytes,30);
  assert.ok(!s.games.some(g=>g.titleId==='PPSA44444'));
});

test('mounted evidence survives closing a game but invalidates after package changes without changing disk totals',async t=>{
  const f=await fixture(t),p='/mnt/sandbox/pfsmnt/CUSA12345-app0/zone/all/test_patch.ff';
  f.files.set(p,Buffer.alloc(10));f.manager.refresh();await f.manager.running;
  let g=f.manager.status().games[0];assert.equal(g.content.patchFiles.length,1);assert.equal(g.content.mounted,true);assert.equal(g.totalBytes,140);
  f.files.delete(p);f.manager.refresh();await f.manager.running;g=f.manager.status().games[0];assert.equal(g.content.mounted,false);assert.equal(g.content.patchFiles.length,1);
  f.files.set('/user/patch/CUSA12345/patch.pkg',Buffer.alloc(50));f.manager.refresh();await f.manager.running;g=f.manager.status().games[0];assert.equal(g.content,undefined);assert.equal(g.totalBytes,150);
});
test('save backup refuses active games and missing keys; detects mutation during download',async t=>{
  const f=await fixture(t);f.setRunning(true);f.manager.startBackup({id:'123abc:CUSA12345'});await f.manager.backupRunning;assert.equal(f.manager.backup.state,'failed');assert.match(f.manager.backup.error,/Close/);
  f.setRunning(false);const key=f.files.get(f.root+'/save.bin');f.files.delete(f.root+'/save.bin');f.manager.startBackup({id:'123abc:CUSA12345'});await f.manager.backupRunning;assert.match(f.manager.backup.error,/key file is missing/);
  f.files.set(f.root+'/save.bin',key);f.client.changeDuringBackup=true;f.manager.startBackup({id:'123abc:CUSA12345'});await f.manager.backupRunning;assert.equal(f.manager.backup.state,'failed');assert.match(f.manager.backup.error,/changed/);assert.equal((await readdir(path.join(f.directory,'save-backups'))).filter(n=>!n.endsWith('.partial')).length,0);
});
test('game and power controls require matching confirmation and refuse active transfers or running-game removal',async t=>{
  const f=await fixture(t),args={action:'uninstall',titleId:'CUSA12345'};
  await assert.rejects(f.manager.action(args),/Confirmation/);await assert.rejects(f.manager.action({...args,titleId:'NPXS20001',confirmation:'NPXS20001'}),/Select a game/);
  f.setRunning(true);await assert.rejects(f.manager.action({...args,confirmation:args.titleId}),/Close this game/);assert.deepEqual(f.operations,[]);
  f.setRunning(false);f.packages.server={};await assert.rejects(f.manager.action({action:'shutdown',confirmation:'shutdown'}),/stop sharing/);assert.throws(()=>f.manager.startBackup({id:'123abc:CUSA12345'}),/stop sharing/);f.packages.server=null;
  await f.manager.action({...args,action:'patch',confirmation:args.titleId});assert.deepEqual(f.operations,[{action:'patch',titleId:'CUSA12345'}]);
  await f.manager.action({action:'rest',confirmation:'rest'});assert.equal(f.operations[1].action,'rest');
});
test('concurrent console commands are refused and lost responses report an unknown outcome',async t=>{
  const f=await fixture(t);let release;f.receiver.appAction=()=>new Promise(r=>{release=r});const first=f.manager.action({action:'launch',titleId:'CUSA12345',confirmation:'CUSA12345'});
  await assert.rejects(f.manager.action({action:'shutdown',confirmation:'shutdown'}),/Wait/);while(!release)await new Promise(r=>setImmediate(r));release({accepted:true});await first;
  f.receiver.power=async()=>{throw Error('Receiver disconnected')};await assert.rejects(f.manager.action({action:'rest',confirmation:'rest'}),/result is unknown/);
});
test('filesystem sizes preserve 64-bit capacity and reject malformed reports',()=>{
  const b=Buffer.alloc(120);b.writeBigUInt64LE(4000000000000n);b.writeBigUInt64LE(3000000000000n,8);b.writeBigUInt64LE(2800000000000n,16);b.write('/user',32);
  assert.equal(parseStorage(b,0).used,1000000000000);b.writeBigUInt64LE(5000000000000n,16);assert.throws(()=>parseStorage(b,0),/Invalid/);assert.throws(()=>parseStorage(Buffer.alloc(8),0),/Invalid/);
});
test('receiver uses distinct commands for removing a game and its patch; rejects system titles and invalid actions',async()=>{
  const r=new Receiver(),calls=[];r.command=async(op,body)=>{calls.push({op,body});return {code:0,body:Buffer.alloc(0)};};
  await r.appAction('uninstall','CUSA12345');await r.appAction('patch','CUSA12345');await r.power('rest');assert.deepEqual(calls.map(c=>[c.op,c.body.readUInt32LE()]),[[11,3],[11,4],[12,3]]);
  await assert.rejects(r.appAction('uninstall','NPXS20001'),/CUSA/);await assert.rejects(r.appAction('unknown','CUSA12345'),/Unknown/);await assert.rejects(r.power('unknown'),/Unknown/);assert.equal(calls.length,3);
});
test('unsafe Windows paths cannot escape save bundles; MCP and demo cannot activate game/power controls',async t=>{
  for(const name of ['..','../save','a\\b','a:b','CON','x.','NUL.bin'])assert.equal(safeName(name),false);assert.equal(safeName('savedata.bin'),true);
  const f=await fixture(t),w=new Workbench(f.directory);await assert.rejects(w.call('console_action',{action:'shutdown',confirmation:'shutdown'},'mcp'),/desktop/);w.mode='demo';await assert.rejects(w.call('console_refresh',{},'desktop'),/memory lab/);
});
