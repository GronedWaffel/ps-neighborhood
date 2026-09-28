import net from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import {decodeFirmware} from './firmware.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../receiver/build');
const RESPONSE=0x52534e50, COMMAND=0x43534e50;
export function parseStorage(p,index) {
  if(p.length!==120)throw Error('Invalid storage reply');
  const [total,free,available]=[0,8,16].map(n=>Number(p.readBigUInt64LE(n)));
  if(!Number.isSafeInteger(total)||total<=0||free>total||available>free)throw Error('Invalid PS4 filesystem sizes');
  const mount=p.subarray(32,120).toString('utf8').split('\0')[0];
  return {index,path:['/user','/mnt/ext0','/mnt/ext1'][index],mount,fsid:p.subarray(24,32).toString('hex'),total,free,available,used:total-free};
}
function titleBytes(title){if(typeof title!=='string'||!/^CUSA\d{5}$/.test(title))throw Error('Expected an installed CUSA title ID');return Buffer.from(title);}
export class Receiver {
  constructor(){this.server=null;this.socket=null;this.pending=new Map();this.next=1;this.tail=Promise.resolve();this.ready=false;this.loading=false;}
  status(){return {ready:this.ready,serviceReady:!!this.ready&&!!this.serviceReady,loading:this.loading,host:this.host,pcAddress:this.pcAddress,port:this.port,error:this.error,protocol:1,runtime:this.ready?this.runtimeInfo:null};}
  async runtime(){const p=this.checked(await this.command(13));if(p.length!==12)throw Error('Load the updated receiver for firmware detection');this.runtimeInfo={firmware:decodeFirmware(p.readUInt32LE()),raw:p.readUInt32LE(),target:!!p.readUInt32LE(4),revision:p.readUInt32LE(8)};return this.runtimeInfo;}
  async load({host,payloadPort=9090,pcAddress,port=9697}){
    if(this.loading)throw Error('Receiver is already loading');
    if(this.ready){if(host!==this.host)throw Error('Receiver belongs to a different console');return this.status();}
    await this.close();this.loading=true;this.error=undefined;
    try{
      if(net.isIP(host)!==4 || net.isIP(pcAddress)!==4 || !Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(payloadPort)||payloadPort<1||payloadPort>65535)throw Error('Invalid receiver network settings');
      this.host=host;this.pcAddress=pcAddress;this.port=port;
      const image=Buffer.from(await readFile(path.join(root,'ps-neighbourhood-receiver.bin'))), manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
      if(createHash('sha256').update(image).digest('hex')!==manifest.sha256)throw Error('Receiver binary checksum mismatch; rebuild the receiver');
      const marker=Buffer.from('PSNRECEIVERCFG01'),at=image.indexOf(marker);
      if(at<0 || image.indexOf(marker,at+1)!==-1 || at+56>image.length)throw Error('Invalid receiver configuration marker');
      Buffer.from(pcAddress.split('.').map(Number)).copy(image,at+16);image.writeUInt16BE(port,at+20);this.key=randomBytes(32);this.key.copy(image,at+24);
      let onHello, rejectHello;
      const hello=new Promise((resolve,reject)=>{onHello=resolve;rejectHello=reject});hello.catch(()=>{});
      this.server=net.createServer(socket=>{
        if(socket.remoteAddress?.replace(/^::ffff:/,'')!==host || this.socket){socket.destroy();return;}
        socket.setNoDelay(true);let buffered=Buffer.alloc(0),authenticated=false;
        const handshakeTimer=setTimeout(()=>socket.destroy(Error('Receiver handshake timed out')),4000);
        socket.on('data',chunk=>{
          buffered=Buffer.concat([buffered,chunk]);
          try{
            while(buffered.length>=16){
              const magic=buffered.readUInt32LE(0),id=buffered.readUInt32LE(4),code=buffered.readInt32LE(8),len=buffered.readUInt32LE(12);
              if(magic!==RESPONSE || len>2048)throw Error('Invalid receiver response');if(buffered.length<16+len)return;
              const body=Buffer.from(buffered.subarray(16,16+len));buffered=buffered.subarray(16+len);
              if(!authenticated){if(id!==0||code!==0||len!==36||body.readUInt32LE(32)!==1||!timingSafeEqual(body.subarray(0,32),this.key))throw Error('Receiver authentication failed');authenticated=true;clearTimeout(handshakeTimer);this.socket=socket;this.ready=true;onHello();}
              else {const p=this.pending.get(id);if(!p)throw Error('Unexpected receiver reply');this.pending.delete(id);clearTimeout(p.timer);p.resolve({code,body});}
            }
          }catch(e){socket.destroy(e);}
        });
        socket.on('error',e=>{this.error=e.message;if(!authenticated)rejectHello(e);});
        socket.on('close',()=>{clearTimeout(handshakeTimer);if(this.socket===socket){this.ready=false;this.socket=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Receiver disconnected; an in-flight install may have been submitted'));}this.pending.clear();}else if(!authenticated)rejectHello(Error('Receiver closed before authentication'));});
      });
      await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,pcAddress,resolve)});
      await new Promise((resolve,reject)=>{const s=net.createConnection({host,port:payloadPort});s.setTimeout(10000,()=>s.destroy(Error('GoldHEN BinLoader timed out')));s.once('error',reject);s.once('connect',()=>s.end(image,resolve));s.once('finish',()=>s.destroy());});
      const timer=setTimeout(()=>rejectHello(Error(`Receiver did not connect back. Allow TCP ${port} from ${host} to ${pcAddress} in Windows Firewall; check GoldHEN BinLoader.`)),15000);
      try{await hello;}finally{clearTimeout(timer);}
      this.heartbeat=setInterval(()=>{if(!this.pending.size)this.command(1).catch(e=>{this.error=e.message;});},5000);this.heartbeat.unref();
      return this.status();
    }catch(e){this.error=e.message;await this.close();throw e;}finally{this.loading=false;}
  }
  command(op,body=Buffer.alloc(0)){
    const run=this.tail.then(()=>new Promise((resolve,reject)=>{
      if(!this.ready||!this.socket)return reject(Error('Load the PS Neighbourhood receiver first'));
      const id=this.next++,frame=Buffer.alloc(16);frame.writeUInt32LE(COMMAND);frame.writeUInt32LE(id,4);frame.writeUInt32LE(op,8);frame.writeUInt32LE(body.length,12);
      const timer=setTimeout(()=>{this.pending.delete(id);this.socket?.destroy();reject(Error('Receiver command timed out; check PS4 Downloads before retrying an install'));},20000);
      this.pending.set(id,{resolve,reject,timer});this.socket.write(Buffer.concat([frame,body]));
    }));this.tail=run.catch(()=>{});return run;
  }
  checked(result){if(result.code){const e=Error(`PS4 receiver error 0x${(result.code>>>0).toString(16).toUpperCase()}`);e.result=result;throw e;}return result.body;}
  async probe(){
    this.serviceReady=false;
    try{
      await this.runtime();
      const r=await this.command(2);
      if(r.body.length!==4)throw Error('Invalid receiver initialization reply');
      const stage=r.body.readUInt32LE(),label={1:'credentials',2:'module loading',3:'active user lookup',4:'AppInstUtil',5:'BGFT',30:'UserService startup',40:'firmware not in receiver target list; FTP remains available'}[stage]||'unknown';
      if(r.code)throw Error(`PS4 install service initialization failed at stage ${stage} (${label}): 0x${(r.code>>>0).toString(16).toUpperCase()}`);
      this.serviceReady=true;this.error=undefined;
      return {background:true,...this.status()};
    }catch(e){this.error=e.message;throw e;}
  }
  async install(pkg,url){
    const strings=[pkg.contentId,pkg.name,url].map((s,i)=>{const b=Buffer.from(s);if(b.length>=[40,256,768][i]||b.includes(0))throw Error('Package name or URL is too long');const length=Buffer.alloc(4);length.writeUInt32LE(b.length);return Buffer.concat([length,b]);});
    const head=Buffer.alloc(12);head.writeBigUInt64LE(BigInt(pkg.size));head.writeUInt32LE(pkg.type,8);
    const r=await this.command(3,Buffer.concat([head,...strings]));
    if(r.body.length!==8)throw Error('Invalid receiver install reply');
    const taskId=r.body.readInt32LE(),stage=r.body.readUInt32LE(4);
    if(r.code)throw Error(`PS4 install failed at stage ${stage}, task ${taskId}: 0x${(r.code>>>0).toString(16).toUpperCase()}`);
    if(taskId<0)throw Error('Receiver did not return an install task');return {task_id:taskId,title:pkg.name};
  }
  async progress(taskId){const id=Buffer.alloc(4);id.writeInt32LE(taskId);const p=this.checked(await this.command(4,id));if(p.length!==64)throw Error('Invalid progress reply');return {status:'success',bits:p.readUInt32LE(),error:p.readInt32LE(4),length:Number(p.readBigUInt64LE(8)),transferred:Number(p.readBigUInt64LE(16)),length_total:Number(p.readBigUInt64LE(24)),transferred_total:Number(p.readBigUInt64LE(32)),rest_sec_total:p.readUInt32LE(52),preparing_percent:p.readInt32LE(56),local_copy_percent:p.readInt32LE(60)};}
  async control(taskId,action){const id=Buffer.alloc(4);id.writeInt32LE(taskId);this.checked(await this.command(action==='pause'?5:6,id));}
  async consoleCapabilities(){
    const p=this.checked(await this.command(8));if(p.length!==12)throw Error('Load the updated console receiver');
    const bits=p.readUInt32LE();return {...Object.fromEntries(['storage','appInfo','launch','close','uninstall','patch','shutdown','restart','rest'].map((name,i)=>[name,!!(bits&(1<<i))])),symbolMask:p.readUInt32LE(4),systemModule:p.readInt32LE(8)};
  }
  async storage(index){if(!Number.isInteger(index)||index<0||index>2)throw Error('Invalid drive');const b=Buffer.alloc(4);b.writeUInt32LE(index);return parseStorage(this.checked(await this.command(9,b)),index);}
  async appInfo(title){const p=this.checked(await this.command(10,titleBytes(title)));if(p.length!==12)throw Error('Invalid application reply');return {exists:!!p.readInt32LE(),appId:p.readInt32LE(4),running:!!p.readInt32LE(8)};}
  async appAction(action,title){const code={launch:1,close:2,uninstall:3,patch:4}[action];if(!code)throw Error('Unknown game action');const b=Buffer.alloc(4);b.writeUInt32LE(code);this.checked(await this.command(11,Buffer.concat([b,titleBytes(title)])));return {accepted:true};}
  async power(action){const code={shutdown:1,restart:2,rest:3}[action];if(!code)throw Error('Unknown power action');const b=Buffer.alloc(4);b.writeUInt32LE(code);this.checked(await this.command(12,b));return {accepted:true};}
  async close(){clearInterval(this.heartbeat);if(this.ready)await this.command(7).catch(()=>{});this.socket?.destroy();this.ready=false;this.serviceReady=false;this.runtimeInfo=null;this.socket=null;const s=this.server;this.server=null;if(s)await new Promise(r=>s.close(r));}
}
