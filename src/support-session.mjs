import {createHash} from 'node:crypto';
import {Writable} from 'node:stream';
import {Client as FtpClient} from 'basic-ftp';
import {PS4Debug,probe} from './protocol.mjs';
import {PS5Debug} from './ps5debug.mjs';
import {Workbench} from './workbench.mjs';
import {listDirectory} from './ftp-list.mjs';
import {validatePS5Elf} from './platform.mjs';
import {transferPayload} from './payload-transfer.mjs';
import {SUPPORT_RELAY,SUPPORT_ACTION_METHODS,relayUrl,supportRequest} from './support-protocol.mjs';
import {supportSchemas} from './support-tools.mjs';

export class SupportExecutor {
  constructor(profile,{actions=false,debugFactory=p=>new (p.platform==='ps5'?PS5Debug:PS4Debug)({host:p.host,port:p.debugPort}),ftpFactory=()=>new FtpClient(10000)}={}){
    this.profile={...profile};this.actions=actions;this.debugFactory=debugFactory;this.ftpFactory=ftpFactory;
    this.memory={mode:'live',requireClient:()=>this.requireClient()};
    for(const name of ['read','readv','inspect','strings','pointer'])this.memory[name]=Workbench.prototype[name];
  }
  close(){this.client?.close();this.client=null;this.ftp?.close();}
  requireClient(){if(!this.client?.connected)throw Error('Connect the support debugger first');return this.client;}
  async run(method,args,signal){
    signal.throwIfAborted();const schema=supportSchemas.get(method);if(!schema)throw Error('Operation is not available in remote support');args=schema.parse(args);
    if(SUPPORT_ACTION_METHODS.has(method)&&!this.actions)throw Error('Owner has not enabled support actions');
    const abort=()=>this.close();signal.addEventListener('abort',abort,{once:true});
    try{
      if(method==='status')return {profile:this.profile,connected:!!this.client?.connected,actions:this.actions,capabilities:this.client?.capabilities||null};
      if(method==='probe')return await Promise.all([this.profile.debugPort,this.profile.ftpPort].map(port=>probe(this.profile.host,port,3000)));
      if(method==='connect'){
        if(this.client?.connected)return {connected:true,capabilities:this.client.capabilities};
        this.client=this.debugFactory(this.profile);await this.client.connect();signal.throwIfAborted();await this.client.detectCapabilities();signal.throwIfAborted();return {connected:true,capabilities:this.client.capabilities};
      }
      if(method==='processes')return await this.requireClient().processes();
      if(method==='process_info')return await this.requireClient().info(args.pid);
      if(method==='maps')return await this.requireClient().maps(args.pid);
      const memoryMethods={memory_read:'read',memory_readv:'readv',memory_inspect:'inspect',memory_strings:'strings',pointer_resolve:'pointer'};
      if(Object.hasOwn(memoryMethods,method))return await this.memory[memoryMethods[method]](args);
      if(method==='memory_write'){
        const c=this.requireClient(),expected=Buffer.from(args.expectedHex,'hex'),data=Buffer.from(args.hex,'hex');
        if(expected.length!==data.length)throw Error('Expected and replacement lengths must match');
        const before=await c.read(args.pid,args.address,data.length);signal.throwIfAborted();
        if(!before.equals(expected))throw Error('Memory changed; write refused');
        await c.writeMemory(args.pid,args.address,data);signal.throwIfAborted();const after=await c.read(args.pid,args.address,data.length);
        return {verified:after.equals(data),before:before.toString('hex'),after:after.toString('hex')};
      }
      if(method==='payload_send'){
        if(this.profile.platform!=='ps5')throw Error('Support ELF sending currently requires PS5');
        const data=Buffer.from(args.base64,'base64');if(data.length>32*1048576)throw Error('ELF exceeds 32 MiB');
        if(data.toString('base64')!==args.base64)throw Error('Invalid base64');
        if(createHash('sha256').update(data).digest('hex')!==args.sha256)throw Error('ELF checksum mismatch');validatePS5Elf(data);
        if(/ps5debug/i.test(args.name)){
          const state=await probe(this.profile.host,this.profile.debugPort,5000);signal.throwIfAborted();
          if(state.error!=='ECONNREFUSED')throw Error('Debugger is present or its state is uncertain; refusing duplicate load');
        }
        signal.throwIfAborted();await transferPayload(data,{host:this.profile.host,port:this.profile.payloadPort,signal});
        return {sha256:args.sha256,bytes:data.length,note:'ELF transferred; execution has not been confirmed.'};
      }
      if(method.startsWith('ftp_')){
        if(!args.remote.startsWith('/')||/[\r\n\0]/.test(args.remote))throw Error('Use an absolute console path');
        const c=this.ftp=this.ftpFactory();await c.access({host:this.profile.host,port:this.profile.ftpPort,user:'anonymous',password:'ps-neighborhood'});signal.throwIfAborted();
        if(method==='ftp_list')return (await listDirectory(c,args.remote)).slice(0,10000).map(f=>({name:f.name,size:f.size,directory:f.isDirectory}));
        let length=0;const chunks=[];const sink=new Writable({write(chunk,encoding,done){length+=chunk.length;if(length>4*1048576)return done(Error('Console file exceeds 4 MiB'));chunks.push(Buffer.from(chunk));done();}});
        await c.downloadTo(sink,args.remote);const data=Buffer.concat(chunks);return {remote:args.remote,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),encoding:args.encoding||'utf8',content:data.toString(args.encoding||'utf8')};
      }
      throw Error('Unsupported operation');
    }finally{signal.removeEventListener('abort',abort);this.ftp?.close();this.ftp=null;}
  }
}

