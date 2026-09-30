import http from 'node:http';
export const SHADOW_ROUTES=['version','storage','settings','games','images','scan','manual/add','games/mount','games/unmount','games/info'];
const LIMIT=1048576;
export function shadowJson(status,bytes){
 let data;try{data=JSON.parse(bytes.toString('utf8'));}catch{throw Error('ShadowMount returned invalid JSON');}
 if(status<200||status>=300||data.status!==0)throw Error('ShadowMount: '+(data.error||'HTTP '+status+' / status '+data.status));
 return data;
}
export function parseShadowHttp(raw){
 if(!Buffer.isBuffer(raw)||raw.length>LIMIT)throw Error('ShadowMount response exceeds 1 MiB');
 const split=raw.indexOf('\r\n\r\n');if(split<0||split>8192)throw Error('Invalid ShadowMount HTTP headers');
 const lines=raw.subarray(0,split).toString('latin1').split('\r\n'),match=/^HTTP\/1\.[01] (\d{3})\b/.exec(lines.shift());
 if(!match)throw Error('Invalid ShadowMount HTTP status');
 const headers=new Map();for(const line of lines){const at=line.indexOf(':');if(at<1)throw Error('Invalid ShadowMount header');const key=line.slice(0,at).toLowerCase();if(headers.has(key)&&['content-length','transfer-encoding'].includes(key))throw Error('Duplicate HTTP framing header');headers.set(key,line.slice(at+1).trim());}
 let body=raw.subarray(split+4);
 if(headers.has('transfer-encoding')){
  if(headers.get('transfer-encoding').toLowerCase()!=='chunked'||headers.has('content-length'))throw Error('Unsupported HTTP framing');
  const parts=[];let at=0;
  for(;;){const end=body.indexOf('\r\n',at);if(end<0)throw Error('Incomplete chunk');const line=body.subarray(at,end).toString();if(!/^[a-f\d]+(?:;[^\r\n]*)?$/i.test(line))throw Error('Invalid chunk');const n=parseInt(line,16);at=end+2;if(!Number.isSafeInteger(n)||n>LIMIT||at+n+2>body.length)throw Error('Incomplete chunk');if(!n){if(body.subarray(at,at+2).toString()!=='\r\n'||at+2!==body.length)throw Error('Unsupported chunk trailer');break;}if(body.subarray(at+n,at+n+2).toString()!=='\r\n')throw Error('Invalid chunk ending');parts.push(body.subarray(at,at+n));at+=n+2;}body=Buffer.concat(parts);
 }else if(headers.has('content-length')&&(!/^\d+$/.test(headers.get('content-length'))||Number(headers.get('content-length'))!==body.length))throw Error('Incomplete ShadowMount response');
 return shadowJson(Number(match[1]),body);
}
export class ShadowApi {
 constructor({profile,receiver}){this.profile=profile;this.receiver=receiver;this.port=10101;this.transport=null;}
 async call(route,args={}){
  const op=SHADOW_ROUTES.indexOf(route);if(op<0)throw Error('Unsupported ShadowMount operation');
  const body=Buffer.from(JSON.stringify(args));if(body.length>2044)throw Error('ShadowMount request too large');
  if(!Number.isInteger(this.port)||this.port<1||this.port>65535)throw Error('Invalid ShadowMount API port');
  if(this.receiver.ready&&this.receiver.host===this.profile().host){
   const runtime=this.receiver.runtimeInfo||await this.receiver.runtime();
   if(runtime.revision<106)throw Error('Restart the app and load the updated PS5 companion (revision 106) for ShadowMount');
   const frame=Buffer.alloc(4+body.length);frame.writeUInt16LE(this.port);frame.writeUInt16LE(op,2);body.copy(frame,4);
   const response=await this.receiver.command(23,frame);
   if(response.code)throw Error('ShadowMount loopback API is unavailable. Start ShadowMount and check its API port ('+this.port+'). Code '+response.code);
   this.transport='PS5 companion · local API';return parseShadowHttp(response.body);
  }
  // Use an existing LAN listener if the user already enabled it. Never expose
  // the unauthenticated ShadowMount API by changing console configuration.
  const data=await new Promise((resolve,reject)=>{
   const req=http.request({host:this.profile().host,port:this.port,path:'/api/v1/'+route,method:'POST',headers:{'Content-Type':'application/json','Content-Length':body.length},timeout:8000},res=>{
    const parts=[];let size=0;res.on('data',b=>{size+=b.length;if(size>LIMIT)res.destroy(Error('ShadowMount response exceeds 1 MiB'));else parts.push(b);});res.on('error',reject);res.on('end',()=>{try{resolve(shadowJson(res.statusCode,Buffer.concat(parts)));}catch(e){reject(e);}});
   });req.on('timeout',()=>req.destroy(Error('ShadowMount request timed out')));req.on('error',e=>reject(Error('Load the PS5 companion to reach ShadowMount’s local API. '+e.message)));req.end(body);
  });this.transport='Existing LAN API';return data;
 }
}
