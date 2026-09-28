import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {PackageInstaller} from '../src/packages.mjs';

async function fixture(t) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'psn-folder-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(path.join(dir,'nested'));
 const pkg=(type,flags=0)=>{const b=Buffer.alloc(0x3000);b.writeUInt32BE(0x7f434e54);b.write('UP0002-CUSA57548_00-TESTPACKAGE00001',0x40);b.writeUInt32BE(type,0x74);b.writeUInt32BE(flags,0x78);b.writeBigUInt64BE(BigInt(b.length),0x430);return b;};
 await writeFile(path.join(dir,'nested','z-base.pkg'),pkg(0x1a));
 await writeFile(path.join(dir,'b-update.PKG'),pkg(0x1a,0x40000000));
 await writeFile(path.join(dir,'a-dlc.pkg'),pkg(0x1b));
 await writeFile(path.join(dir,'bad.pkg'),'unfinished');
 await writeFile(path.join(dir,'notes.txt'),'ignore');return dir;
}
async function freePort(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function fakeReceiver(p,{error=false,stop=false}={}) {
 const urls=[];p.receiver.load=async()=>{p.receiver.pcAddress='127.0.0.1';};p.receiver.probe=async()=>({ready:true});
 p.receiver.install=async(pkg,url)=>{urls.push(url);assert.equal((await fetch(url+'?task=queue',{method:'HEAD'})).status,200);if(stop)p.queue.stop();return {task_id:urls.length,title:pkg.name};};
 p.receiver.progress=async()=>({error:error?0x80991404:0,length_total:0x3000,transferred_total:0x3000,local_copy_percent:100});
 return urls;
}
test('folder import finds nested PKGs, validates files, deduplicates paths and orders game before patch and DLC',async t=>{
 const dir=await fixture(t),p=new PackageInstaller();
 const shallow=await p.queue.addFolder(dir,false);assert.equal(shallow.added,3);
 p.queue.clear();const deep=await p.queue.addFolder(dir);assert.equal(deep.added,4);
 assert.deepEqual(deep.items.filter(i=>i.state==='queued').map(i=>i.kind),['Game / app','Patch','Add-on']);
 assert.equal(deep.items.find(i=>i.name==='bad.pkg').state,'invalid');
 assert.equal((await p.queue.addFolder(dir)).added,0);
 p.queue.remove(deep.items.find(i=>i.kind==='Patch').id);assert.equal(p.queue.status().pending,2);
});
test('backend queue advances sequentially, keeps earlier URLs available, and never exposes session keys',async t=>{
 const dir=await fixture(t),p=new PackageInstaller();t.after(()=>p.close());const urls=fakeReceiver(p);
 await p.queue.addFolder(dir);p.queue.start({host:'127.0.0.1',serverPort:await freePort()});
 await assert.rejects(p.start({local:path.join(dir,'a-dlc.pkg'),host:'127.0.0.1'}),/already hosted/);
 await p.queue.done;
 assert.equal(p.queue.state,'downloads complete');assert.equal(urls.length,3);
 for(const url of urls){const r=await fetch(url+'?retry=1',{headers:{Range:'bytes=0-3'}});assert.equal(r.status,206);assert.deepEqual(Buffer.from(await r.arrayBuffer()),Buffer.from([0x7f,0x43,0x4e,0x54]));assert.ok(!JSON.stringify(p.status()).includes(new URL(url).pathname.split('/')[1]));}
 assert.equal(p.queue.items.filter(i=>i.state==='download complete').length,3);
});
test('an uncertain submission stops the queue without retrying or starting dependent items',async t=>{
 const dir=await fixture(t),p=new PackageInstaller();t.after(()=>p.close());fakeReceiver(p);let attempts=0;
 p.receiver.install=async()=>{attempts++;throw Error('Lost install reply');};
 await p.queue.addFolder(dir);p.queue.start({host:'127.0.0.1',serverPort:await freePort()});await p.queue.done;
 assert.equal(attempts,1);assert.equal(p.queue.state,'stopped on error');assert.equal(p.queue.status().pending,2);assert.equal(p.status().hosting,true);
});
test('PS4 error stops advancement and stop-after-current finishes only the active item',async t=>{
 const dir=await fixture(t);
 for(const opts of [{error:true},{stop:true}]){
  const p=new PackageInstaller();t.after(()=>p.close());const urls=fakeReceiver(p,opts);
  await p.queue.addFolder(dir);p.queue.start({host:'127.0.0.1',serverPort:await freePort()});await p.queue.done;
  assert.equal(urls.length,1);assert.equal(p.queue.status().pending,2);
  assert.equal(p.queue.state,opts.error?'stopped on error':'stopped');
  if(opts.error)assert.match(p.queue.error,/0x80991404/);
  await p.close();
 }
});
