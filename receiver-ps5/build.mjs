import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validatePS5Elf} from '../src/platform.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const sdk=path.resolve(process.env.PS5_PAYLOAD_SDK||path.join(root,'../tools/ps5-sdk-0.43/ps5-payload-sdk')).replaceAll('\\','/');
const zig=process.env.ZIG||path.resolve(root,'../tools/zig-x86_64-windows-0.14.1/zig.exe');
const diagnostic=process.argv.includes('--diagnostic'),servicesDiagnostic=process.argv.includes('--services-diagnostic'),source=diagnostic?'diagnostic.c':'main.c',name=diagnostic?'ps-neighbourhood-memory-check':servicesDiagnostic?'ps-neighbourhood-service-check':'ps-neighbourhood-ps5';
await mkdir(path.join(root,'build'),{recursive:true});
// Zig supplies Clang/LLD on Windows. All runtime objects, headers, stubs and the
// linker script come from the PS5 SDK; no host/Linux libc is linked.
const args=['cc','-target','x86_64-linux-none','-U__linux__','-D__FreeBSD__=11','-D__PS5__','-isystem',sdk+'/target/include','-Os','-fPIE','-fno-stack-protector','-fno-plt','-femulated-tls','-nostdlib','-pie','-Wl,--hash-style=gnu','-Wl,-z,max-page-size=0x4000','-Wl,-T,'+sdk+'/ldscripts/elf_x86_64.x','main.c',sdk+'/target/lib/crt1.o',sdk+'/target/lib/libc.a','-L',sdk+'/target/lib','-ldl','-lkernel_web','-lSceLibcInternal','-lSceNet','-Wl,--no-as-needed','-lSceSystemService','-lSceUserService','-lSceIpmi','-lSceAppInstUtil','-lSceFsInternalForVsh','-o','build/ps-neighbourhood-ps5.elf'];
if(servicesDiagnostic)args.splice(1,0,'-DPSN_SERVICE_DIAGNOSTIC');
args[args.indexOf('main.c')]=source;args[args.length-1]='build/'+name+'.elf';
const result=spawnSync(zig,args,{cwd:root,stdio:'inherit',env:{...process.env,ZIG_GLOBAL_CACHE_DIR:path.join(root,'build/zig-cache')}});if(result.status!==0)process.exit(result.status||1);
const data=await readFile(path.join(root,'build/'+name+'.elf'));validatePS5Elf(data);
const manifest={platform:'ps5',protocol:1,revision:106,sdk:'ps5-payload-dev/sdk v0.43',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),source:'receiver-ps5/main.c',features:['shadowmount-loopback-api','storage','app-info','launch','close','uninstall','patch-13.60','power','install-by-package','save-mount-13.60','save-restore-13.60']};
if(servicesDiagnostic)manifest.features=['service-ABI-diagnostic'];
if(diagnostic){manifest.source='receiver-ps5/diagnostic.c';manifest.features=['diagnostic-scratch-memory'];}
await writeFile(path.join(root,'build/'+(diagnostic?'diagnostic-manifest.json':servicesDiagnostic?'service-diagnostic-manifest.json':'manifest.json')),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest));
