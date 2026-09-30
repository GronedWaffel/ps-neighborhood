import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('PS5 native metadata and status fit the measured 13.60 marshaller boundaries',async t=>{
 const temp=await mkdtemp(path.join(tmpdir(),'psn-ps5-abi-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const zig=process.env.ZIG||path.join(root,'tools/zig-x86_64-windows-0.14.1/zig.exe'),exe=path.join(temp,process.platform==='win32'?'abi.exe':'abi');
 const compile=spawnSync(zig,['cc','-std=gnu11','-I',path.join(root,'receiver-ps5'),path.join(root,'tests/ps5-install-abi-native.c'),'-o',exe],{encoding:'utf8',env:{...process.env,ZIG_GLOBAL_CACHE_DIR:path.join(root,'receiver-ps5/build/zig-cache')}});
 assert.equal(compile.status,0,compile.error?.message||compile.stderr);
 const run=spawnSync(exe,[],{encoding:'utf8'});assert.equal(run.status,0,run.error?.message||run.stderr||run.stdout);
});
