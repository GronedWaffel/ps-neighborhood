import { Client } from 'basic-ftp';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, stat, rename, writeFile, readFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {readAddons,smallText,changeVersions,mountedContent} from './console-content.mjs';
import {compatibility} from './firmware.mjs';
import {listDirectory} from './ftp-list.mjs';
import {PS5_STORAGE_PATHS} from './platform.mjs';
import {PS5Saves} from './ps5-saves.mjs';

const titlePattern=/^CUSA\d{5}$/, userPattern=/^[a-f\d]{1,8}$/i;
const now=()=>new Date().toISOString();
const storageDevice=d=>/^(?:\/dev\/)?(?:nvme|ssd|da|sd|md|lvd)\d/.test(d.mountFrom||'')?d.mountFrom.replace(/^\/dev\//,''):null;
export function safeName(name){return typeof name==='string' && name!=='.' && name!=='..' && name.length>0 && !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);}
export function readCatalog(file,{platform='ps4'}={}){
  const catalogTitlePattern=platform==='ps5'?/^(CUSA|PPSA|MOUU)\d{5}$/:titlePattern;
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Console catalog copy is inconsistent; refresh again');
    const result=new Map();
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if(platform==='ps5'&&tables.some(t=>t.name==='tbl_contentinfo')){
      const columns=new Set(db.prepare('PRAGMA table_info(tbl_contentinfo)').all().map(c=>c.name));
      if(!['titleId','titleName','contentId','size'].every(k=>columns.has(k)))throw Error('Unrecognized PS5 content catalog schema');
      for(const r of db.prepare('SELECT titleId,titleName,contentId,size FROM tbl_contentinfo WHERE size>0 LIMIT 10000').all())if(catalogTitlePattern.test(r.titleId))result.set(r.titleId,{titleId:r.titleId,name:r.titleName||r.titleId,contentId:r.contentId,catalogSize:r.size});
    }
    for(const {name} of tables.filter(t=>/^tbl_appbrowse_\d+$/.test(t.name))) {
      for(const r of db.prepare(`SELECT titleId,titleName,contentSize,category FROM "${name}" WHERE contentSize>0 LIMIT 10000`).all())if(catalogTitlePattern.test(r.titleId))result.set(r.titleId,{titleId:r.titleId,name:r.titleName||r.titleId,catalogSize:r.contentSize,category:r.category});
    }
    if(tables.some(t=>t.name==='tbl_appinfo'))for(const r of db.prepare("SELECT titleId,key,val FROM tbl_appinfo WHERE key IN ('TITLE','APP_VER','VERSION','CONTENT_ID') LIMIT 50000").all()){
      if(!catalogTitlePattern.test(r.titleId))continue;
      const game=result.get(r.titleId);if(game)game[{TITLE:'name',APP_VER:'version',VERSION:'packageVersion',CONTENT_ID:'contentId'}[r.key]]=String(r.val);
    }
    return result;
  }finally{db.close();}
}
export class ConsoleManager {
  constructor({directory,profile,packages,ps5Receiver,ps5AppInfo,debuggerInfo=()=>null,log=()=>{},clientFactory=()=>new Client(15000)}){
    Object.assign(this,{directory,profile,packages,ps5Receiver,ps5AppInfo,debuggerInfo,log,clientFactory});
    this.snapshot={games:[],saves:[],drives:[],categories:[],warnings:[]};this.job=null;this.backup=null;this.busy=false;
    this.saveTools=new PS5Saves(this);
  }
  get receiver(){return this.profile().platform==='ps5'?(this.ps5Receiver||{ready:false}):this.packages.receiver;}
  status(){const profile=this.profile(),ps5=profile.platform==='ps5',ready=!!this.receiver.ready&&this.receiver.host===profile.host;const snapshot=this.snapshot.host&& (this.snapshot.host!==profile.host||(this.snapshot.platform||'ps4')!==(profile.platform||'ps4'))?{games:[],saves:[],drives:[],categories:[],warnings:[]}:this.snapshot;return {...snapshot,job:this.job,backup:this.backup,busy:this.busy,receiverReady:ready,backupReady:ps5?this.debuggerInfo()?.platform==='ps5':ready&&!!snapshot.capabilities?.appInfo,compatibility:compatibility(profile.firmware||'auto',ps5?(this.debuggerInfo()||this.receiver.runtimeInfo):ready?this.receiver.runtimeInfo:null,profile.platform)};}
  guard(){if(this.busy || this.job?.state==='running' || this.backup?.state==='running')throw Error('Wait for the console operation to finish');}
  guardTransfers(){if(this.externalTransferBusy?.())throw Error('Wait for the ShadowMount transfer');if(this.packages.busy || this.packages.queue.processing || this.packages.server)throw Error('Finish the PKG queue and stop sharing packages before controlling the console');}
  requireReceiver(){if(!this.receiver.ready || this.receiver.host!==this.profile().host)throw Error('Load the background receiver for this console first');}
  async ftp(profile,fn){const c=this.clientFactory();this.activeClient=c;try{await c.access({host:profile.host,port:profile.ftpPort,user:'anonymous',password:'ps-neighborhood'});return await fn(c);}finally{c.close();if(this.activeClient===c)this.activeClient=null;}}
  async list(c,remote,optional=false){try{const entries=(await listDirectory(c,remote)).filter(e=>e.name!=='.'&&e.name!=='..');if(entries.some(e=>!safeName(e.name)))throw Error('A console filename cannot be represented safely on Windows: '+remote);return entries.filter(e=>!e.isSymbolicLink);}catch(e){if(optional&&e.code===550)return [];throw e;}}
  async walk(c,root,{optional=false,budget={dirs:0,files:0},prefix=''}={}){
    if(++budget.dirs>20000)throw Error('Directory scan limit reached; results are incomplete');
    const files=[];
    for(const f of await this.list(c,root,optional)){
      if(++budget.files>100000)throw Error('File scan limit reached; results are incomplete');
      const remote=root+'/'+f.name,relative=prefix+f.name;
      if(f.isDirectory)files.push(...await this.walk(c,remote,{budget,prefix:relative+'/'}));
      else if(f.isFile)files.push({remote,relative,size:f.size,modified:f.rawModifiedAt||f.modifiedAt?.toISOString()||null});
    }
    return files;
  }
  refresh(){
    this.guard();const profile={...this.profile()};
    this.job={id:randomUUID(),state:'running',detail:'Reading installed games',startedAt:now()};
    this.running=this.scan(profile).then(snapshot=>{this.snapshot=snapshot;this.job.state='complete';this.log('Console library',snapshot.games.length+' games · '+snapshot.saves.length+' save groups');}).catch(e=>{this.job.state='failed';this.job.error=e.message;}).finally(()=>{this.job.finishedAt=now();});
    return this.status();
  }
  async scan(profile){
    const ps5=profile.platform==='ps5', inventoryTitlePattern=ps5?/^(CUSA|PPSA|MOUU)\d{5}$/:titlePattern;
    const snapshot={platform:profile.platform||'ps4',host:profile.host,updatedAt:now(),games:[],saves:[],drives:[],categories:[],warnings:[],capabilities:{}};
    if(this.receiver.ready && this.receiver.host===profile.host){
      try{
        snapshot.capabilities=await this.receiver.consoleCapabilities();
        for(let i=0;i<(ps5?PS5_STORAGE_PATHS.length:3);i++)try{const d=await this.receiver.storage(i);if(d.mount===d.path&&!d.placeholder&&!snapshot.drives.some(x=>x.mount===d.mount||(storageDevice(d)&&storageDevice(x)===storageDevice(d))))snapshot.drives.push(d);}catch(e){if(i===0)snapshot.warnings.push('Storage: '+e.message);}
      }catch(e){snapshot.warnings.push('Receiver needs the console-management update: '+e.message);}
    }else snapshot.warnings.push(ps5?'Load the PS5 companion for free-space totals and available game/power controls.':'Load the background receiver to read drive capacity and enable game/power controls.');
    await this.ftp(profile,async c=>{
      let catalog=new Map();const cache=path.join(this.directory,'console-cache');await mkdir(cache,{recursive:true});const dbFile=path.join(cache,randomUUID()+'.db');
      try{
        const dbEntry=(await this.list(c,'/system_data/priv/mms')).find(x=>x.name==='app.db');
        if(!dbEntry || dbEntry.size>32*1024*1024)throw Error('Catalog missing or exceeds 32 MiB');
        await c.downloadTo(dbFile,'/system_data/priv/mms/app.db');catalog=readCatalog(dbFile,{platform:profile.platform});
      }catch(e){snapshot.warnings.push('Game names: '+e.message);}finally{await rm(dbFile,{force:true});}
      let addons=new Map();
      try{
        const entry=(await this.list(c,'/system_data/priv/mms')).find(x=>x.name==='addcont.db');
        if(entry){if(entry.size>32*1024*1024)throw Error('Add-on catalog exceeds 32 MiB');await c.downloadTo(dbFile,'/system_data/priv/mms/addcont.db');addons=readAddons(dbFile,{platform:profile.platform});}
      }catch(e){snapshot.warnings.push('Add-on names: '+e.message);}finally{await rm(dbFile,{force:true});}
      const games=new Map(),budget={dirs:0,files:0};
      const roots=[{root:'/user',drive:'/user'}];
      for(const drive of snapshot.drives.filter(d=>d.index>0)){
        if(!ps5){roots.push({root:drive.path+'/user',drive:drive.path});continue;}
        // Extended storage can expose app/patch/addcont directly or under user/.
        const entries=await this.list(c,drive.path,true);
        if(entries.some(e=>e.name==='user'&&e.isDirectory))roots.push({root:drive.path+'/user',drive:drive.path});
        if(entries.some(e=>['app','patch','addcont'].includes(e.name)&&e.isDirectory))roots.push({root:drive.path,drive:drive.path});
      }
      // FTP-only view still enumerates attached extended-storage directories.
      if(!snapshot.drives.length)for(const ext of ['/mnt/ext0','/mnt/ext1'])if((await this.list(c,ext,true)).some(e=>e.name==='user'&&e.isDirectory))roots.push({root:ext+'/user',drive:ext});
      for(const {root,drive} of roots)for(const [folder,category] of [['app','games'],['patch','patches'],['addcont','dlc']]){
        this.job.detail='Measuring '+root+'/'+folder;
        let total=0;
        for(const entry of await this.list(c,root+'/'+folder,true)){
          if(!entry.isDirectory||!inventoryTitlePattern.test(entry.name))continue;
          const titleId=entry.name,files=await this.walk(c,root+'/'+folder+'/'+titleId,{budget});
          const size=files.reduce((n,f)=>n+f.size,0);total+=size;if(!files.length&&!catalog.has(entry.name))continue;
          let game=games.get(titleId);if(!game){game={...catalog.get(titleId),titleId,name:catalog.get(titleId)?.name||titleId,baseBytes:0,patchBytes:0,dlcBytes:0,locations:[],managed:false};games.set(titleId,game);}
          game[{games:'baseBytes',patches:'patchBytes',dlc:'dlcBytes'}[category]]+=size;
          if(folder==='app')game.managed=true;
          game.packageFingerprint=(game.packageFingerprint||'')+JSON.stringify(files.map(f=>[f.remote,f.size,f.modified]));
          if(!game.locations.includes(drive))game.locations.push(drive);
        }
        snapshot.categories.push({drive,category,bytes:total});
      }
      for(const [titleId,entry] of catalog)if(!games.has(titleId))games.set(titleId,{...entry,baseBytes:0,patchBytes:0,dlcBytes:0,locations:[],managed:false});
      for(const game of games.values()){
        game.addons=addons.get(game.titleId)||[];
        if(ps5){
          if(!game.titleId.startsWith('CUSA'))try{
            const param=JSON.parse(await smallText(c,'/user/appmeta/'+game.titleId+'/param.json'));
            if(param.titleId!==game.titleId)throw Error('Title ID mismatch');
            const localized=param.localizedParameters||{},language=localized.defaultLanguage;
            const name=localized[language]?.titleName||localized['en-US']?.titleName;
            if(typeof name==='string')game.name=name.slice(0,512);
            if(typeof param.contentVersion==='string')game.version=param.contentVersion;
            if(typeof param.contentId==='string')game.contentId=param.contentId;
          }catch(e){if(e.code!==550)snapshot.warnings.push(game.titleId+' metadata: '+e.message);}
          delete game.packageFingerprint;continue;
        }
        if(!game.managed)continue;
        this.job.detail='Inspecting content for '+game.name;
        try{game.changeVersions=changeVersions(await smallText(c,'/user/appmeta/'+game.titleId+'/changeinfo/changeinfo.xml'));}catch(e){if(e.code!==550)snapshot.warnings.push(game.titleId+' update history: '+e.message);}
        const fingerprint=createHash('sha256').update(JSON.stringify([profile.host,game.contentId,game.version,game.packageVersion,game.packageFingerprint])).digest('hex');
        const evidenceFile=path.join(cache,createHash('sha256').update(profile.host).digest('hex').slice(0,16)+'-'+game.titleId+'.json');
        try{
          const evidence=await mountedContent(c,this.list.bind(this),game);
          if(evidence){game.content=evidence;await writeFile(evidenceFile,JSON.stringify({fingerprint,evidence}));}
          else{try{const saved=JSON.parse(await readFile(evidenceFile,'utf8'));if(saved.fingerprint===fingerprint)game.content={...saved.evidence,mounted:false};}catch{}}
        }catch(e){snapshot.warnings.push(game.titleId+' mounted content: '+e.message);}
        delete game.packageFingerprint;
      }
      this.job.detail='Reading save containers';
      let saveBytes=0;
      for(const user of await this.list(c,'/user/home',true)){
        if(!user.isDirectory||!userPattern.test(user.name))continue;
        for(const kind of ps5?['savedata','savedata_prospero']:['savedata'])for(const title of await this.list(c,`/user/home/${user.name}/${kind}`,true)){
          const isProspero=kind==='savedata_prospero';
          if(!title.isDirectory||!(isProspero?/^(PPSA|MOUU)\d{5}$/:titlePattern).test(title.name))continue;
          const root=`/user/home/${user.name}/${kind}/${title.name}`;
          const files=await this.walk(c,root,{budget});
          const metaRoot=`/user/home/${user.name}/${kind}_meta/user/${title.name}`;
          const metadata=await this.walk(c,metaRoot,{optional:true,budget});
          const size=[...files,...metadata].reduce((n,f)=>n+f.size,0);saveBytes+=size;
          snapshot.saves.push({id:user.name+':'+title.name,userId:user.name,titleId:title.name,name:games.get(title.name)?.name||catalog.get(title.name)?.name||title.name,bytes:size,files:files.length,root,metaRoot,format:isProspero?'ps5-encrypted-archive':'ps4-encrypted-backup'});
        }
      }
      snapshot.categories.push({drive:'/user',category:'saves',bytes:saveBytes});
      for(const [category,root] of [['captures','/user/av_contents'],['downloads','/user/download']]){
        this.job.detail='Measuring '+category;
        try{const files=await this.walk(c,root,{optional:true,budget});snapshot.categories.push({drive:'/user',category,bytes:files.reduce((n,f)=>n+f.size,0)});}catch(e){snapshot.warnings.push(category+': '+e.message);}
      }
      snapshot.games=[...games.values()].map(g=>({...g,totalBytes:g.baseBytes+g.patchBytes+g.dlcBytes})).sort((a,b)=>b.totalBytes-a.totalBytes);
    });
    if(snapshot.capabilities.appInfo)for(const game of snapshot.games){try{Object.assign(game,await this.receiver.appInfo(game.titleId));}catch(e){snapshot.warnings.push(game.titleId+': '+e.message);}}
    snapshot.updatedAt=now();return snapshot;
  }
  current(){if(this.snapshot.host!==this.profile().host||!this.snapshot.updatedAt)throw Error('Refresh this console library first');}
  async action({action,titleId,confirmation}){
    this.guard();this.guardTransfers();this.current();this.requireReceiver();
    const power=['shutdown','restart','rest'].includes(action);
    if(!power&&!['launch','close','uninstall','patch'].includes(action))throw Error('Unknown console action');
    if(confirmation!==(power?action:titleId))throw Error('Confirmation does not match this action');
    const game=power?null:this.snapshot.games.find(g=>g.titleId===titleId&&g.managed);
    if(!power&&!game)throw Error('Select a game with an installed package in the current library');
    if(action==='patch'&&!game.patchBytes)throw Error('No installed patch was found');
    this.busy=true;
    try{
      const caps=await this.receiver.consoleCapabilities();if(!caps[action])throw Error('This control is unavailable in the loaded receiver');
      if(!power){const info=await this.receiver.appInfo(titleId);if(!info.exists)throw Error('Game is no longer installed; refresh');if(['uninstall','patch'].includes(action)&&info.running)throw Error('Close this game before removing it or its patch');}
      const result=power?await this.receiver.power(action):await this.receiver.appAction(action,titleId);
      this.log('Console '+action,titleId||this.profile().host);return result;
    }catch(e){if(/disconnected|timed out/i.test(e.message))throw Error('Connection lost during '+action+'. The result is unknown; check the console before retrying.');throw e;}finally{this.busy=false;}
  }
  startBackup({id,decrypted=false}){
    this.guard();this.guardTransfers();this.current();if(this.profile().platform!=='ps5')this.requireReceiver();
    const save=this.snapshot.saves.find(s=>s.id===id);if(!save)throw Error('Select a save from the current library');
    if(decrypted&&(this.profile().platform!=='ps5'||save.format!=='ps5-encrypted-archive'))throw Error('Decrypted export currently requires a PS5 save on PS5');
    const profile={...this.profile()};this.backup={id:randomUUID(),state:'running',titleId:save.titleId,name:save.name,bytes:0,total:save.bytes,startedAt:now()};
    this.backupRunning=(decrypted?this.saveTools.export(save,profile):this.downloadSave(save,profile)).then(local=>{Object.assign(this.backup,{state:'complete',local});this.log(decrypted?'Decrypted save export':'Save backup',save.titleId+' → '+local);}).catch(e=>{Object.assign(this.backup,{state:'failed',error:e.message});}).finally(()=>{this.backup.finishedAt=now();});return this.backup;
  }
  startSaveRestore({id,folder,planId,confirmation}){
    this.guard();this.guardTransfers();this.current();this.requireReceiver();
    if(this.profile().platform!=='ps5')throw Error('This restore workflow requires PS5');
    const save=this.snapshot.saves.find(s=>s.id===id);if(!save||save.format!=='ps5-encrypted-archive')throw Error('Select a PS5 save from the current library');
    if(planId&&this.saveTools.plans.get(planId)?.save.id!==id)throw Error('Restore plan does not match this save');
    if(!planId&&(typeof folder!=='string'||!path.isAbsolute(folder)))throw Error('Choose the decrypted export folder');
    if(planId&&confirmation!==id)throw Error('Confirm the exact save to restore');
    this.backup={id:randomUUID(),state:'running',operation:planId?'restore':'prepare',titleId:save.titleId,name:save.name,sourceId:id,bytes:0,total:0,startedAt:now()};
    this.backupRunning=(planId?this.saveTools.apply(planId,confirmation):this.saveTools.prepare(save,{...this.profile()},folder)).then(result=>{Object.assign(this.backup,{state:'complete',...result});this.log(planId?'Save restored':'Save restore prepared',save.titleId);}).catch(e=>Object.assign(this.backup,{state:'failed',error:e.message})).finally(()=>{this.backup.finishedAt=now();});
    return this.backup;
  }
  discardSaveRestore({planId}){this.guard();this.saveTools.plans.delete(planId);if(this.backup?.planId===planId)Object.assign(this.backup,{ready:false,detail:'Restore preparation discarded'});return this.status();}
  async downloadSave(save,profile){
    const appInfo=title=>profile.platform==='ps5'?this.ps5AppInfo(title):this.receiver.appInfo(title);
    const info=await appInfo(save.titleId);if(info.running)throw Error('Close '+save.name+' before backing up its save');
    const dir=path.join(this.directory,'save-backups',save.titleId+'-'+this.backup.id),partial=dir+'.partial';
    await mkdir(partial,{recursive:true});
    return this.ftp(profile,async c=>{
      const inventory=async()=>[...(await this.walk(c,save.root)).map(f=>({...f,relative:'savedata/'+f.relative})),...(await this.walk(c,save.metaRoot,{optional:true})).map(f=>({...f,relative:'metadata/'+f.relative}))];
      const files=await inventory();if(!files.some(f=>f.relative.startsWith('savedata/sdimg_')))throw Error('No encrypted save containers found');
      if(save.format!=='ps5-encrypted-archive')for(const f of files.filter(f=>f.relative.startsWith('savedata/sdimg_')))if(!files.some(k=>k.relative==='savedata/'+f.relative.slice('savedata/sdimg_'.length)+'.bin'))throw Error('Save key file is missing; backup refused');
      const total=files.reduce((n,f)=>n+f.size,0);if(total>32*1024**3)throw Error('Save group exceeds 32 GiB');this.backup.total=total;
      let done=0;const manifest={version:1,format:save.format==='ps5-encrypted-archive'?'PS5 encrypted save archive':'PS4 encrypted save backup',platform:profile.platform||'ps4',note:save.format==='ps5-encrypted-archive'?'Encrypted original containers and visible metadata. Decrypted export and confirmed same-console/user restore use the separate PS5 save workflow; account portability is not supported.':undefined,host:profile.host,titleId:save.titleId,userId:save.userId,createdAt:now(),complete:false,files:[]};
      await writeFile(path.join(partial,'manifest.json'),JSON.stringify(manifest,null,2));
      for(const f of files){
        const local=path.join(partial,...f.relative.split('/'));await mkdir(path.dirname(local),{recursive:true});
        c.trackProgress(p=>{this.backup.bytes=done+p.bytes;});await c.downloadTo(local,f.remote);c.trackProgress();
        if((await stat(local)).size!==f.size)throw Error('Save changed size during download');
        const hash=createHash('sha256');for await(const chunk of createReadStream(local))hash.update(chunk);
        manifest.files.push({...f,sha256:hash.digest('hex')});done+=f.size;this.backup.bytes=done;
      }
      const after=await inventory(),fingerprint=list=>JSON.stringify(list.map(f=>[f.remote,f.size,f.modified]).sort((a,b)=>a[0].localeCompare(b[0])));
      if(fingerprint(after)!==fingerprint(files)||(await appInfo(save.titleId)).running)throw Error('Save changed or game launched during backup; incomplete backup retained');
      manifest.complete=true;manifest.finishedAt=now();await writeFile(path.join(partial,'manifest.json'),JSON.stringify(manifest,null,2));await rename(partial,dir);return dir;
    });
  }
  async close(){this.activeClient?.close();await Promise.allSettled([this.running,this.backupRunning]);await this.ps5Receiver?.close();}
}
