export const WEB_ORIGIN='https://psneighborhood.com';
export const NATIVE_ACTIONS=new Set(['choose-file','choose-folder','open-exports','open-saves','confirm-save-restore','confirm-console','mcp-config']);
export class WebCompanion {
  constructor({call,native,origin=WEB_ORIGIN,allowLocal=false}){
    const u=new URL(origin);if(u.origin!==origin||!(u.protocol==='https:'||(allowLocal&&u.hostname==='127.0.0.1'&&u.protocol==='http:')))throw Error('Website relay must use HTTPS');
    this.origin=origin;this.call=call;this.native=native;this.state={active:false,paired:false};this.generation=0;
  }
  status(){return {...this.state};}
  async request(route,owner,body={},signal){
    const r=await fetch(this.origin+route,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(owner?{Authorization:'Bearer '+owner}:{})},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(35000)]):AbortSignal.timeout(35000)});
    let size=0;const chunks=[];for await(const c of r.body){size+=c.length;if(size>18*1048576)throw Error('Website request too large');chunks.push(c);}
    const b=JSON.parse(Buffer.concat(chunks).toString());if(!r.ok)throw Error(b.error||'Website relay unavailable');return b;
  }
  async start(){
    if(this.state.active||this.starting)throw Error('A website session is already active');
    this.starting=true;const generation=++this.generation,controller=new AbortController();this.controller=controller;
    try{
      const session=await this.request('/bridge/register',null,{protocol:1},controller.signal);controller.signal.throwIfAborted();
      this.session=session;this.state={active:true,paired:false,code:session.code,expires:session.expires,origin:this.origin};
      this.loop(session,controller,generation).catch(e=>{if(generation===this.generation)this.stop(e.message);});return this.status();
    }finally{this.starting=false;}
  }
  stop(reason='Website disconnected'){
    const session=this.session;this.session=null;this.generation++;this.controller?.abort();this.state={active:false,paired:false,error:reason};
    if(session)this.request('/bridge/revoke',session.owner).catch(()=>{});return this.status();
  }
  async execute(job,session,controller,generation){
    const signal=controller.signal;let result,error;
    try{
      signal.throwIfAborted();if(generation!==this.generation)throw Error('Session ended');
      if(job.method==='@pair'){
        result=await this.native('confirm-web',{origin:this.origin});signal.throwIfAborted();
        if(result===true)this.state={...this.state,paired:true,code:null,expires:Date.now()+8*60*60000};
      }else{
        if(!this.state.paired)throw Error('Approve pairing in the companion first');
        if(job.method.startsWith('native:')){const action=job.method.slice(7);if(!NATIVE_ACTIONS.has(action))throw Error('Unknown native action');result=await this.native(action,job.args);}
        else result=await this.call(job.method,job.args,signal);
      }
    }catch(e){error=e.message;}
    if(generation===this.generation&&!signal.aborted)await this.request('/bridge/result',session.owner,{id:job.id,result,error},signal);
  }
  async loop(session,controller,generation){
    const active=new Set();
    while(!controller.signal.aborted){
      if(active.size>=24){await Promise.race(active);continue;}
      const b=await this.request('/bridge/poll',session.owner,{},controller.signal);
      for(const job of b.jobs){if(active.size>=32)throw Error('Website operation queue exceeded');const p=this.execute(job,session,controller,generation);active.add(p);p.catch(e=>{if(generation===this.generation)this.stop(e.message);}).finally(()=>active.delete(p));}
    }
  }
}
