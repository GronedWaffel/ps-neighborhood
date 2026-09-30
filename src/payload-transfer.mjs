import net from 'node:net';
import {pipeline} from 'node:stream/promises';

export async function transferPayload(data, {host, port, timeoutMs = 10000}) {
  const socket = net.createConnection({host, port});
  // Keep an error sink for the socket's entire lifetime. A delayed socket event
  // must not become an uncaught Electron exception after pipeline settles.
  socket.on('error', () => {});
  const onTimeout = () => socket.destroy(new Error('ELF transfer timed out'));
  socket.setTimeout(timeoutMs, onTimeout);
  try {
    await pipeline([data], socket);
  } finally {
    socket.setTimeout(0);
    socket.removeListener('timeout', onTimeout);
    socket.destroy();
  }
}