export class SupportSession {
  constructor(workbench,{relay=SUPPORT_RELAY,allowLocal=false,pollMs=1000,request=supportRequest,executorFactory=(p,o)=>new SupportExecutor(p,o)}={}){
    this.workbench=workbench;this.relay=relayUrl(relay,{allowLocal});this.request=request;this.pollMs=pollMs;this.executorFactory=executorFactory;this.state={active:false,paired:false,actions:false,events:[]};
  }
  status(){return {...this.state,events:[...this.state.events]};}
  event(text){this.state.events.unshift({time:new Date().toISOString(),text});this.state.events.length=Math.min(this.state.events.length,30);this.workbench.log('Remote support',text,'support');}
  async start({actions=false}={}){
    if(this.state.active||this.starting)throw Error('A support session is already active');
    const w=this.workbench;
    if(w.mode==='demo'||w.conversion.busy||w.shadow.busy||w.console.busy||w.packages.busy||w.packages.server||w.transfer?.state==='running'||w.scanner.job?.state==='running'||w.dumps.job?.state==='running')throw Error('Finish local operations and leave the memory lab before starting support');
    this.starting=true;const controller=new AbortController();this.controller=controller;
    try{
      await w.disconnect();controller.signal.throwIfAborted();
      const session=await this.request(this.relay,'/sessions',null,{},AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]));controller.signal.throwIfAborted();
      this.session=session;this.profile=JSON.stringify(w.profile);this.executor=this.executorFactory(w.profile,{actions:actions===true});
      this.state={active:true,paired:false,actions:actions===true,code:session.code,expires:Date.now()+Math.min(session.ttlMs||3600000,3600000),pairExpires:Date.now()+Math.min(session.pairMs||300000,300000),console:w.profile.host,events:[]};
      this.event('Session started. Waiting for operator.');this.loop(controller).catch(()=>{});return this.status();
    }finally{this.starting=false;}
  }
  stop(reason='Disconnected by owner'){
    const session=this.session;this.session=null;this.controller?.abort();this.executor?.close();this.executor=null;
    this.state={...this.state,active:false,paired:false,actions:false,code:null};this.event(reason);
    if(session)this.request(this.relay,`/sessions/${session.id}/revoke`,session.owner,{},AbortSignal.timeout(5000)).catch(()=>{});
    return this.status();
  }
  async execute(job,executor,signal){
    signal.throwIfAborted();
    if(SUPPORT_ACTION_METHODS.has(job.method)&&!this.state.actions)throw Error('Owner has not enabled support actions');
    let args=job.args;
    if(job.payloadChars){
      if(job.method!=='payload_send'||!Number.isInteger(job.payloadChars)||job.payloadChars>44739244||job.payloadChars<1)throw Error('Invalid payload size');
      const session=this.session,chunks=[];
      for(let offset=0;offset<job.payloadChars;offset+=786432){
        signal.throwIfAborted();
        const part=await this.request(this.relay,`/sessions/${session.id}/payload`,session.owner,{jobId:job.id,offset},AbortSignal.any([signal,AbortSignal.timeout(15000)]));
        if(part.offset!==offset||typeof part.chunk!=='string'||part.chunk.length!==Math.min(786432,job.payloadChars-offset))throw Error('Incomplete payload chunk');
        chunks.push(part.chunk);
        if(chunks.length%8===0)this.event('Downloading ELF: '+Math.round((offset+part.chunk.length)/job.payloadChars*100)+'%');
      }
      args={...args,base64:chunks.join('')};
    }
    signal.throwIfAborted();return executor.run(job.method,args,signal);
  }
  async loop(controller){
    let response=null,busy=false;const seen=new Set();
    try{
      while(!controller.signal.aborted){
        if(JSON.stringify(this.workbench.profile)!==this.profile)throw Error('Console profile changed');
        if(Date.now()>=this.state.expires||(!this.state.paired&&Date.now()>this.state.pairExpires))throw Error('Session expired');
        const sent=response;
        const result=await this.request(this.relay,`/sessions/${this.session.id}/poll`,this.session.owner,{response:sent},AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]));if(response===sent)response=null;
        controller.signal.throwIfAborted();
        if(result.paired&&!this.state.paired){this.state.paired=true;this.state.code=null;this.event('Support operator connected.');}
        if(result.job){
          const job=result.job;if(busy||seen.has(job.id))throw Error('Duplicate or overlapping command refused');seen.add(job.id);if(seen.size>2000)throw Error('Session command limit reached');
          const remaining=job.timeoutMs;if(!(remaining>0&&remaining<=190000))throw Error('Command deadline expired');
          const executor=this.executor;busy=true;this.event('Started '+job.method);
          this.execute(job,executor,AbortSignal.any([controller.signal,AbortSignal.timeout(remaining)])).then(result=>{
            if(!controller.signal.aborted){response=Buffer.byteLength(JSON.stringify(result))>7*1048576?{id:job.id,error:'Result too large; use a smaller read or base64 file encoding'}:{id:job.id,result};this.event('Completed '+job.method);}
          },error=>{if(!controller.signal.aborted){response={id:job.id,error:error.message.slice(0,500)};this.event('Failed '+job.method+': '+error.message.slice(0,160));}}).finally(()=>{busy=false;});
        }
        await new Promise(resolve=>{const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,this.pollMs);controller.signal.addEventListener('abort',done,{once:true});});
      }
    }catch(e){if(!controller.signal.aborted)this.stop(e.message);}
  }
}
