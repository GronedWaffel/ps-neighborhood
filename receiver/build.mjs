import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const zig=process.env.ZIG || path.resolve(root,'../tools/zig-x86_64-windows-0.14.1/zig.exe');
await mkdir(path.join(root,'build'),{recursive:true});
const privateNames=['sceSystemServiceLaunchApp','sceLncUtilGetAppId','sceLncUtilLaunchApp','sceLncUtilInitialize','sceSystemStateMgrEnterStandby','sceSystemStateMgrReboot','sceSystemStateMgrTurnOff'];
await writeFile(path.join(root,'build/nids.h'),privateNames.map(name=>{const nid=Buffer.from(createHash('sha1').update(name).update(Buffer.from('518d64a635ded8c1e6b039b1c3e55230','hex')).digest().subarray(0,8)).reverse().toString('base64').replaceAll('/','-').replaceAll('=','');return `#define NID_${name} "${nid}"`;}).join('\n')+'\n');
let asm='.text\n.section .text.startup,"ax"\n.global _start\n_start:\n jmp main\n';
for(const [name,id] of Object.entries({read:3,write:4,close:6,psn_kill:37,munmap:73,socket:97,connect:98,setsockopt:105,socketpair:135,psn_sysctl:202,psn_statfs:396,mmap:477,psn_evf_open:540,psn_evf_close:541,psn_evf_clear:546,dynlib_dlsym:591,dynlib_get_list:592,dynlib_load_prx:594,dynlib_get_info_ex:608})) asm+=`.section .text.${name},"ax"\n.global ${name}\n${name}:\n mov $${id},%rax\n mov %rcx,%r10\n syscall\n jnc 1f\n mov $-1,%rax\n1: ret\n`;
await writeFile(path.join(root,'build/syscalls.S'),asm);
const args=['cc','-target','x86_64-freestanding','-std=gnu11','-Os','-fPIE','-fno-stack-protector','-fno-unwind-tables','-fno-asynchronous-unwind-tables','-fno-builtin','-ffreestanding','-nostdinc','-Iinclude','-nostdlib','-static','-Wl,--build-id=none','-Wl,-T,payload.ld','build/syscalls.S','main.c','vendor/dl.c','vendor/ps4-libjbc/jailbreak.c','vendor/ps4-libjbc/kernelrw.c','-o','build/receiver.elf'];
const result=spawnSync(zig,args,{cwd:root,stdio:'inherit',env:{...process.env,ZIG_GLOBAL_CACHE_DIR:path.join(root,'build/zig-cache')}});if(result.status!==0)process.exit(result.status||1);
// Extract allocatable ELF sections by their virtual addresses. Include zeroed BSS in the
// transmitted image so GoldHEN allocates enough memory. Entry must be byte zero.
const elf=await readFile(path.join(root,'build/receiver.elf'));
if(elf.readBigUInt64LE(24)!==0n)throw Error('Payload entry is not at offset zero');
const shoff=Number(elf.readBigUInt64LE(40)), stride=elf.readUInt16LE(58),count=elf.readUInt16LE(60);let end=0;const sections=[];
for(let i=0;i<count;i++){const p=shoff+i*stride,type=elf.readUInt32LE(p+4),flags=elf.readBigUInt64LE(p+8),address=Number(elf.readBigUInt64LE(p+16)),offset=Number(elf.readBigUInt64LE(p+24)),size=Number(elf.readBigUInt64LE(p+32));if((type===4||type===9)&&size)throw Error('Unresolved relocations in final payload');if(flags&2n){end=Math.max(end,address+size);sections.push({type,address,offset,size});}}
if(end>1024*1024)throw Error('Unexpected payload size');const bin=Buffer.alloc(end);for(const s of sections)if(s.type!==8)elf.copy(bin,s.address,s.offset,s.offset+s.size);
const output=path.join(root,'build/ps-neighbourhood-receiver.bin');await writeFile(output,bin);
const manifest={protocol:1,bytes:bin.length,sha256:createHash('sha256').update(bin).digest('hex'),compiler:'Zig 0.14.1 / Clang',source:'receiver/main.c'};await writeFile(path.join(root,'build/manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest));
