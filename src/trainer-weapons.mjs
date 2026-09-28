import { address, hex } from './protocol.mjs';

// CUSA57548: BG_GetWeaponVariantDef @ A43B00; inventory insertion @ A3BCE0.
// Discover the current map's registry each time; IDs and asset addresses are not persistent.
export async function weaponCatalog(trainer, target) {
  const table = target.base + 0x3700730n;
  const pointers = await trainer.bytes(target.pid, table, 256 * 8);
  const entries = [];
  for (let id = 1; id < 256; id++) {
    const ptr = pointers.readBigUInt64LE(id * 8);
    if (ptr && target.maps.some(m => (m.prot & 1) && ptr >= address(m.start) && ptr + 0x298n <= address(m.end))) entries.push({ id, address: hex(ptr), length: 0x298 });
  }
  const readv = async ranges => {
    const out = [];
    for (let i = 0; i < ranges.length; i += 120) out.push(...await trainer.call('memory_readv', { pid: target.pid, ranges: ranges.slice(i, i + 120) }));
    return out.map(r => Buffer.from(r.hex, 'hex'));
  };
  const objects = await readv(entries.map(({id, ...r}) => r));
  const readable = (at, length) => target.maps.some(m => (m.prot & 1) && at >= address(m.start) && at + BigInt(length) <= address(m.end));
  const candidates = objects.map((b,i) => ({ id: entries[i].id, object: b, namePointer: b.readBigUInt64LE(), definition: b.readBigUInt64LE(16) })).filter(w => readable(w.namePointer, 96) && readable(w.definition, 0x90));
  const names = await readv(candidates.map(w => ({ address: hex(w.namePointer), length: 96 })));
  const defs = await readv(candidates.map(w => ({ address: hex(w.definition), length: 0x90 })));
  if (!(await trainer.bytes(target.pid, table, pointers.length)).equals(pointers)) throw Error('Weapon registry changed; retry after the map finishes loading');
  const all = candidates.map((w,i) => ({ id: w.id, name: names[i].toString('utf8').split('\0')[0], definition: hex(w.definition), clip: w.object.readInt32LE(0x214), alt: w.object.readInt32LE(8), dual: !!w.object[0x291], type: defs[i].readInt32LE(0x38), category: defs[i].readInt32LE(0x44), inventoryType: defs[i].readInt32LE(0x7c) }));
  // Unloaded weapon names can point at one shared placeholder asset. Exclude these.
  const counts = new Map(); for (const w of all) counts.set(w.definition, (counts.get(w.definition) || 0) + 1);
  const weapons = all.filter(w => /^[a-z0-9_]+_zm$/.test(w.name) && counts.get(w.definition) === 1 && w.inventoryType === 0 && w.category === 0 && [0,1,2,3,4,5,6,13].includes(w.type) && w.alt === 0 && !w.dual && w.clip > 0 && w.clip <= 250);
  const ps = await trainer.bytes(target.pid, address(target.player), 0x468);
  const heldId = ps.readUInt32LE(0x1b8);
  const inventory = Array.from({ length: 15 }, (_, slot) => {
    const id = ps.readUInt32LE(0x248 + slot * 28), definition = all.find(w => w.id === (id & 255));
    // GetWeaponsListPrimaries @ 624220 filters definition +44 == 0, then alternate forms.
    // Count unknown/attachment forms conservatively; only replace a supported plain primary.
    return { slot, id, name: definition?.name, primary: !definition || definition.category === 0, replaceable: weapons.some(w => w.id === id), clip: ps.readUInt32LE(0x428 + slot * 4) };
  }).filter(w => w.id);
  return { weapons, heldId, held: all.find(w => w.id === (heldId & 255))?.name, inventory, primaryCount: inventory.filter(w => w.primary).length, primaryLimit: 2, ps };
}

