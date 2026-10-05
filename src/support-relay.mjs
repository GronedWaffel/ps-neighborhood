import http from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const secret = () => randomBytes(32).toString('hex');
const equal = (a,b) => typeof a==='string' && typeof b==='string' && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const MAX_SUPPORT_BODY = 46*1048576;
export async function readJson(req,limit=MAX_SUPPORT_BODY) {
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('Request too large');chunks.push(chunk);}
  const value=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected an object');return value;
}
export function createSupportRelay({operatorKey,now=Date.now,sessionMs=3600000,pairMs=300000,leaseMs=15000,commandMs=60000,maxSessions=24}={}) {
  if(typeof operatorKey!=='string'||operatorKey.length<48)throw Error('A private operator key of at least 48 characters is required');
  const sessions=new Map(),rates=new Map();let bodyReaders=0;
  const finish=(s,error)=>{if(s.job){clearTimeout(s.job.timer);s.job.resolve({error});s.job=null;}};
  const revoke=(s,reason)=>{finish(s,reason);sessions.delete(s.id);};
  const sweep=()=>{for(const s of sessions.values())if(now()>s.expires||now()-s.seen>leaseMs)revoke(s,'Support session ended or disconnected');for(const [k,v] of rates)if(now()>v.until)rates.delete(k);};
  const timer=setInterval(sweep,1000);timer.unref();
  const json=(res,code,data)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  const server=http.createServer(async(req,res)=>{
    try{
      sweep();const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{online:true,protocol:1});
      if(req.method!=='POST'||req.headers.origin)return json(res,403,{error:'Support API clients only'});
      const auth=req.headers.authorization?.replace(/^Bearer /,'');
      if(url.pathname==='/sessions'){
        const ip=req.socket.remoteAddress==='127.0.0.1'?(req.headers['x-real-ip']||req.socket.remoteAddress):req.socket.remoteAddress;
        const rate=rates.get(ip)||{count:0,until:now()+60000};rate.count++;
        if(rates.size>2048&&!rates.has(ip))return json(res,429,{error:'Try again later'});rates.set(ip,rate);
        if(rate.count>5||sessions.size>=maxSessions)return json(res,429,{error:'Support capacity reached; try again shortly'});
        const s={id:secret(),owner:secret(),code:randomBytes(8).toString('hex').toUpperCase(),created:now(),expires:now()+sessionMs,seen:now(),controller:null,job:null};
        sessions.set(s.id,s);return json(res,201,{id:s.id,owner:s.owner,code:s.code,expires:s.expires,pairExpires:s.created+pairMs,ttlMs:sessionMs,pairMs});
      }
      if(url.pathname==='/claim'){
        if(!equal(auth,operatorKey))return json(res,401,{error:'Operator authentication required'});
        const {code}=await readJson(req,1024);const s=[...sessions.values()].find(s=>equal(s.code,code));
        if(!s||s.controller||now()>s.created+pairMs)return json(res,404,{error:'Pairing code unavailable or expired'});
        s.controller=secret();s.code=null;return json(res,200,{id:s.id,controller:s.controller,expires:s.expires});
      }
      const match=url.pathname.match(/^\/sessions\/([a-f0-9]{64})\/(poll|call|revoke|payload)$/);
      const s=match&&sessions.get(match[1]);if(!s)return json(res,404,{error:'Support session ended or not found'});
      const role=equal(auth,s.owner)?'owner':equal(auth,s.controller)?'controller':null;
      if(!role)return json(res,401,{error:'Invalid session credential'});
      if(match[2]==='revoke'){revoke(s,'Support session disconnected');return json(res,200,{ended:true});}
      if(match[2]==='payload'){
        if(role!=='owner')return json(res,403,{error:'Owner only'});
        const {jobId,offset}=await readJson(req,1024),job=s.job;
        if(!job||job.id!==jobId||!job.payload||!job.delivered||!Number.isInteger(offset)||offset<0||offset>=job.payload.length||offset%786432)throw Error('Invalid payload chunk request');
        return json(res,200,{offset,chunk:job.payload.slice(offset,offset+786432)});
      }
      if(match[2]==='poll'){
        if(role!=='owner')return json(res,403,{error:'Owner only'});
        const data=await readJson(req,8*1048576);if(!sessions.has(s.id))return json(res,410,{error:'Session ended'});s.seen=now();
        if(data.response&&s.job&&data.response.id===s.job.id){const job=s.job;s.job=null;clearTimeout(job.timer);job.resolve(data.response);}
        const job=s.job&&s.job.method!==null&&!s.job.delivered?{id:s.job.id,method:s.job.method,args:s.job.args,payloadChars:s.job.payload?.length||0,timeoutMs:Math.max(1,s.job.deadline-now())}:null;
        if(job){s.job.delivered=true;s.job.args=null;}
        return json(res,200,{paired:!!s.controller,expires:s.expires,job});
      }
      if(role!=='controller')return json(res,403,{error:'Paired operator only'});
      if(s.job||bodyReaders>=2||[...sessions.values()].filter(s=>s.job).length>=2)return json(res,409,{error:'Support command capacity is busy; do not retry a mutating command automatically'});
      // Reserve the slot before reading a potentially large ELF, including slow senders.
      const job={id:secret(),delivered:false,method:null,args:null,resolve:()=>{},deadline:now()+commandMs};s.job=job;bodyReaders++;
      let data;try{data=await readJson(req);}catch(e){if(s.job===job)s.job=null;throw e;}finally{bodyReaders--;}
      if(!sessions.has(s.id)||s.job!==job)return json(res,410,{error:'Session ended while receiving command'});
      if(typeof data.method!=='string'||!data.args||Array.isArray(data.args)||typeof data.args!=='object'){s.job=null;throw Error('Invalid command');}
      job.method=data.method;job.args=data.args;
      if(job.method==='payload_send'&&typeof job.args.base64==='string'){
        if(job.args.base64.length>44739244){s.job=null;throw Error('Payload too large');}
        job.payload=job.args.base64;job.args={...job.args};delete job.args.base64;
      }
      const timeout=job.method==='payload_send'?Math.max(commandMs,180000):commandMs;job.deadline=now()+timeout;data=null;
      const result=await new Promise(resolve=>{job.resolve=resolve;job.timer=setTimeout(()=>revoke(s,'Command timed out; session ended. Execution outcome may be unknown; do not automatically retry.'),timeout);});
      json(res,200,result);
    }catch(e){json(res,400,{error:e.message});}
  });
  server.requestTimeout=300000;server.headersTimeout=10000;
  return {server,sessions,close:()=>{clearInterval(timer);for(const s of sessions.values())revoke(s,'Relay stopped');server.closeAllConnections();return new Promise(r=>server.close(r));}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const relay=createSupportRelay({operatorKey:process.env.PSN_SUPPORT_OPERATOR_KEY});
  relay.server.listen(Number(process.env.PORT||8791),'127.0.0.1',()=>console.log('PS Neighborhood support relay listening on loopback'));
  for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>relay.close().then(()=>process.exit(0)));
}
