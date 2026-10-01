import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile,writeFile,rename,stat,statfs,realpath,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {inspectPackage} from './packages.mjs';

const gib=1024**3;
const helper=fileURLToPath(new URL('../converter/build/Neighborhood.Converter.exe',import.meta.url));
export class PackageConversion {
  constructor({directory,profile,shadow,guard=()=>{},executable=helper,spawnChild=spawn}) {
    Object.assign(this,{directory,profile,shadow,guard,executable,spawnChild});this.busy=false;this.persist=Promise.resolve();
  }
  async init(){
    await mkdir(this.directory,{recursive:true});
    try{this.job=JSON.parse(await readFile(path.join(this.directory,'conversion.json'),'utf8'));if(!/^[a-f0-9-]{36}$/.test(this.job.id))this.job=undefined;
      if(this.job&&['running','transferring','cancelling'].includes(this.job.state)){this.job.state=this.job.report?'ready':'interrupted';this.job.error='The app closed. Verified images can be transferred again; incomplete conversions must be restarted.';}
    }catch(e){if(e.code!=='ENOENT')this.job=undefined;}
    return this;
  }
  status(){
    const shadow=this.shadow.status(),id=this.job?.transferId,item=id?shadow.items.find(i=>i.id===id):undefined;
    // Queue counters checkpoint completed files. Use live byte counters while
    // this image is being sent, never progress from an unrelated queue entry.
    const transfer=item&&shadow.job?.id===id?{...item,...shadow.job}:item;
    return {busy:this.busy,job:this.job,transfer};
  }
  save(){const text=JSON.stringify(this.job);this.persist=this.persist.catch(()=>{}).then(async()=>{const file=path.join(this.directory,'conversion.json');await writeFile(file+'.tmp',text);await rename(file+'.tmp',file);});return this.persist;}
  async plan({local,outputFolder}){
    if(this.profile().platform!=='ps5')throw Error('Select the PS5 profile first');
    const pkg=await inspectPackage(local,{platform:'ps5'});
    if(!pkg.shadowConvertible)throw Error('Conversion supports finalized debug PS5 base-game packages only. Separate patches, DLC, retail and PS4 packages use the PKG installer.');
    outputFolder ||= path.join(this.directory,'conversions');
    if(!path.isAbsolute(outputFolder))throw Error('Choose an absolute PC output folder');
    await mkdir(outputFolder,{recursive:true});outputFolder=await realpath(outputFolder);
    const space=await statfs(outputFolder),available=space.bavail*space.bsize;
    // Header-only estimate. The helper checks the actual expanded size before extracting.
    const estimatedSpace=pkg.size*7+4*gib;
    const ready=await stat(this.executable).then(s=>s.isFile()).catch(()=>false);
    return {pkg,outputFolder,available,estimatedSpace,helperReady:ready,host:this.profile().host,firmware:this.profile().firmware,
      note:'Native PS5 fPKG launch is limited on 13.60. This creates a verified ShadowMount image; compatibility still depends on the game. Your original PKG and installed games are kept.'};
  }
  async start(args){
    if(this.busy)throw Error('A conversion is already running');this.guard();this.busy=true;
    try{
      const plan=await this.plan(args);
      if(!plan.helperReady)throw Error('The bundled converter is missing. Reinstall the complete PS Neighborhood build.');
      if(plan.available<plan.estimatedSpace)throw Error('Not enough PC space for the conservative conversion estimate. Choose a drive with more free space.');
      if(args.destination!==undefined&&(typeof args.destination!=='string'||!args.destination.startsWith('/')))throw Error('Choose a ShadowMount destination or convert only');
      const id=randomUUID(),work=path.join(plan.outputFolder,'PSN-conversion-'+id);
      await mkdir(work);await mkdir(path.join(work,'temp'));
      this.cancelled=false;this.job={id,work,pkg:plan.pkg,host:plan.host,destination:args.destination||null,state:'running',stage:'Starting converter',createdAt:new Date().toISOString()};await this.save();
      this.running=this.run().catch(async e=>{this.job.state=this.cancelled?'cancelled':this.job.report?'ready':'failed';this.job.error=e.message;if(!this.job.report)await this.cleanupPartial().catch(cleanup=>{this.job.error+=' Temporary files retained: '+cleanup.message;});}).finally(async()=>{this.busy=false;this.child=null;await this.save();});
      return this.status();
    }catch(e){this.busy=false;throw e;}
  }
  async run(){
    const j=this.job;
    await new Promise((resolve,reject)=>{
      const child=this.spawnChild(this.executable,['convert',j.pkg.local,j.work,j.pkg.titleId],{windowsHide:true,cwd:path.dirname(this.executable),env:{...process.env,TEMP:path.join(j.work,'temp'),TMP:path.join(j.work,'temp')},stdio:['pipe','pipe','pipe']});this.child=child;
      let report,error,stderr='';const lines=createInterface({input:child.stdout});
      child.stdin.on('error',()=>{});
      lines.on('line',line=>{if(line.length>32768)return;try{const e=JSON.parse(line);if(e.type==='progress')Object.assign(j,{stage:String(e.stage).slice(0,200),done:e.done,total:e.total,file:e.file});if(e.type==='error')error=String(e.message);if(e.type==='complete')report=e.report;}catch{}});
      child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-4000);});
      child.once('error',reject);child.once('close',code=>{lines.close();this.child=null;if(this.cancelled)return reject(Error('Conversion cancelled. Original PKG preserved.'));if(code!==0||!report)return reject(Error(error||stderr||'Converter stopped before verification completed'));j.report=report;resolve();});
    });
    try{await this.validateReport();}catch(e){delete j.report;throw e;}j.state='ready';j.stage='Verified image ready';await this.save();
    if(j.destination)await this.sendImage();
  }
  async validateReport(){
    const j=this.job,r=j.report,expected=path.join(j.work,j.pkg.titleId+'.ffpfsc');
    if(!r?.verified||r.titleId!==j.pkg.titleId||r.sourceSize!==j.pkg.size||path.resolve(r.source)!==path.resolve(j.pkg.local)||Math.abs(Date.parse(r.sourceModifiedUtc)-j.pkg.mtimeMs)>1||path.resolve(r.output)!==path.resolve(expected)||r.sourceSha256!==r.decodedSha256||!/^[A-F0-9]{64}$/i.test(r.imageSha256))throw Error('Invalid conversion verification report');
    const s=await stat(expected);if(s.size!==r.imageSize)throw Error('Verified image size changed');
    if(await realpath(expected)!==path.resolve(expected))throw Error('Converted image cannot be a link');
    return expected;
  }
  async cleanupPartial(){
    // Only a directory created exclusively for this job is eligible. Never remove
    // the selected output parent, source package, or any completed image.
    const j=this.job,work=path.resolve(j.work);
    if(path.basename(work)!=='PSN-conversion-'+j.id||await realpath(work)!==work||j.report)throw Error('Work-directory ownership check failed');
    await rm(work,{recursive:true,force:true});
  }
  async transfer({destination}){
    if(this.busy)throw Error('Wait for the current conversion');this.guard();
    if(!this.job?.report)throw Error('Convert and verify a package first');
    if(this.profile().host!==this.job.host||this.profile().platform!=='ps5')throw Error('Select the original target console to transfer this job');
    this.busy=true;this.cancelled=false;this.job.destination=destination;delete this.job.error;
    this.running=this.sendImage().catch(e=>{this.job.state='ready';this.job.error=e.message;}).finally(async()=>{this.busy=false;await this.save();});return this.status();
  }
  async sendImage(){
    const j=this.job,output=await this.validateReport();
    if(this.cancelled)throw Error('Conversion cancelled');
    if(this.profile().host!==j.host||this.profile().platform!=='ps5')throw Error('Target console changed');
    j.state='transferring';j.stage='Checking image before transfer';await this.save();
    const hash=createHash('sha256');for await(const chunk of createReadStream(output)){if(this.cancelled)throw Error('Transfer cancelled');hash.update(chunk);}
    if(hash.digest('hex').toUpperCase()!==j.report.imageSha256.toUpperCase())throw Error('Image hash changed since verification. Transfer refused.');
    await this.shadow.refresh();
    if(this.cancelled)throw Error('Transfer cancelled');
    const added=await this.shadow.add({local:output}),item=added.items.find(i=>path.resolve(i.local)===path.resolve(output));
    if(!item)throw Error('Could not queue converted image');
    j.transferId=item.id;
    // Carry the verified title into the installed-game conflict check for images too.
    const actual=this.shadow.items.find(i=>i.id===item.id);actual.titleId=j.pkg.titleId;await this.shadow.save();
    if(item.state!=='complete'){
      j.stage='Transferring to ShadowMount';this.shadow.start({destination:j.destination,id:item.id});await this.shadow.running;
      const done=this.shadow.status().items.find(i=>i.id===item.id);
      if(done?.state!=='complete')throw Error(done?.error||'Transfer did not complete. Retry from ShadowMount to resume copied files.');
    }
    const done=this.shadow.status().items.find(i=>i.id===item.id);j.state='complete';j.stage=done?.registered?'Copied and recognized by ShadowMount':'Copied; waiting for ShadowMount registration';
  }
  cancel(){
    this.cancelled=true;if(this.busy)this.job.state='cancelling';
    if(this.job?.transferId&&this.shadow.job?.id===this.job.transferId)this.shadow.cancel();
    const child=this.child;child?.stdin.end('cancel\n');if(child){const timer=setTimeout(()=>{if(this.child===child)child.kill();},5000);timer.unref();child.once('close',()=>clearTimeout(timer));}
    return this.status();
  }
  async close(){this.cancel();await this.running;await this.persist;}
}
