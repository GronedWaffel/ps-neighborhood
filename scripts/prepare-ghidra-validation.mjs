import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Dumps} from '../src/dumps.mjs';

const directory=path.resolve('artifacts/ghidra-validation',randomUUID());
await mkdir(path.join(directory,'projects'),{recursive:true});
let maps,read,pid=1;
if(process.argv[2]){
  const source=path.resolve(process.argv[2]),manifest=JSON.parse(await readFile(path.join(source,'manifest.json'),'utf8'));
  assert.equal(manifest.format,'ps-neighbourhood-memory-v1');
  maps=manifest.segments;
  const data=new Map();
  for(const segment of maps){
    assert.equal(path.basename(segment.file),segment.file,'Unsafe bundle filename');
    const bytes=await readFile(path.join(source,segment.file));
    assert.equal(bytes.length,segment.length);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),segment.sha256,'Source bundle checksum mismatch');
    data.set(segment.start,bytes);
  }
  pid=manifest.pid;
  read=async(_,address,length)=>{
    const segment=maps.find(s=>BigInt(address)>=BigInt(s.start)&&BigInt(address)+BigInt(length)<=BigInt(s.end));
    assert.ok(segment);const offset=Number(BigInt(address)-BigInt(segment.start));
    return data.get(segment.start).subarray(offset,offset+length);
  };
}else{
  maps=[['code','0x400000',5],['data','0x100002000',3],['readonly','0x7fff00000000',1]].map(([name,start,prot])=>({name,start,end:'0x'+(BigInt(start)+4096n).toString(16),prot,offset:'0x0'}));
  read=async(_,address,length)=>Buffer.from(Array.from({length},(_,i)=>Number((BigInt(address)+BigInt(i)*17n)&255n)));
}
const dumps=new Dumps(path.join(directory,'bundles'));
dumps.start({maps:async()=>maps,read},{pid,regionStarts:maps.map(s=>s.start)},{mode:'offline-validation'});
await dumps.running;assert.equal(dumps.job.state,'complete',dumps.job.error);
const manifest=await dumps.manifest(dumps.job.id),scripts=path.join(directory,'scripts');await mkdir(scripts);
await copyFile(path.join(dumps.job.folder,'ImportPSNeighbourhood.java'),path.join(scripts,'ImportPSNeighbourhood.java'));
const programName='PSN_'+manifest.id;
const checks=manifest.segments.map(s=>`check(program, "${s.start.slice(2)}", ${s.length}L, ${!!(s.prot&2)}, ${!!(s.prot&4)}, "${s.sha256}");`).join('\n');
await writeFile(path.join(scripts,'VerifyPSNImport.java'),`import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.MemoryBlock;
import java.security.MessageDigest;
import java.util.HexFormat;
public class VerifyPSNImport extends GhidraScript {
 public void run() throws Exception {
  Program program=currentProgram;
  boolean owned=program==null;
  if(owned){
   var file=state.getProject().getProjectData().getRootFolder().getFile("${programName}");
   if(file==null)throw new Exception("Importer did not save its program");
   program=(Program)file.getDomainObject(this,false,false,monitor);
  }
  try{
   if(!program.getLanguageID().toString().equals("x86:LE:64:default"))throw new Exception("Wrong architecture");
   if(program.getMemory().getBlocks().length!=${manifest.segments.length})throw new Exception("Wrong block count");
   if(program.getMemory().getNumAddresses()!=${dumps.job.bytes}L)throw new Exception("Unexpected memory in capture gaps");
   ${checks}
   println("PSN_IMPORT_VERIFIED: addresses, permissions, gaps and SHA-256 match; ${manifest.segments.length} blocks, ${dumps.job.bytes} bytes");
  }finally{if(owned)program.release(this);}
 }
 private void check(Program program,String start,long size,boolean write,boolean execute,String sha) throws Exception {
  var addr=program.getAddressFactory().getDefaultAddressSpace().getAddress(start);
  MemoryBlock block=program.getMemory().getBlock(addr);
  if(block==null||!block.getStart().equals(addr)||block.getSize()!=size||!block.isRead()||block.isWrite()!=write||block.isExecute()!=execute)throw new Exception("Block metadata mismatch at "+start);
  var hash=MessageDigest.getInstance("SHA-256");byte[] data=new byte[4096];
  for(long offset=0;offset<size;){monitor.checkCancelled();int n=(int)Math.min(data.length,size-offset);int got=block.getBytes(addr.add(offset),data,0,n);if(got!=n)throw new Exception("Short read");hash.update(data,0,n);offset+=n;}
  if(!HexFormat.of().formatHex(hash.digest()).equals(sha))throw new Exception("Byte mismatch at "+start);
 }
}
`);
console.log(JSON.stringify({directory,projects:path.join(directory,'projects'),scripts,bundle:dumps.job.folder,programName}));
