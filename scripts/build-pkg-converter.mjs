import {mkdir,cp,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url)),out=path.join(root,'converter/build');
const dotnet=process.env.PSN_DOTNET||'dotnet',zig=process.env.PSN_ZIG||path.join(root,'tools/zig-x86_64-windows-0.14.1/zig.exe');
function run(cmd,args){const r=spawnSync(cmd,args,{cwd:root,stdio:'inherit',windowsHide:true});if(r.error||r.status!==0)throw r.error||Error('Converter build failed: '+cmd);}
// Never mix old runtime/package dependencies into a new distributable.
try{const actual=await realpath(out);if(actual!==path.resolve(root,'converter/build'))throw Error('Unexpected converter build path');await rm(actual,{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir(out,{recursive:true});
run(zig,['c++','-target','x86_64-windows-gnu','-O2','-shared','-static','-msse4.1','converter/decoder.cpp','converter/vendor/ooz/kraken.cpp','converter/vendor/ooz/lzna.cpp','converter/vendor/ooz/bitknit.cpp','-o',path.join(out,'oo2core_9_win64.dll')]);
run(dotnet,['publish','converter/Neighborhood.Converter.csproj','-c','Release','-r','win-x64','--self-contained','true','-o',out]);
run(path.join(out,'Neighborhood.Converter.exe'),['selftest']);
await cp(path.join(root,'converter/NOTICE.md'),path.join(out,'NOTICE.md'));
const sdks=spawnSync(dotnet,['--list-sdks'],{encoding:'utf8',windowsHide:true});
const sdkPath=sdks.stdout?.match(/\[([^\]]+)\]/)?.[1];if(!sdkPath)throw Error('Cannot locate .NET license notices');
for(const name of ['LICENSE.txt','ThirdPartyNotices.txt'])await cp(path.join(path.dirname(sdkPath),name),path.join(out,'DOTNET-'+name));
for(const [src,dst] of [['vendor/PS5PKGTool-LICENSE','GPL-3.0.txt'],['vendor/PS5PKGTool/ThirdParty/ProsperoPkgTool/LICENSE','ProsperoPkgTool-LICENSE.txt'],['vendor/PS5PKGTool.Ufs2/LICENSE','UFS2-LICENSE.txt'],['vendor/ooz/COPYING','ooz-LICENSE.txt']])await cp(path.join(root,'converter',src),path.join(out,dst));
await writeFile(path.join(out,'build-manifest.json'),JSON.stringify({version:1,decoder:'ooz GPL-3.0-or-later (no proprietary Oodle DLL)',decoderSha256:createHash('sha256').update(await readFile(path.join(out,'oo2core_9_win64.dll'))).digest('hex')},null,2));
