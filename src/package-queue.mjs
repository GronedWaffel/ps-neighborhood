import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Runs in the backend so changing pages or minimizing the window cannot stop it.
export class PackageQueue {
  constructor(installer, inspect) { this.installer=installer;this.inspect=inspect;this.items=[];this.running=false;this.scanning=false;this.state='idle'; }
  status() { return { running:this.running,scanning:this.scanning,state:this.state,error:this.error,items:this.items.map(i=>({...i})),pending:this.items.filter(i=>i.state==='queued').length }; }
  async addFolder(folder, recursive=true) {
    if(this.scanning)throw Error('A folder is already being scanned');
    if(typeof folder!=='string'||!path.isAbsolute(folder))throw Error('Choose an absolute folder path');
    this.scanning=true;
    try {
      const root=await realpath(folder),directories=[root],files=[];let visited=0;
      while(directories.length) {
        if(++visited>10000)throw Error('Folder contains too many directories; choose a smaller folder');
        const dir=directories.shift();
        for(const entry of await readdir(dir,{withFileTypes:true})) {
          if(entry.isSymbolicLink())continue;
          const local=path.join(dir,entry.name);
          if(entry.isDirectory()&&recursive)directories.push(local);
          else if(entry.isFile()&&path.extname(entry.name).toLowerCase()==='.pkg')files.push(local);
          if(files.length>1000)throw Error('Folder contains more than 1,000 PKGs; choose a smaller folder');
        }
      }
      const key=p=>process.platform==='win32'?p.toLowerCase():p;
      const known=new Set(this.items.map(i=>key(i.local))),added=[];
      for(const local of files.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))) {
        const canonical=await realpath(local);if(known.has(key(canonical)))continue;
        known.add(key(canonical));
        try { const pkg=await this.inspect(canonical);added.push({...pkg,id:randomUUID(),relative:path.relative(root,local),state:pkg.shadowConvertible?'choose method':'queued'}); }
        catch(e) { added.push({id:randomUUID(),local:canonical,name:path.basename(local),relative:path.relative(root,local),state:'invalid',error:e.message}); }
      }
      if(this.items.length+added.length>1000)throw Error('Queue is limited to 1,000 packages');
      const rank=i=>i.kind==='Game / app'?0:i.kind==='Patch'?1:2;
      added.sort((a,b)=>(a.titleId||'').localeCompare(b.titleId||'')||rank(a)-rank(b)||a.relative.localeCompare(b.relative,undefined,{numeric:true}));
      this.items.push(...added);return {added:added.length,duplicates:files.length-added.length,...this.status()};
    } finally {this.scanning=false;}
  }
  remove(id) {
    const item=this.items.find(i=>i.id===id);
    if(item?.state==='active')throw Error('The current download is active; use Pause or Stop sharing');
    this.items=this.items.filter(i=>i.id!==id);return this.status();
  }
  useNative(id) {const item=this.items.find(i=>i.id===id);if(!item||item.state!=='choose method')throw Error('This package is not awaiting a method choice');item.state='queued';return this.status();}
  clear() { if(this.running||this.scanning||this.processing)throw Error('Wait for the current download before clearing the queue');this.items=[];this.state='idle';this.error=undefined;return this.status(); }
  start(options) {
    if(this.items.some(i=>i.state==='choose method'))throw Error('Choose conversion or native installation for the PS5 fPKGs before starting this queue');
    if(this.running||this.scanning||this.processing)throw Error('The queue is already running or scanning');
    if(this.installer.busy)throw Error('Wait for the current submission');
    if(this.installer.job?.queueItemId && this.installer.job.state==='paused')throw Error('Resume the current download first');
    if(!this.items.some(i=>i.state==='queued'))throw Error('Add a folder containing valid PKGs first');
    if(this.installer.server)throw Error('Stop sharing the previous package before starting the queue');
    this.options={...options};this.running=true;this.processing=true;this.state='running';this.error=undefined;
    this.done=this.run().catch(e=>{this.error=e.message;this.state='stopped on error';}).finally(()=>{this.running=false;this.processing=false;});
    return this.status();
  }
  stop() { this.running=false;if(this.state==='running')this.state='stopping after current download';return this.status(); }
  async run() {
    while(this.running) {
      if(this.items.some(i=>i.state==='choose method')){this.state='waiting for package method choice';return;}
      const item=this.items.find(i=>i.state==='queued');
      if(!item){this.state='downloads complete';return;}
      item.state='active';
      try {
        await this.installer.start({...this.options,local:item.local},true);
        const job=this.installer.job;job.queueItemId=item.id;item.taskId=job.taskId;
        if(job.state==='submission uncertain')throw Error(job.error);
        for(;;) {
          await new Promise(r=>{this.timer=setTimeout(r,1000);this.wake=r;});this.wake=null;
          if(!this.installer.server)throw Error('Sharing stopped; check PS4 Downloads before retrying this item');
          await this.installer.progress();
          item.transferred=job.progress?.transferred_total||0;item.total=job.progress?.length_total||item.size;
          if(job.error||job.pollError||job.servingError)throw Error(job.error||job.pollError||job.servingError);
          if(job.state==='installation complete'||(job.consolePlatform!=='ps5'&&job.state.startsWith('transfer complete')&&Number(job.progress.local_copy_percent)>=100))break;
        }
        item.state='download complete';
      } catch(e) { item.state='needs attention';item.error=e.message;throw e; }
    }
    this.state='stopped';
  }
  interrupt() {this.stop();if(this.wake){clearTimeout(this.timer);this.wake();this.wake=null;}}
}
