// Some console FTP servers accept LIST paths but silently list the current directory.
// Callers use a dedicated, serial connection and absolute paths for subsequent operations.
export async function listDirectory(client, remote) {
  if (typeof remote !== 'string' || !remote.startsWith('/') || /[\r\n\0]/.test(remote)) throw Error('Enter an absolute console path');
  await client.cd(remote);
  return client.list();
}
