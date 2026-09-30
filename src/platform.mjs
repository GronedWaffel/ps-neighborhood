export const PS5_STORAGE_PATHS = ['/user','/mnt/ext0','/mnt/ext1','/user2',...Array.from({length:6},(_,i)=>'/mnt/ext'+(i+2)),...Array.from({length:8},(_,i)=>'/mnt/usb'+i)];

export function consolePlatform(value = 'ps4') {
  if (!['ps4', 'ps5'].includes(value)) throw new Error('Console platform must be ps4 or ps5');
  return value;
}

export function platformFeatures(platform = 'ps4') {
  const ps5 = consolePlatform(platform) === 'ps5';
  return {
    platform, label: ps5 ? 'PS5' : 'PS4', debugger: ps5 ? 'PS5Debug' : 'PS4Debug',
    payloadFormat: ps5 ? 'elf' : 'bin', memory: true, ftp: true,
    consoleInventory: true, nativeReceiver: true, storage: true, packageInstall: true,
    saveBackup: true, gameControls: true, powerControls: true,
    note: ps5 ? 'PS5: FTP, ELF loading, PS5Debug memory tools, library/save inventory and encrypted save archives. The PS5 companion supplies storage, native package streaming and available game/power controls. PS4 and PS5 PKG installs and rest mode passed on 13.60. Native pause/resume, the update/DLC queue and test-content removal/reinstall passed. Restart passed; shutdown was tested successfully by the user; the PS4-specific BO2 trainer needs a separate PS5 profile.' : 'PS4 background receiver and PS4Debug workflows.'
  };
}

// Validate a userland ELF before opening the loader connection. A .bin renamed
// to .elf is still rejected; firmware compatibility must be checked separately.
export function validatePS5Elf(data) {
  if (data.length < 64 || !data.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70]))) throw new Error('PS5 ELF Loader requires an ELF file, not a PS4 .bin payload');
  if (data[4] !== 2 || data[5] !== 1 || data[6] !== 1 || data.readUInt16LE(18) !== 62) throw new Error('PS5 payload must be a 64-bit little-endian x86-64 ELF');
  if (![2, 3].includes(data.readUInt16LE(16))) throw new Error('PS5 loader requires an executable or shared-object ELF');
  const offset = data.readBigUInt64LE(32), size = data.readUInt16LE(54), count = data.readUInt16LE(56);
  if (data.readUInt16LE(52) !== 64 || size < 56 || count < 1 || count > 256 || offset < 64n || offset + BigInt(size * count) > BigInt(data.length)) throw new Error('Invalid ELF program-header table');
  let loads = 0;
  for (let i = 0; i < count; i++) {
    const at = Number(offset) + i * size;
    if (data.readUInt32LE(at) !== 1) continue;
    const start = data.readBigUInt64LE(at + 8), address = data.readBigUInt64LE(at + 16), bytes = data.readBigUInt64LE(at + 32), memory = data.readBigUInt64LE(at + 40);
    if (bytes > memory || start + bytes > BigInt(data.length) || address + memory > 0x10000000000000000n) throw new Error('ELF load segment is outside the file or address space');
    loads++;
  }
  if (!loads) throw new Error('ELF has no loadable segments');
  return { format: 'ELF64', architecture: 'x86-64', segments: loads };
}
