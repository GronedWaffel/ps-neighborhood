import {Client} from 'basic-ftp';
import {lstat,stat,readdir,readFile,writeFile,mkdir,rename,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {Readable,Writable,Transform} from 'node:stream';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {ShadowApi} from './shadowmount-api.mjs';
import {listDirectory} from './ftp-list.mjs';
const images=new Set(['.ffpkg','.exfat','.ffpfs','.ffpfsc']);
// ShadowMount returns only custom scan paths; an empty list selects its defaults.
const defaultRoots=['/data/homebrew','/data/etaHEN/games',...['/mnt/ext0','/mnt/ext1',...Array.from({length:8},(_,i)=>'/mnt/usb'+i)].flatMap(p=>[p,p+'/homebrew',p+'/etaHEN/games'])];
const validPart=s=>typeof s==='string'&&s!=='.'&&s!=='..'&&s.length>0&&Buffer.byteLength(s)<=240&&!/[\x00-\x1f\x7f/\\]/.test(s);
export function shadowPath(s){if(typeof s!=='string'||!s.startsWith('/')||s==='/'||s.endsWith('/')||s.split('/').slice(1).some(p=>!validPart(p)))throw Error('Choose an absolute, normalized console directory');return s;}
const time=()=>new Date().toISOString();
const sourcePath=p=>typeof p==='string'?p.replace(/^\/user\/data(?=\/|$)/,'/data'):p;
function titleMetadata(p){const titleId=p.titleId;if(!/^PPSA\d{5}$/.test(titleId))throw Error('Select a PS5 dump with a valid PPSA title ID');const l=p.localizedParameters||{};return {titleId,name:l[l.defaultLanguage]?.titleName||l['en-US']?.titleName||p.titleName||titleId,version:p.contentVersion||p.masterVersion||'',contentId:p.contentId};}
export async function inspectShadowSource(local){
 if(typeof local!=='string'||!path.isAbsolute(local))throw Error('Choose an absolute PC path');
 const root=await realpath(local),info=await lstat(local);if(info.isSymbolicLink())throw Error('Symbolic links are not supported');
 const files=[];let total=0,dirs=0,metadata,kind;
 if(info.isDirectory()){
  kind='folder';const param=path.join(root,'sce_sys','param.json'),ps=await lstat(param);if(!ps.isFile()||ps.isSymbolicLink()||ps.size>1048576)throw Error('Invalid sce_sys/param.json');
  metadata=titleMetadata(JSON.parse(await readFile(param,'utf8')));const boot=await lstat(path.join(root,'eboot.bin'));if(!boot.isFile()||boot.isSymbolicLink())throw Error('Game folder is missing eboot.bin');
  async function walk(dir,relative=''){
   if(++dirs>20000)throw Error('Game exceeds the folder limit');
   for(const item of await readdir(dir,{withFileTypes:true})){
    if(!validPart(item.name)||item.name.endsWith('.psn-pending')||item.name==='.psn-transfer.json')throw Error('Unsupported or reserved filename: '+item.name);
    const rel=relative+item.name,full=path.join(dir,item.name),s=await lstat(full);
    if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory()))throw Error('Special files and links are not supported: '+rel);
    if(s.isDirectory())await walk(full,rel+'/');else{files.push({relative:rel,size:s.size,mtimeMs:s.mtimeMs});total+=s.size;}
    if(files.length>100000||!Number.isSafeInteger(total))throw Error('Game exceeds transfer limits');
   }
  }await walk(root);
 }else if(info.isFile()&&images.has(path.extname(root).toLowerCase())){
  if(!validPart(path.basename(root)))throw Error('Unsupported image filename');
  kind='image';metadata={name:path.basename(root),titleId:null,version:''};files.push({relative:path.basename(root),size:info.size,mtimeMs:info.mtimeMs});total=info.size;
 }else throw Error('Choose a PS5 dump folder or .ffpkg, .exfat, .ffpfs or .ffpfsc image. Use PKG installer for .pkg files.');
 if(total===0)throw Error('Source is empty');
 const fingerprint=createHash('sha256').update(JSON.stringify({root,files})).digest('hex');
 return {local:root,kind,...metadata,total,files,fingerprint,fileCount:files.length,experimental:['.ffpfs','.ffpfsc'].includes(path.extname(root).toLowerCase())};
}
export class ShadowMount {
 constructor({directory,profile,receiver,guard=()=>{},log=()=>{},api,clientFactory=()=>new Client(30000),pollDelay=1000,registrationWait=45000}){
  Object.assign(this,{directory,profile,receiver,guard,log,clientFactory,pollDelay,registrationWait});this.api=api||new ShadowApi({profile,receiver});this.items=[];this.busy=false;this.preparing=false;this.refreshing=false;this.snapshot={games:[],destinations:[],connected:false};this.persistTail=Promise.resolve();
 }
 async init(){
  await mkdir(path.join(this.directory,'shadowmount'),{recursive:true});
  try{const saved=JSON.parse(await readFile(this.queueFile(),'utf8'));if(saved.version===1&&Array.isArray(saved.items)){this.internalReady=typeof saved.internalReady==='string'?saved.internalReady:undefined;this.items=saved.items.filter(i=>typeof i.id==='string'&&/^[a-f\d-]{36}$/.test(i.id)&&Array.isArray(i.files)).map(i=>({...i,state:['running','verifying','registering'].includes(i.state)?'interrupted':i.state}));}}catch(e){if(e.code!=='ENOENT')this.snapshot.error='Could not restore transfer queue: '+e.message;}
  return this;
 }
 queueFile(){return path.join(this.directory,'shadowmount','queue.json');}
 save(){const text=JSON.stringify({version:1,internalReady:this.internalReady,items:this.items},null,2);const run=this.persistTail.then(async()=>{const tmp=this.queueFile()+'.tmp';await writeFile(tmp,text);await rename(tmp,this.queueFile());});this.persistTail=run.catch(()=>{});return run;}
 requirePS5(){if(this.profile().platform!=='ps5')throw Error('ShadowMount requires the PS5 console profile');}
 status(){const host=this.profile().host,s=this.snapshot.host===host?this.snapshot:{games:[],destinations:[],connected:false};return {...s,transport:this.api.transport,port:this.api.port,busy:this.busy,preparing:this.preparing,refreshing:this.refreshing,items:this.items.map(({files,completedFiles,...i})=>({...i,completedFiles:Object.keys(completedFiles||{}).length})),job:this.job};}
 async refresh({port}={}){
  this.requirePS5();if(this.refreshing)throw Error('ShadowMount refresh already running');if(port!==undefined){if(this.busy)throw Error('Wait for the transfer before changing the API port');if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid API port');this.api.port=port;}
  this.refreshing=true;const host=this.profile().host;
  try{const version=await this.api.call('version');if(version.api_version!==1)throw Error('Unsupported ShadowMount API version');const storage=await this.api.call('storage'),settings=await this.api.call('settings'),library=await this.api.call('games',{include_size:false});
   const configured=(settings.scan_paths||[]).filter(p=>typeof p==='string');const roots=configured.length?configured:defaultRoots;
   const destinations=(storage.destinations||[]).filter(d=>!d.read_only&&roots.some(r=>sourcePath(d.path)===sourcePath(r)||sourcePath(d.path).startsWith(sourcePath(r)+'/')));
   // 1.7beta2 compares resolved destinations with unresolved scan roots and can
   // omit /data/homebrew. Use the explicitly prepared canonical directory and
   // its real /user filesystem report, never inferred external-drive capacity.
   const internal=(storage.mounts||[]).find(m=>m.mount_point==='/user'&&!m.read_only&&m.available_bytes>0);
   if(this.internalReady===host&&internal&&roots.some(r=>sourcePath(r)==='/data/homebrew')&&!destinations.some(d=>sourcePath(d.path)==='/data/homebrew'))destinations.push({...internal,path:'/user/data/homebrew'});
   this.snapshot={host,connected:true,version:version.shadowmount_version,capabilities:version.capabilities||[],games:library.games||[],destinations,storage:storage.mounts||[],scanPaths:roots,updatedAt:time()};
   let reconciled=false;for(const item of this.items){if(item.host===host&&item.state==='complete'&&!item.registered&&item.target&&this.snapshot.games.some(g=>sourcePath(g.path)===sourcePath(item.target)&&(item.kind==='image'||g.title_id===item.titleId))){item.registered=true;delete item.registrationNote;reconciled=true;if(this.job?.id===item.id&&this.job.state==='complete')this.job.phase='copied · recognized by ShadowMount';}}
   if(reconciled)await this.save();return this.status();
  }catch(e){this.snapshot={...this.snapshot,host,connected:false,error:e.message};throw e;}finally{this.refreshing=false;}
 }
 async add({local}){this.requirePS5();if(this.busy||this.preparing)throw Error('Wait for the current operation');this.preparing=true;try{const source=await inspectShadowSource(local);const existing=this.items.find(i=>i.fingerprint===source.fingerprint&&i.host===this.profile().host);if(existing)return this.status();this.items.push({...source,id:randomUUID(),host:this.profile().host,state:'queued',processed:0,completedFiles:{},createdAt:time()});await this.save();return this.status();}finally{this.preparing=false;}}
 async prepare(){
  this.requirePS5();this.guard();if(this.busy||this.preparing||this.refreshing)throw Error('Wait for the current operation');this.busy=true;
  try{await this.refresh();if(!this.snapshot.scanPaths.some(r=>sourcePath(r)==='/data/homebrew'))throw Error('Custom ShadowMount scan paths exclude /data/homebrew; choose an existing destination');this.runProfile={...this.profile()};await this.ftp(c=>c.ensureDir('/user/data/homebrew'));this.internalReady=this.runProfile.host;await this.save();return await this.refresh();}finally{this.busy=false;}
 }
 async repairRegistration({confirmation}={}){
  this.requirePS5();this.guard();if(confirmation!=='batch-registration')throw Error('Confirm batch registration of staged console apps');
  if(this.busy||this.preparing||this.refreshing)throw Error('Wait for the current operation');
  if(!this.receiver.ready||this.receiver.host!==this.profile().host||this.receiver.runtimeInfo?.firmware!=='13.60')throw Error('Load the PS5 companion on firmware 13.60 first');
  this.busy=true;this.runProfile={...this.profile()};let backup;
  try{
   await this.ftp(async c=>{
    const remote='/data/shadowmount/config.ini',original=await this.remoteBytes(c,remote,65536),text=original.toString('utf8');
    if(!Buffer.from(text).equals(original))throw Error('ShadowMount config must use UTF-8');
    const key=/^[ \t]*app_install_all[ \t]*=.*$/gmi;
    const changed=key.test(text)?text.replace(key,'app_install_all=true'):text+(text.endsWith('\n')?'':'\n')+'\n# PS Neighborhood: native batch registration on PS5 13.60\napp_install_all=true\n';
    if(changed!==text){
     const id=randomUUID();backup=path.join(this.directory,'shadowmount','config-backups',id+'.ini');await mkdir(path.dirname(backup),{recursive:true});await writeFile(backup,original,{flag:'wx'});
     const temporary='/data/shadowmount/.psn-config-'+id+'.tmp';
     await c.uploadFrom(Readable.from(Buffer.from(changed)),temporary);
     if(!(await this.remoteBytes(c,temporary,65536)).equals(Buffer.from(changed)))throw Error('Configuration upload verification failed');
     if(!(await this.remoteBytes(c,remote,65536)).equals(original))throw Error('ShadowMount config changed during preparation; original config was preserved');
     await c.rename(temporary,remote);
    }
   });
   // The config watcher debounces replacements for 250 ms; let its event run
   // before waking the scan queue, which otherwise has priority over reloads.
   await new Promise(r=>setTimeout(r,1000));
   const scan=await this.api.call('scan',{reset_attempts:true});
   this.log('ShadowMount batch registration','Enabled for PS5 13.60; registration retry counters reset');return {enabled:true,backup,scan};
  }finally{this.busy=false;}
 }
 async remove({id}){if(this.busy||this.preparing)throw Error('Wait for the current operation');const item=this.items.find(i=>i.id===id);if(item?.staging&&!['complete'].includes(item.state))throw Error('This item has resumable files on the console. Keep it queued and retry; no files were deleted.');this.items=this.items.filter(i=>i.id!==id);await this.save();return this.status();}
 start({destination}){
  this.requirePS5();this.guard();if(this.busy||this.preparing||this.refreshing)throw Error('Wait for the current operation');shadowPath(destination);
  if(!this.snapshot.connected||this.snapshot.host!==this.profile().host||!this.snapshot.destinations.some(d=>d.path===destination))throw Error('Refresh ShadowMount and choose an available destination');
  const pending=this.items.filter(i=>i.host===this.profile().host&&!['complete'].includes(i.state));if(!pending.length)throw Error('Add a game folder or image first');
  if(pending.some(i=>i.destination&&i.destination!==destination))throw Error('Resume interrupted transfers to their original destination');
  this.busy=true;this.cancelled=false;this.runProfile={...this.profile()};
  this.running=this.run(pending,destination).catch(e=>{this.error=e.message;}).finally(async()=>{this.busy=false;this.activeClient=null;this.log('ShadowMount transfer',this.job?.state||'finished');await this.save().catch(e=>{this.error=e.message;});});return this.status();
 }
 cancel(){this.cancelled=true;if(this.job?.phase!=='finalizing')this.activeClient?.close();return this.status();}
 checkCancel(){if(this.cancelled)throw Error('Transfer cancelled; retry to resume completed files');}
 async close(){this.cancel();await this.running;await this.persistTail;}
 async ftp(fn){const c=this.clientFactory();this.activeClient=c;try{
  const hello=await c.access({host:this.runProfile.host,port:this.runProfile.ftpPort,user:'anonymous',password:'ps-neighborhood'});
  // ftpsrv defaults to virtual decrypted SELF sizes/downloads. Transfer checks
  // must use the original stored bytes, including signed executables/libraries.
  if(/ftpsrv/i.test(hello?.message||'')){
   let mode=await c.send('SELF');if(/SELF transfer mode enabled/i.test(mode.message))mode=await c.send('SELF');
   if(!/SELF transfer mode disabled/i.test(mode.message))throw Error('FTP did not confirm raw SELF file mode');
  }
  return await fn(c);
 }finally{c.close();if(this.activeClient===c)this.activeClient=null;}}
 async exists(c,remote){
  // ftpsrv 0.21.1 can reply to SIZE on missing paths with UINT64_MAX and 213.
  // Enumerate the parent instead; also supports servers that ignore LIST paths.
  return (await listDirectory(c,path.posix.dirname(remote))).some(f=>f.name===path.posix.basename(remote));
 }
 async remoteBytes(c,remote,limit){const chunks=[];let n=0;await c.downloadTo(new Writable({write(b,e,cb){n+=b.length;if(n>limit)return cb(Error('Remote metadata exceeds its size limit'));chunks.push(b);cb();}}),remote);return Buffer.concat(chunks);}
 async remoteJson(c,remote){return JSON.parse(await this.remoteBytes(c,remote,4096));}
 async verifySource(item){const current=await inspectShadowSource(item.local);if(current.fingerprint!==item.fingerprint)throw Error('PC source changed since it was queued. Add a fresh source; existing staging files were retained.');}
 async run(pending,destination){
  for(const item of pending){
   if(this.cancelled)break;this.job={id:item.id,name:item.name,state:'running',phase:'preflight',processed:0,total:item.total,files:0,fileCount:item.fileCount,rate:0};item.state='running';delete item.error;
   try{
    await this.verifySource(item);await this.refresh();this.checkCancel();
    const drive=this.snapshot.destinations.find(d=>d.path===destination);if(!drive)throw Error('Destination is no longer available');
    const already=Object.keys(item.completedFiles||{}).reduce((n,k)=>n+(item.files.find(f=>f.relative===k)?.size||0),0),needed=item.total-already;
    if(!Number.isSafeInteger(drive.available_bytes)||drive.available_bytes<needed+64*1048576)throw Error('Not enough free space: need '+needed+' bytes plus 64 MiB reserve');
    item.destination=destination;item.target=destination+'/'+(item.kind==='folder'?item.titleId:path.basename(item.local));item.staging=destination+'/.psn-transfer-'+item.id;
    await this.save();await this.ftp(c=>this.copyItem(c,item));
    // Copy completion and console registration are distinct states.
    this.job.phase='registering';item.state='registering';await this.save();
    try{await this.api.call('scan',{reset_attempts:false});const deadline=Date.now()+this.registrationWait;
     do{const library=await this.api.call('games',{include_size:false});this.snapshot.games=library.games||[];const found=this.snapshot.games.find(g=>sourcePath(g.path)===sourcePath(item.target)&&(item.kind==='image'||g.title_id===item.titleId));if(found){item.registered=true;break;}if(this.cancelled)break;await new Promise(r=>setTimeout(r,this.pollDelay));}while(Date.now()<deadline);
    }catch(e){item.registrationNote=e.message;}
    item.state='complete';this.job.state='complete';this.job.phase=item.registered?'copied · recognized by ShadowMount':'copied · awaiting ShadowMount detection';this.job.processed=item.total;item.processed=item.total;
    if(!item.registered)item.registrationNote||='Files are copied. Refresh or rescan ShadowMount to confirm registration.';
    await this.refresh().catch(e=>this.log('ShadowMount storage refresh',e.message));
   }catch(e){item.state=this.cancelled?'cancelled':'failed';item.error=e.message;this.job.state=item.state;this.job.error=e.message;await this.save();break;}
   await this.save();
  }
 }
 async copyItem(c,item){
  const receipt='.psn-transfer.json';
  const checkInstalled=async()=>{if(item.kind==='folder'&&!item.published&&await this.exists(c,'/user/app/'+item.titleId))throw Error('This title is already installed on the console. Its installation was preserved; manage it in the console library before transferring another copy.');};
  await checkInstalled();
  if(item.published){if(!await this.exists(c,item.target))throw Error('Published destination disappeared');const saved=await this.remoteJson(c,(item.kind==='image'?item.staging:item.target)+'/'+receipt);if(saved.id!==item.id||saved.fingerprint!==item.fingerprint)throw Error('Destination ownership does not match this transfer');}
  else{
   if(await this.exists(c,item.target))throw Error('Destination already exists; existing games are never overwritten: '+item.target);
   if(await this.exists(c,item.staging)){const saved=await this.remoteJson(c,item.staging+'/'+receipt);if(saved.id!==item.id||saved.fingerprint!==item.fingerprint)throw Error('Staging ownership does not match this transfer');}
   else{await c.ensureDir(item.staging);await c.uploadFrom(Readable.from(JSON.stringify({id:item.id,fingerprint:item.fingerprint})),item.staging+'/'+receipt);}
  }
  const remoteFor=async file=>{
   if(!file.relative.split('/').every(validPart))throw Error('Invalid queued file path');
   if(item.published&&item.kind==='image')return item.target;
   const plain=(item.published?item.target:item.staging)+'/'+file.relative;
   const hidden=item.kind==='image'||path.posix.basename(file.relative)==='param.json';
   if(item.published&&hidden&&!await this.exists(c,plain+'.psn-pending'))return plain;
   return plain+(hidden?'.psn-pending':'');
  };
  let processed=0,files=0;const began=Date.now();let sent=0;
  for(const file of item.files){
   this.checkCancel();
   const remote=await remoteFor(file);
   const local=item.kind==='image'?item.local:path.join(item.local,...file.relative.split('/'));
   const ls=await lstat(local),resolved=await realpath(local);
   if(ls.isSymbolicLink()||!ls.isFile()||ls.size!==file.size||ls.mtimeMs!==file.mtimeMs||(item.kind==='folder'&&!resolved.startsWith(item.local+path.sep)))throw Error('Source changed or escaped the selected folder: '+file.relative);
   if(item.completedFiles[file.relative]){let size=-1;try{size=await c.size(remote);}catch(e){if(e.code!==550)throw e;}
    if(size===file.size){processed+=file.size;files++;Object.assign(this.job,{processed,files});continue;}delete item.completedFiles[file.relative];
   }
   if(item.published)throw Error('Published transfer requires manual inspection: '+file.relative);
   this.job.phase='transferring';this.job.currentFile=file.relative;await c.ensureDir(path.posix.dirname(remote));
   const hash=createHash('sha256');let uploaded=0;
   const stream=createReadStream(local),meter=new Transform({transform:(chunk,encoding,done)=>{hash.update(chunk);uploaded+=chunk.length;sent+=chunk.length;Object.assign(this.job,{processed:processed+uploaded,rate:Math.round(sent/Math.max(1,(Date.now()-began)/1000))});done(null,chunk);}});
   stream.on('error',e=>meter.destroy(e));stream.pipe(meter);
   try{await c.uploadFrom(meter,remote);}finally{stream.destroy();meter.destroy();}
   this.checkCancel();const after=await stat(local);if(after.size!==file.size||after.mtimeMs!==file.mtimeMs)throw Error('Source changed during upload: '+file.relative);
   if(uploaded!==file.size||await c.size(remote)!==file.size)throw Error('Uploaded file size mismatch: '+file.relative);
   item.completedFiles[file.relative]={size:file.size,sha256:hash.digest('hex')};processed+=file.size;files++;item.processed=processed;Object.assign(this.job,{processed,files});await this.save();
  }
  this.checkCancel();this.job.phase='verifying';
  // Verify all sizes again before the scanner can see the complete source.
  for(const file of item.files){if(await c.size(await remoteFor(file))!==file.size)throw Error('Final verification failed: '+file.relative);}
  this.checkCancel();this.job.phase='finalizing';
  await checkInstalled();
  if(item.kind==='image'&&!item.published){
   if(await this.exists(c,item.target))throw Error('Destination appeared during transfer; not overwritten');
   await c.rename(item.staging+'/'+item.files[0].relative+'.psn-pending',item.target);item.published=true;await this.save();
  }else if(item.kind==='folder'){
   if(!item.published){if(await this.exists(c,item.target))throw Error('Destination appeared during transfer; not overwritten');await c.rename(item.staging,item.target);item.published=true;await this.save();}
   const metadata=item.files.filter(f=>path.posix.basename(f.relative)==='param.json').sort((a,b)=>(a.relative==='sce_sys/param.json'?1:0)-(b.relative==='sce_sys/param.json'?1:0));
   for(const file of metadata)if(await this.exists(c,item.target+'/'+file.relative+'.psn-pending'))await c.rename(item.target+'/'+file.relative+'.psn-pending',item.target+'/'+file.relative);
  }
  item.verification='All remote sizes checked; SHA-256 recorded while reading PC files (no full remote hash readback).';
 }
 async action({action,titleId,confirmation}){
  if(confirmation!==titleId)throw Error('Confirm the selected game before controlling it');
  this.requirePS5();this.guard();if(this.busy||this.preparing)throw Error('Finish the transfer before controlling games');if(!/^PPSA\d{5}$/.test(titleId)||!this.snapshot.connected||this.snapshot.host!==this.profile().host||!this.snapshot.games.some(g=>g.title_id===titleId))throw Error('Select a PS5 game from the current ShadowMount library');
  if(!['mount','unmount','launch','close'].includes(action))throw Error('Unsupported ShadowMount action');
  this.busy=true;try{if(action==='mount'||action==='unmount')return await this.api.call('games/'+action,{title_id:titleId});if(!this.receiver.ready||this.receiver.host!==this.profile().host)throw Error('Load the PS5 companion first');return await this.receiver.appAction(action,titleId);}finally{this.busy=false;}
 }
 async scan(){this.requirePS5();if(this.busy)throw Error('The transfer will request a scan when complete');return this.api.call('scan',{reset_attempts:false});}
}
