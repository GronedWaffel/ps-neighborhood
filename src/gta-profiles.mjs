import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Title IDs alone do not identify native addresses. Match the executable too.
export async function selectGTAProfile(call, directory) {
  const processes = (await call('processes')).filter(p => p.name === 'eboot.bin');
  if (processes.length !== 1) throw Error('A single running GTA V process is required');
  const pid = processes[0].pid, info = await call('process_info', { pid });
  const entries = JSON.parse(await readFile(path.join(directory, 'profiles.json'), 'utf8'));
  for (const entry of entries) {
    const assets = path.resolve(directory, entry);
    if (assets !== path.resolve(directory) && !assets.startsWith(path.resolve(directory) + path.sep)) throw Error('Invalid GTA profile path');
    const profile = JSON.parse(await readFile(path.join(assets, 'profile.json'), 'utf8'));
    if (profile.titleId !== info.titleId || profile.contentId !== info.contentId) continue;
    let matches = true;
    for (const f of profile.fingerprints) {
      const bytes = Buffer.from((await call('memory_read', { pid, address: f.address, length: f.length })).hex, 'hex');
      if (bytes.length !== f.length || createHash('sha256').update(bytes).digest('hex') !== f.sha256) { matches = false; break; }
    }
    if (matches && profile.fingerprints.length) return { profile, directory: assets };
  }
  throw Error(`Unsupported GTA V executable (${info.titleId}); no memory was changed`);
}
