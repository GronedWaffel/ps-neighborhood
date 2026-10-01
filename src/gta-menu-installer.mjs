import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { GTAStoryTrainer } from './gta-story-trainer.mjs';
import { GTANativeBridge } from './gta-native-bridge.mjs';
import { selectGTAProfile } from './gta-profiles.mjs';
import { gtaConnection } from './gta-connection.mjs';

export async function installGTAInGameMenu({ data, neverWanted = false } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = path.join(root, 'trainers/gta5-story');
  const connection = await gtaConnection(root, data);
  data = connection.data;
  const call = connection.call;
  const selected = await selectGTAProfile(call, directory);
  const trainer = new GTAStoryTrainer(call, selected.profile);
  const bridge = new GTANativeBridge(trainer, selected.directory, path.join(data, 'gta5-story'));
  // Attach only once; installMenu can adopt the exact existing resident build.
  await bridge.ensure();
  if (neverWanted) await bridge.setFrameFlag(64, true);
  const result = await bridge.installMenu();
  const before = (await bridge.read(bridge.session.base + 0x10600n, 12)).readUInt32LE();
  await new Promise(resolve => setTimeout(resolve, 1000));
  const status = await bridge.read(bridge.session.base + 0x10600n, 12);
  await bridge.close(); // Resident ownership deliberately survives the installer.
  return { ...result, framesAdvancing: status.readUInt32LE() > before, frames: status.readUInt32LE(), renderedFrames: status.readUInt32LE(4), menuOpen: !!status.readUInt32LE(8) };
}
