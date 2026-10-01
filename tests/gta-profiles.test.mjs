import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selectGTAProfile } from '../src/gta-profiles.mjs';
import { GTAStoryTrainer } from '../src/gta-story-trainer.mjs';

test('selects executable fingerprints, not title alone; never writes on selection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gta-profiles-'));
  const code = Buffer.from('12345678', 'hex');
  const fp = { address: '0x400000', length: 4, sha256: createHash('sha256').update(code).digest('hex') };
  const identity = { titleId: 'PPSA04264', contentId: 'test' };
  let reads = code;
  const call = async name => {
    if (name === 'processes') return [{ name: 'eboot.bin', pid: 10 }];
    if (name === 'process_info') return identity;
    if (name === 'memory_read') return { hex: reads.toString('hex') };
    throw Error('Unexpected operation: ' + name);
  };
  try {
    await mkdir(path.join(dir, 'current'));
    await writeFile(path.join(dir, 'profiles.json'), '[".","current"]');
    await writeFile(path.join(dir, 'profile.json'), JSON.stringify({ ...identity, fingerprints: [{ ...fp, sha256: '0'.repeat(64) }] }));
    await writeFile(path.join(dir, 'current/profile.json'), JSON.stringify({ ...identity, fingerprints: [fp] }));
    assert.equal((await selectGTAProfile(call, dir)).directory, path.join(dir, 'current'));
    reads = Buffer.alloc(4); await assert.rejects(selectGTAProfile(call, dir), /Unsupported GTA/);
    reads = code; identity.titleId = 'PPSA00000'; await assert.rejects(selectGTAProfile(call, dir), /Unsupported GTA/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('both shipped profiles retain their distinct player and mission layouts', async () => {
  const base = new URL('../trainers/gta5-story/', import.meta.url);
  const paths = JSON.parse(await readFile(new URL('profiles.json', base)));
  const offsets = [], images = [];
  for (const dir of paths) {
    const profile = JSON.parse(await readFile(new URL(dir + '/profile.json', base)));
    const trainer = new GTAStoryTrainer(() => {}, profile);
    offsets.push(trainer.field({ playerInfo: 0n }, 'run').address);
    const native = JSON.parse(await readFile(new URL(dir + '/native-addresses.json', base)));
    const header = await readFile(new URL(dir + '/build-profile.h', base), 'utf8');
    assert.ok(header.includes(profile.playerRoot));
    assert.ok(header.includes(profile.frameFlagsOffset));
    assert.equal(Object.keys(native).length, 114);
    const image = await readFile(new URL(dir + '/gta-bridge.bin', base));
    assert.equal(image.length, 0x20000); assert.ok(image.subarray(0x10000).every(v => !v));
    images.push(createHash('sha256').update(image).digest('hex'));
    assert.ok(profile.prologue.length > 600000);
  }
  assert.deepEqual(offsets, [0xcb0n, 0xd10n]);
  assert.notEqual(images[0], images[1]);
});
