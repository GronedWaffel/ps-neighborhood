import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Trainer } from './trainer.mjs';
import { weaponCatalog, giveWeapon } from './trainer-weapons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function startTrainer() {
  const profilePath = path.join(root, 'trainers/bo2-zombies/profile.json');
  const mcp = new Client({ name: 'bo2-zombies-trainer', version: '0.1.0' });
  const data = process.env.PSN_DATA || path.join(root, 'data');
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp.mjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PSN_DATA: data } }));
  const call = async (name, args = {}) => {
    const result = await mcp.callTool({ name: 'psn_' + name, arguments: args });
    if (result.isError) throw new Error(result.content.map(c => c.text || '').join('\n'));
    return result.structuredContent.result;
  };
  const trainer = new Trainer(call, JSON.parse(await readFile(profilePath, 'utf8')));
  const token = randomBytes(32).toString('hex');
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    try {
      const host = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Local trainer access only' });
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { token });
      if (url.pathname.startsWith('/api/')) {
        const provided = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || ''), expected = Buffer.from(token);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(res, 401, { error: 'Invalid trainer token' });
        if (url.pathname === '/api/state' && req.method === 'GET') {
          trainer.profile = JSON.parse(await readFile(profilePath, 'utf8'));
          return json(res, 200, await trainer.read());
        }
        if (url.pathname === '/api/weapons' && req.method === 'GET') {
          const { ps, ...catalog } = await weaponCatalog(trainer, await trainer.target());
          return json(res, 200, catalog);
        }
        if (['/api/apply', '/api/freeze', '/api/weapon'].includes(url.pathname) && req.method === 'POST') {
          let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(res, 413, { error: 'Request too large' }); }
          const { field, value, active, weapon, upgrade } = JSON.parse(body);
          if (url.pathname === '/api/weapon') return json(res, 200, await giveWeapon(trainer, weapon, upgrade === true));
          return json(res, 200, url.pathname === '/api/freeze' ? await trainer.setFreeze(field, value, active === true) : await trainer.apply(field, value));
        }
        return json(res, 404, { error: 'Unknown operation' });
      }
      const file = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' }[url.pathname];
      if (!file || req.method !== 'GET') return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'text/css', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'Cache-Control': 'no-store' });
      res.end(await readFile(path.join(root, 'trainers/bo2-zombies', file)));
    } catch (e) { json(res, 400, { error: e.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => { server.close(); await trainer.close(); await mcp.close(); } };
}
