import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
test('native ShadowMount bridge stays on loopback, rejects invalid routes, and bounds reads',async t=>{
 const temp=await mkdtemp(path.join(tmpdir(),'psn-shadow-native-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const root=path.resolve(import.meta.dirname,'..'),exe=path.join(temp,'test.exe');
 const c=spawnSync(path.join(root,'tools/zig-x86_64-windows-0.14.1/zig.exe'),['cc','-std=gnu11',path.join(root,'tests/shadowmount-native.c'),'-o',exe],{encoding:'utf8',env:{...process.env,ZIG_GLOBAL_CACHE_DIR:path.join(root,'receiver-ps5/build/zig-cache')}});assert.equal(c.status,0,c.stderr||c.error?.message);
 const r=spawnSync(exe,[],{encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);
});
