// Website transport only. Console connections and files stay in the companion.
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const secret=()=>randomBytes(32).toString('hex');
export function createWebRelay({origin='https://psneighborhood.com',ui=path.join(root,'ui'),callTimeout=120000,pollTimeout=20000,maxSessions=256}={}){
  const sessions=new Map(),owners=new Map(),browsers=new Map(),rates=new Map();let pendingCount=0,buffered=0;
  const json=(res,status,value,headers={})=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(value));};
  function end(s,reason='Companion disconnected. Commands are not retried automatically.'){
    sessions.delete(s.code);owners.delete(s.owner);if(s.browser)browsers.delete(s.browser);
    if(s.poll){clearTimeout(s.poll.timer);json(s.poll.res,410,{error:reason});s.poll=null;}
    for(const p of s.pending.values()){clearTimeout(p.timer);p.reject(Error(reason));pendingCount--;}
    s.pending.clear();s.queue=[];
  }
  function deliver(s){if(!s.poll||!s.queue.length)return;const p=s.poll;s.poll=null;clearTimeout(p.timer);json(p.res,200,{jobs:s.queue.splice(0,8)});}
  function enqueue(s,method,args){
    if(s.pending.size>=24||pendingCount>=128)throw Error('Companion is busy. Wait for the current operation.');
    const id=secret();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{s.pending.delete(id);s.queue=s.queue.filter(j=>j.id!==id);pendingCount--;reject(Error('Operation timed out. It may still be running on the companion. Check status before retrying.'));},callTimeout);timer.unref?.();
      s.pending.set(id,{resolve,reject,timer});pendingCount++;s.queue.push({id,method,args});deliver(s);
    });
  }
  function limit(req){const ip=req.socket.remoteAddress==='127.0.0.1'?(req.headers['x-real-ip']||'local'):req.socket.remoteAddress;const now=Date.now();let r=rates.get(ip);if(!r||r.until<now){r={n:0,until:now+60000};rates.set(ip,r);}return ++r.n<=30;}
  async function body(req,max=2*1048576){const chunks=[];let n=0;try{for await(const c of req){if(n+c.length>max||buffered+c.length>64*1048576)throw Error('Request buffer busy or too large');n+=c.length;buffered+=c.length;chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');}finally{buffered-=n;}}
  const auth=req=>req.headers.authorization?.replace(/^Bearer /,'');
  function browser(req){const token=/(?:^|;\s*)psn_web=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];const s=browsers.get(token);return s&&s.expires>Date.now()?s:null;}
  const files=new Set(['index.html','app.js','style.css','conversion.js','boot.js','web-companion.js','web.css']);
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,origin),route=url.pathname;
      if(route==='/health'&&req.method==='GET')return json(res,200,{online:true,protocol:1,sessions:sessions.size,pending:pendingCount});
      if(route.startsWith('/bridge/')){
        if(req.method!=='POST'||req.headers.origin)return json(res,403,{error:'Companion clients only'});
        if(route==='/bridge/register'){
          if(!limit(req)||sessions.size>=maxSessions)return json(res,429,{error:'Pairing busy. Try again shortly.'});
          const b=await body(req,4096);if(b.protocol!==1)throw Error('Update the companion to the website release.');
          const code=randomBytes(10).toString('hex').toUpperCase(),owner=secret(),now=Date.now();
          const s={code,owner,expires:now+15*60000,lastPoll:now,queue:[],pending:new Map(),poll:null,browser:null,pairing:false};sessions.set(code,s);owners.set(owner,s);
          return json(res,200,{code,owner,expires:s.expires});
        }
        const s=owners.get(auth(req));if(!s||s.expires<Date.now())return json(res,401,{error:'Companion session ended'});
        if(route==='/bridge/poll'){
          await body(req,4096);s.lastPoll=Date.now();if(s.poll)return json(res,409,{error:'Poll already active'});
          const timer=setTimeout(()=>{if(s.poll?.res===res){s.poll=null;json(res,200,{jobs:[]});}},pollTimeout);timer.unref?.();s.poll={res,timer};
          res.on('close',()=>{if(s.poll?.res===res){clearTimeout(timer);s.poll=null;}});deliver(s);return;
        }
        if(route==='/bridge/result'){
          const b=await body(req,32*1048576),p=s.pending.get(b.id);if(p){s.pending.delete(b.id);clearTimeout(p.timer);pendingCount--;b.error?p.reject(Error(String(b.error))):p.resolve(b.result);}return json(res,200,{ok:true});
        }
        if(route==='/bridge/revoke'){end(s);return json(res,200,{ok:true});}
        return json(res,404,{error:'Not found'});
      }
      // Only our own browser frontend may initiate session or control requests.
      if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{error:'Website origin required'});
      if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'Same-origin access required'});
      if(route==='/web/pair'&&req.method==='POST'){
        if(req.headers.origin!==origin||!limit(req))return json(res,403,{error:'Pairing request rejected'});
        const b=await body(req,4096),code=String(b.code||'').replaceAll('-','').replaceAll(' ','').toUpperCase(),s=sessions.get(code);
        if(!s||s.browser||s.pairing||s.expires<Date.now())return json(res,400,{error:'Code unavailable. Start a new website session in the companion.'});
        s.pairing=true;
        try{
          const accepted=await enqueue(s,'@pair',{});if(accepted!==true)throw Error('Pairing declined on the companion.');
          if(!owners.has(s.owner))throw Error('Companion disconnected');
          s.browser=secret();s.expires=Date.now()+8*60*60000;browsers.set(s.browser,s);
          const secure=origin.startsWith('https:')?'; Secure':'';
          return json(res,200,{paired:true},{'Set-Cookie':`psn_web=${s.browser}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=28800`});
        }finally{s.pairing=false;}
      }
      if(route==='/api/session'&&req.method==='GET'){
        const s=browser(req);return s?json(res,200,{token:s.browser,website:true,expires:s.expires}):json(res,401,{error:'Pair with your companion first'});
      }
      if(route==='/api/call'&&req.method==='POST'){
        const s=browser(req);if(!s||auth(req)!==s.browser)return json(res,401,{error:'Website session disconnected. Reload to pair again.'});
        const b=await body(req);if(typeof b.method!=='string'||b.method.startsWith('@')||!b.args||typeof b.args!=='object'||Array.isArray(b.args))throw Error('Expected method and args');
        if(['web_start','web_stop','web_status'].includes(b.method))throw Error('Manage website access from the companion');
        return json(res,200,{result:await enqueue(s,b.method,b.args)});
      }
      if(route==='/web/disconnect'&&req.method==='POST'){
        const s=browser(req);if(!s||auth(req)!==s.browser)return json(res,401,{error:'No session'});end(s,'Website disconnected');return json(res,200,{ok:true},{'Set-Cookie':'psn_web=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'});
      }
      const file=route==='/'?'index.html':route.slice(1);if(req.method!=='GET'||!files.has(file))return json(res,404,{error:'Not found'});
      const content=await readFile(path.join(ui,file));res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(content);
    }catch(e){json(res,400,{error:e.message});}
  });
  server.requestTimeout=45000;server.headersTimeout=15000;server.maxConnections=1024;
  const sweep=setInterval(()=>{const now=Date.now();for(const s of sessions.values())if(s.expires<now||s.lastPoll<now-65000)end(s);for(const[ip,r]of rates)if(r.until<now)rates.delete(ip);},5000);sweep.unref();
  return {server,close(){clearInterval(sweep);for(const s of sessions.values())end(s);server.closeAllConnections();server.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const relay=createWebRelay({origin:process.env.PSN_WEB_ORIGIN||'https://psneighborhood.com'});
  relay.server.listen(Number(process.env.PORT||8794),'127.0.0.1',()=>console.log('PS Neighborhood website relay ready'));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>relay.close());
}