export async function giveWeapon(trainer, name, upgrade = false) {
  return trainer.enqueue(async () => {
    const t = await trainer.target();
    if (!t.status.mcpWrites) throw Error('Enable Allow MCP compare-and-write first');
    if (t.status.scan?.state === 'running' || t.status.dump?.state === 'running') throw Error('Finish the scan or dump first');
    if (trainer.freeze.active) throw Error('Stop clip freeze before changing weapons');
    const c = await weaponCatalog(trainer, t);
    if (upgrade) {
      if (!c.held || c.held.includes('_upgraded_')) throw Error('Hold a non-upgraded weapon first');
      name = c.held.replace(/_zm$/, '_upgraded_zm');
    }
    const weapon = c.weapons.find(w => w.name === name);
    if (!weapon) throw Error('This map has no supported loaded asset for that weapon');
    if (c.inventory.some(w => w.id === weapon.id)) throw Error('That weapon is already in your inventory');
    const primaries = c.inventory.filter(w => w.primary);
    if (primaries.length > 2) throw Error('Inventory already exceeds the supported two-primary limit; let the weapon-reset sequence finish first');
    const replaced = primaries.find(w => w.id === c.heldId && w.replaceable);
    if (!replaced) throw Error('Hold the supported primary weapon you want to replace, then retry');
    const slot = replaced.slot;
    const player = address(t.player), record = Buffer.alloc(28); record.writeUInt32LE(weapon.id);
    const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const writes = [
      { offset: 0x3ec + slot * 4, data: u32(weapon.clip * 5) },
      { offset: 0x428 + slot * 4, data: u32(weapon.clip) },
      { offset: 0x248 + slot * 28, data: record },
      { offset: 0x1b8, data: u32(weapon.id), select: true }
    ];
    // Initialize ammo, publish the replacement in the same slot, then update the held ID.
    const completed = [];
    try {
      for (const w of writes) {
        const currentTarget = await trainer.target({ allowUnequipped: true });
        if (currentTarget.pid !== t.pid || currentTarget.player !== t.player || currentTarget.status.connectionId !== t.status.connectionId || currentTarget.commandTime < t.commandTime) throw Error('Match changed during inventory update');
        const live = await trainer.bytes(t.pid, player, 0x468);
        const allowedHeld = w.select ? [c.heldId, 0, weapon.id] : [c.heldId];
        if (!allowedHeld.includes(live.readUInt32LE(0x1b8)) || Array.from({ length: 15 }, (_, i) => i).some(i => live.readUInt32LE(0x248 + i * 28) !== (w.select && i === slot ? weapon.id : c.ps.readUInt32LE(0x248 + i * 28)))) throw Error('Inventory or equipped weapon changed; retry without switching or buying weapons');
        const expected = w.select ? live.subarray(w.offset, w.offset + w.data.length) : c.ps.subarray(w.offset, w.offset + w.data.length);
        const at = hex(player + BigInt(w.offset));
        const result = await trainer.call('memory_write', { pid: t.pid, address: at, expectedHex: expected.toString('hex'), hex: w.data.toString('hex') });
        if (!result.verified) throw Error('Inventory write verification failed');
        completed.push({ at, expected, data: w.data });
      }
    } catch (e) {
      for (const w of completed.reverse()) {
        try { await trainer.call('memory_write', { pid: t.pid, address: w.at, expectedHex: w.data.toString('hex'), hex: w.expected.toString('hex') }); }
        catch { e.message += '; partial inventory change remains'; }
      }
      throw e;
    }
    // The Zombies weapon-limit monitor runs every three seconds. Immediate byte verification
    // alone missed its delayed removal; observe at least one interval before reporting retention.
    await new Promise(resolve => setTimeout(resolve, trainer.weaponVerifyDelay ?? 3500));
    const afterTarget = await trainer.target({ allowUnequipped: true });
    if (afterTarget.pid !== t.pid || afterTarget.player !== t.player || afterTarget.status.connectionId !== t.status.connectionId || afterTarget.commandTime < t.commandTime) throw Error('Match changed after weapon update; retention could not be verified');
    const retained = (await trainer.bytes(t.pid, player + BigInt(0x248 + slot * 28))).readUInt32LE() === weapon.id;
    if (!retained) throw Error('The game removed or replaced the weapon after insertion; it was not retained');
    const equipped = (await trainer.bytes(t.pid, player + 0x1b8n)).readUInt32LE() === weapon.id;
    return { weapon: weapon.name, replaced: replaced.name, slot, clip: weapon.clip, verified: true, retained: true, equipped, gameplayObserved: afterTarget.commandTime - t.commandTime >= 3000, message: 'Replaced the weapon you were holding. Your holstered weapon was preserved.' };
  });
}
