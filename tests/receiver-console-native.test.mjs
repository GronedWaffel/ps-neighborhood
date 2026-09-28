import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('compiled native receiver keeps launch/close/removal separate from shutdown/restart/rest',async t=>{
 const temp=await mkdtemp(path.join(tmpdir(),'psn-native-test-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const zig=process.env.ZIG||path.join(root,'tools/zig-x86_64-windows-0.14.1/zig.exe'),exe=path.join(temp,process.platform==='win32'?'dispatch.exe':'dispatch');
 const compile=spawnSync(zig,['cc','-std=gnu11','-I',path.join(root,'receiver'),path.join(root,'tests/receiver-console-native.c'),'-o',exe],{encoding:'utf8',env:{...process.env,ZIG_GLOBAL_CACHE_DIR:path.join(root,'receiver/build/zig-cache')}});
 assert.equal(compile.status,0,compile.error?.message||compile.stderr);
 const run=spawnSync(exe,[],{encoding:'utf8'});assert.equal(run.status,0,run.error?.message||run.stderr||run.stdout);
});
