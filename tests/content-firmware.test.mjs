import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readCatalog} from '../src/console-manager.mjs';
import {changeVersions,mountedContent,readAddons,recognizeContent,smallText} from '../src/console-content.mjs';
import {decodeFirmware,compatibility,firmwareProfile,firmwareTargets} from '../src/firmware.mjs';
import {Receiver} from '../src/pkg-receiver.mjs';
import {Workbench} from '../src/workbench.mjs';

test('catalog preserves APP_VER versus VERSION and reads add-on names independently',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'psn-content-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'app.db'),db=new DatabaseSync(file);
  db.exec("CREATE TABLE tbl_appbrowse_123(titleId,titleName,contentSize,category); INSERT INTO tbl_appbrowse_123 VALUES('CUSA57548','Black Ops II',1000,'gd'); CREATE TABLE tbl_appinfo(titleId,key,val); INSERT INTO tbl_appinfo VALUES('CUSA57548','APP_VER','01.00'),('CUSA57548','VERSION','01.10'),('CUSA57548','CONTENT_ID','example'); CREATE TABLE addcont(title_id,dir_name,title); INSERT INTO addcont VALUES('CUSA00265','skin','Skin pack');");db.close();
  const g=readCatalog(file).get('CUSA57548');assert.equal(g.version,'01.00');assert.equal(g.packageVersion,'01.10');assert.equal(g.contentId,'example');
  assert.equal(readAddons(file).has('CUSA57548'),false);assert.deepEqual(readAddons(file).get('CUSA00265'),[{id:'skin',name:'Skin pack'}]);
});
test('bundled detection requires actual nonempty map files; union mount is not proof of a separate patch',async()=>{
  const game={titleId:'CUSA57548',name:'Call of Duty: Black Ops II'};
  const entries=new Map([
    ['/mnt/sandbox/pfsmnt',[{name:'CUSA57548-app0',isDirectory:true},{name:'CUSA57548-app0-patch0-union',isDirectory:true}]],
    ['/mnt/sandbox/pfsmnt/CUSA57548-app0/zone',[{name:'all',isDirectory:true}]],
    ['/mnt/sandbox/pfsmnt/CUSA57548-app0/zone/all',[{name:'zm_tomb.ff',isFile:true,size:100},{name:'zm_tomb_patch.ff',isFile:true,size:10},{name:'zm_buried.ff',isFile:true,size:0}]]
  ]);
  const read=[];const content=await mountedContent({},async(c,p)=>{read.push(p);return entries.get(p)||[]},game);
  assert.equal(content.maps.length,1);assert.equal(content.maps[0].name,'Origins');assert.equal(content.maps[0].source,'base');assert.equal(content.patchFiles.length,1);assert.ok(!read.some(p=>p.includes('union')));
  entries.delete('/mnt/sandbox/pfsmnt');assert.equal(await mountedContent({},async(c,p)=>entries.get(p)||[],game),null);
  const bo1=recognizeContent({name:'Call of Duty: Black Ops'},[{name:'zombie_moon.ff',size:20},{name:'zombie_moon.ff',size:30}]);assert.equal(bo1.maps.length,1);assert.equal(bo1.maps[0].name,'Moon');
  assert.equal(recognizeContent({name:'Other game'},[{name:'zm_tomb.ff',size:10}]).maps.length,0);
});
test('update history is parsed as metadata and text reads are bounded',async()=>{
  assert.deepEqual(changeVersions('<changes app_ver="01.10"/><changes app_ver="01.08"/><changes app_ver="01.10"/>'),['01.08','01.10']);
  const c={downloadTo:async stream=>new Promise((resolve,reject)=>{stream.on('error',reject);stream.on('finish',resolve);stream.end(Buffer.alloc(20))})};
  await assert.rejects(smallText(c,'file',10),/size limit/);
});
test('firmware BCD decoding, target labels and stored profile do not claim untested hardware',async t=>{
  assert.equal(decodeFirmware(0x09008000),'9.00');assert.equal(decodeFirmware(0x10010000),'10.01');assert.equal(decodeFirmware(0x13520000),'13.52');assert.equal(decodeFirmware(0x1a520000),null);assert.equal(decodeFirmware(0),null);
  const unknown=compatibility('10.01',null);assert.equal(unknown.detected,null);assert.equal(unknown.hardwareTested,false);
  const next=compatibility('10.01',{firmware:'13.52',revision:2});assert.equal(next.target,true);assert.equal(next.hardwareTested,false);assert.equal(next.profileMismatch,true);
  assert.equal(compatibility('auto',{firmware:'10.01'}).hardwareTested,true);
  for(const version of firmwareTargets)assert.equal(firmwareProfile(version),version);assert.throws(()=>firmwareProfile('13.52 arbitrary'),/Firmware/);
  const dir=await mkdtemp(path.join(tmpdir(),'psn-fw-'));t.after(()=>rm(dir,{recursive:true,force:true}));const w=new Workbench(dir);await w.init();
  await w.setProfile({...w.profile,firmware:'13.52'});assert.equal(w.profile.firmware,'13.52');const reread=await new Workbench(dir).init();assert.equal(reread.profile.firmware,'13.52');
});
test('runtime query is distinct from native controls and initialization stops at an unsupported firmware',async()=>{
  const receiver=new Receiver(),calls=[];receiver.command=async op=>{calls.push(op);if(op===13){const body=Buffer.alloc(12);body.writeUInt32LE(0x13520000);body.writeUInt32LE(1,4);body.writeUInt32LE(2,8);return {code:0,body};}const body=Buffer.alloc(4);body.writeUInt32LE(40);return {code:-1040,body};};
  assert.equal((await receiver.runtime()).firmware,'13.52');await assert.rejects(receiver.probe(),/stage 40/);assert.deepEqual(calls,[13,13,2]);assert.equal(receiver.serviceReady,false);
});

test('experimental PS5 targets retain feature boundaries and truthful validation labels',async()=>{
 const {ps5FirmwareTargets}=await import('../src/ps5-firmware.mjs');
 for(const firmware of ps5FirmwareTargets){const c=compatibility('auto',{firmware},'ps5');assert.equal(c.target,true);assert.equal(c.receiverSupported,true);assert.equal(c.hardwareTested,firmware==='13.60');assert.equal(c.restrictedFeatures.length>0,firmware!=='13.60');}
 for(const firmware of ['9.05','11.40','14.00']){const c=compatibility('auto',{firmware},'ps5');assert.equal(c.target,false);assert.equal(c.receiverSupported,false);assert.equal(c.hardwareTested,false);}
});
