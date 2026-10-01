import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { GTAStoryTrainer } from './gta-story-trainer.mjs';
import { GTANativeBridge } from './gta-native-bridge.mjs';
import { selectGTAProfile } from './gta-profiles.mjs';
import { gtaConnection } from './gta-connection.mjs';
import { GTAStoryActions, gtaCatalog } from './gta-story-actions.mjs';

export async function startGTAStoryTrainer() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = path.join(root, 'trainers/gta5-story');
  const { data, call } = await gtaConnection(root);
  const selected = await selectGTAProfile(call, directory);
  const trainer = new GTAStoryTrainer(call, selected.profile);
  const bridge = new GTANativeBridge(trainer, selected.directory, path.join(data, 'gta5-story'));
  const actions = new GTAStoryActions(trainer, bridge);
  const token = randomBytes(32).toString('hex');
  const toggles = {}; let busy = '', last = '';
  const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    try {
      const host = `127.0.0.1:${server.address().port}`, origin = `http://${host}`;
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Local trainer access only' });
      const url = new URL(req.url, origin);
      if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { token, catalog: gtaCatalog });
      if (url.pathname.startsWith('/api/')) {
        const provided = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || ''), expected = Buffer.from(token);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(res, 401, { error: 'Invalid trainer token' });
        if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, { ...await trainer.state(), toggles, busy, last });
        if (url.pathname === '/api/action' && req.method === 'POST') {
          if (busy) return json(res, 409, { error: `Wait for ${busy} to finish` });
          let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(res, 413, { error: 'Request too large' }); }
          const { action, input = {} } = JSON.parse(body);
          if (typeof action !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid action');
          busy = action;
          try {
            const result = await actions.apply(action, input);
            if (typeof input.value === 'boolean') toggles[action] = input.value;
            last = `${action} completed`;
            return json(res, 200, result);
          } finally { busy = ''; }
        }
        return json(res, 404, { error: 'Unknown operation' });
      }
      const file = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' }[url.pathname];
      if (!file || req.method !== 'GET') return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'text/css', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      res.end(await readFile(path.join(directory, file)));
    } catch (e) { json(res, 400, { error: e.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`, sessionFile = path.join(data, 'gta5-story', 'session.json');
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, JSON.stringify({ url, pid: process.pid }));
  return { url, close: async () => { server.close(); await actions.close(); await unlink(sessionFile).catch(() => {}); } };
}
