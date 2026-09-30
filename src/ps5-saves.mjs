import {mkdir,readFile,writeFile,rename,stat,lstat,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export async function fileHash(file){const hash=createHash('sha256');for await(const data of createReadStream(file))hash.update(data);return hash.digest('hex');}
export function saveRelative(value){
 if(typeof value!=='string'||!value||value.includes('\\'))throw Error('Invalid save file path');
 const parts=value.split('/');
 if(parts.some(p=>!p||p==='.'||p==='..'||/[<>:"\\|?*\x00-\x1f]/.test(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('Unsafe save file path');
 return parts;
}
export class PS5Saves {
 constructor(manager){this.manager=manager;this.plans=new Map();}
 async closed(save){if((await this.manager.ps5AppInfo(save.titleId)).running)throw Error('Close '+save.name+' before processing its save');}
 async capable(){const m=this.manager;m.requireReceiver();if(!(await m.receiver.consoleCapabilities()).saveMount)throw Error('Load the updated PS5 companion on firmware 13.60 for decrypted saves');if((await m.receiver.saveStatus()).mounted)throw Error('Another staged save is still mounted; finish that session first');}
 async withImage(c,local,fn,{afterUnmount}={}){
  const m=this.manager,session=randomUUID(),root='/data/psn-saves/'+session,image=root+'/image';
  if((await stat(local)).size>4*1024**3)throw Error('Limit each save container to 4 GiB');
  await c.ensureDir(root);await c.uploadFrom(local,image);
  let mounted=false,unmountConfirmed=false,unmountAttempted=false;
  try{
   const mount=await m.receiver.saveCommand('mount',session);mounted=true;
   const result=await fn(mount.path,{session,root,image});
   unmountAttempted=true;await m.receiver.saveCommand('unmount',session);mounted=false;unmountConfirmed=true;
   if(afterUnmount)await afterUnmount({session,root,image});
   return result;
  }finally{
   if(mounted&&!unmountAttempted){unmountAttempted=true;await m.receiver.saveCommand('unmount',session);unmountConfirmed=true;}
   if(unmountConfirmed){await c.cd('/');await c.remove(image);await c.removeDir(root);}
   else if(!mounted){
    // A lost reply may mean the copy is mounted. Preserve it unless status proves otherwise.
    const state=await m.receiver.saveStatus();
    if(!state.mounted){await c.cd('/');await c.remove(image);await c.removeDir(root);}
   }
  }
 }
 async export(save,profile){
  const m=this.manager;await this.closed(save);await this.capable();
  m.backup.detail='Backing up encrypted originals';const encrypted=await m.downloadSave(save,profile);
  m.backup.encryptedBackup=encrypted;
  const archive=JSON.parse(await readFile(path.join(encrypted,'manifest.json'),'utf8'));
  const images=archive.files.filter(f=>/^savedata\/sdimg_[^/]+$/.test(f.relative));
  if(!images.length)throw Error('No PS5 save containers found');
  const final=path.join(m.directory,'save-backups',save.titleId+'-decrypted-'+m.backup.id),partial=final+'.partial';await mkdir(partial);
  const manifest={version:1,format:'psn-ps5-decrypted-v1',complete:false,host:profile.host,titleId:save.titleId,userId:save.userId,sourceId:save.id,encryptedBackup:encrypted,createdAt:new Date().toISOString(),slots:[]};
  await writeFile(path.join(partial,'manifest.json'),JSON.stringify(manifest,null,2));
  m.backup.bytes=0;m.backup.total=0;
  await m.ftp(profile,async c=>{
   for(const image of images){
    await this.closed(save);const slot=path.posix.basename(image.relative);saveRelative(slot);
    m.backup.detail='Decrypting '+slot;
    const local=path.join(encrypted,...image.relative.split('/'));if(await fileHash(local)!==image.sha256)throw Error('Encrypted backup checksum mismatch');
    await this.withImage(c,local,async remote=>{
     const files=await m.walk(c,remote);const slotInfo={name:slot,originalSha256:image.sha256,originalSize:image.size,files:[]};
     for(const f of files){
      const parts=saveRelative(f.relative),destination=path.join(partial,slot,...parts);await mkdir(path.dirname(destination),{recursive:true});
      await c.downloadTo(destination,f.remote);if((await stat(destination)).size!==f.size)throw Error('Decrypted file size changed');
      slotInfo.files.push({path:f.relative,size:f.size,sha256:await fileHash(destination),protected:parts[0].toLowerCase()==='sce_sys'});m.backup.bytes+=f.size;
     }
     manifest.slots.push(slotInfo);
    });
   }
  });
  await this.closed(save);manifest.complete=true;manifest.finishedAt=new Date().toISOString();m.backup.total=m.backup.bytes;
  await writeFile(path.join(partial,'manifest.json'),JSON.stringify(manifest,null,2));await rename(partial,final);return final;
 }
 async editPlan(save,profile,folder){
  const manifest=JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8'));
  if(manifest.format!=='psn-ps5-decrypted-v1'||manifest.complete!==true||manifest.host!==profile.host||manifest.sourceId!==save.id||manifest.titleId!==save.titleId||manifest.userId!==save.userId)throw Error('Choose a completed decrypted export from this console, user and game');
  if(!Array.isArray(manifest.slots)||!manifest.slots.length||manifest.slots.length>100)throw Error('Invalid save manifest');
  const slots=[],seen=new Set();
  for(const slot of manifest.slots){
   if(!/^sdimg_[a-zA-Z\d_.-]{1,121}$/.test(slot.name)||seen.has(slot.name)||!Array.isArray(slot.files)||slot.files.length>10000)throw Error('Invalid save container');seen.add(slot.name);
   const expected=new Set(),changes=[];
   for(const f of slot.files){
    const parts=saveRelative(f.path);if(expected.has(f.path)||!/^[a-f\d]{64}$/.test(f.sha256))throw Error('Invalid file manifest');expected.add(f.path);
    const local=path.join(folder,slot.name,...parts);await this.regularPath(folder,[slot.name,...parts]);const size=(await stat(local)).size,sha256=await fileHash(local);
    if(size!==f.size||sha256!==f.sha256){if(parts[0].toLowerCase()==='sce_sys')throw Error('sce_sys metadata must not be edited');changes.push({path:f.path,local,size,sha256,oldSha256:f.sha256});}
   }
   const actual=await this.localFiles(path.join(folder,slot.name));
   if(actual.length!==expected.size||actual.some(f=>!expected.has(f)))throw Error('This restore supports editing existing files; adding or removing files is not supported');
   if(changes.length)slots.push({...slot,changes});
  }
  if(slots.length!==1)throw Error(slots.length?'Edit one save container per restore; keep other containers unchanged':'No edited files found');
  return {manifest,slot:slots[0]};
 }
 async regularPath(root,parts){let p=path.resolve(root);if((await lstat(p)).isSymbolicLink())throw Error('Save folders cannot be symbolic links');for(let i=0;i<parts.length;i++){p=path.join(p,parts[i]);const st=await lstat(p);if(st.isSymbolicLink()||(i===parts.length-1?!st.isFile():!st.isDirectory()))throw Error('Only regular save files are supported');}}
 async localFiles(root,prefix=''){
  const out=[];for(const entry of await readdir(root,{withFileTypes:true})){
   const relative=prefix+entry.name;saveRelative(relative);
   if(entry.isSymbolicLink())throw Error('Save folders cannot contain symbolic links');
   if(entry.isDirectory())out.push(...await this.localFiles(path.join(root,entry.name),relative+'/'));
   else if(entry.isFile())out.push(relative);else throw Error('Only regular save files are supported');
   if(out.length>10000)throw Error('Too many save files');
  }return out;
 }
 async verifyMounted(c,remote,files,directory){
  const actual=await this.manager.walk(c,remote),expected=new Map(files.map(f=>[f.path,f]));
  if(actual.length!==expected.size)throw Error('Decrypted container file list differs from the export');
  await mkdir(directory,{recursive:true});
  for(const f of actual){const e=expected.get(f.relative);if(!e||e.size!==f.size)throw Error('Decrypted container layout differs from the export');const local=path.join(directory,...saveRelative(f.relative));await mkdir(path.dirname(local),{recursive:true});await c.downloadTo(local,f.remote);if(await fileHash(local)!==e.sha256)throw Error('Decrypted file verification failed: '+f.relative);}
 }
 async prepare(save,profile,folder){
  const m=this.manager;await this.closed(save);await this.capable();
  const {manifest,slot}=await this.editPlan(save,profile,folder);
  m.backup.detail='Backing up current encrypted save';const backup=await m.downloadSave(save,profile);m.backup.encryptedBackup=backup;
  const original=path.join(backup,'savedata',slot.name);
  if(await fileHash(original)!==slot.originalSha256)throw Error('This save changed since export. Export a fresh copy before editing');
  const id=randomUUID(),directory=path.join(m.directory,'save-backups','restore-'+id);await mkdir(directory);
  const edited=path.join(directory,'edited-image'),expected=slot.files.map(f=>{const change=slot.changes.find(c=>c.path===f.path);return change?{...f,size:change.size,sha256:change.sha256}:f;});
  const target={session:id,userId:save.userId,titleId:save.titleId,slot:slot.name};const stamp=await m.receiver.saveTargetInfo(target);
  await m.ftp(profile,async c=>{
   m.backup.detail='Verifying and editing a staged copy';
   await this.withImage(c,original,async remote=>{
    await this.verifyMounted(c,remote,slot.files,path.join(directory,'before'));
    for(const change of slot.changes){if(await fileHash(change.local)!==change.sha256)throw Error('Edited files changed during preparation');await c.uploadFrom(change.local,remote+'/'+change.path);}
   },{afterUnmount:async stage=>c.downloadTo(edited,stage.image)});
   if((await stat(edited)).size!==(await stat(original)).size)throw Error('Re-encrypted container size changed');
   m.backup.detail='Verifying re-encrypted save';
   await this.withImage(c,edited,remote=>this.verifyMounted(c,remote,expected,path.join(directory,'verified')));
  });
  await this.closed(save);if(await m.receiver.saveTargetInfo(target)!==stamp)throw Error('Installed save changed during preparation');
  const plan={id,save,profile,slot:slot.name,edited,sha256:await fileHash(edited),original,originalSha256:slot.originalSha256,stamp,target,backup,directory,changes:slot.changes.map(({path,size})=>({path,size})),createdAt:Date.now()};
  this.plans.set(id,plan);
  await writeFile(path.join(directory,'restore-plan.json'),JSON.stringify({id,titleId:save.titleId,slot:slot.name,sha256:plan.sha256,originalSha256:plan.originalSha256,backup,changes:plan.changes,state:'prepared'},null,2));
  return {planId:id,changes:plan.changes,slot:slot.name,local:directory,encryptedBackup:backup,ready:true};
 }
 async apply(planId,confirmation){
  const m=this.manager,plan=this.plans.get(planId);
  if(!plan||confirmation!==plan.save.id)throw Error('Confirm the exact prepared save before restoring');
  if(m.profile().host!==plan.profile.host||m.profile().platform!=='ps5')throw Error('The console profile changed');
  if(Date.now()-plan.createdAt>30*60*1000)throw Error('Restore preparation expired; prepare again');
  await this.closed(plan.save);await this.capable();
  if(await fileHash(plan.edited)!==plan.sha256||await fileHash(plan.original)!==plan.originalSha256)throw Error('Prepared save or backup checksum changed');
  const remote=plan.save.root+'/'+plan.slot,incoming=plan.save.root+'/.psn-new-'+plan.id+'-'+plan.slot,old=plan.save.root+'/.psn-old-'+plan.id+'-'+plan.slot;
  let committed=false,attempted=false;
  try{
   await m.ftp(plan.profile,async c=>{
    if(await m.receiver.saveTargetInfo(plan.target)!==plan.stamp)throw Error('Installed save changed; prepare a fresh restore');
    const present=await m.list(c,plan.save.root);if(present.some(f=>f.name===path.posix.basename(incoming)||f.name===path.posix.basename(old)))throw Error('Restore staging files already exist');
    m.backup.detail='Uploading verified replacement';await c.uploadFrom(plan.edited,incoming);
    const verification=path.join(plan.directory,'upload-check');await c.downloadTo(verification,incoming);if(await fileHash(verification)!==plan.sha256)throw Error('Uploaded replacement checksum mismatch');
    await c.uploadFrom(plan.original,old);const recoveryCheck=path.join(plan.directory,'recovery-check');await c.downloadTo(recoveryCheck,old);if(await fileHash(recoveryCheck)!==plan.originalSha256)throw Error('Recovery copy checksum mismatch');
    await this.closed(plan.save);
    const current=path.join(plan.directory,'current-check');await c.downloadTo(current,remote);if(await fileHash(current)!==plan.originalSha256)throw Error('Installed save changed; restore refused');
    m.backup.detail='Replacing the confirmed save';attempted=true;await m.receiver.saveCommit(plan.target,plan.stamp);committed=true;
    const installed=path.join(plan.directory,'installed-check');await c.downloadTo(installed,remote);if(await fileHash(installed)!==plan.sha256)throw Error('Installed save verification failed; original remains at '+old);
    // Original also remains in the verified PC backup. Remove only this transaction's sibling backup.
    await c.remove(old);this.plans.delete(planId);
   });
   await writeFile(path.join(plan.directory,'restore-result.json'),JSON.stringify({state:'complete',titleId:plan.save.titleId,slot:plan.slot,sha256:plan.sha256,encryptedBackup:plan.backup,finishedAt:new Date().toISOString()},null,2));
   return {local:plan.directory,encryptedBackup:plan.backup,restored:true};
  }catch(e){
   // Never retry or delete recovery files when a commit response was lost.
   if(attempted)e.message+='; inspect the console before retrying. Original PC backup: '+plan.backup+(committed?'; the new image was committed':'');
   throw e;
  }
 }
}
