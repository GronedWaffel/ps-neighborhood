import { readFile } from 'node:fs/promises';
import path from 'node:path';

function client(data) {
  return async (method, args = {}, timeout = 15000) => {
    const bridge = JSON.parse(await readFile(path.join(data, 'bridge.json'), 'utf8'));
    const url = new URL(bridge.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Expected the local PS Neighborhood bridge');
    const r = await fetch(new URL('/api/call', url), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bridge.token, 'X-PSN-Client': 'mcp' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(timeout) });
    const reply = await r.json(); if (reply.error) throw Error(reply.error); return reply.result;
  };
}

export async function gtaConnection(root, explicit = process.env.PSN_DATA) {
  if (explicit) return { data: explicit, call: client(explicit) };
  const candidates = [];
  for (const data of [path.join(root, 'data'), path.join(root, 'data/ps5')]) {
    const call = client(data);
    try { const s = await call('status', {}, 1200); if (s.mode === 'live' && s.profile?.platform === 'ps5') candidates.push({ data, call }); } catch {}
  }
  if (candidates.length !== 1) throw Error(candidates.length ? 'Two PS5 workspaces are connected. Close one, or choose its data folder using PSN_DATA.' : 'Open PS Neighborhood, connect to your PS5, then launch the GTA menu from the same installation.');
  return candidates[0];
}
