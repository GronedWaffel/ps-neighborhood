import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Workbench } from './workbench.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function startServer({ port = Number(process.env.PSN_PORT || 0), directory = process.env.PSN_DATA || path.join(root, 'data') } = {}) {
  const workbench = await new Workbench(directory).init(), token = randomBytes(32).toString('hex');
  const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const expectedHost = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Local same-origin access only' });
      const url = new URL(req.url, `http://${expectedHost}`);
      if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { token });
      if (url.pathname === '/api/call' && req.method === 'POST') {
        const provided = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || ''); const expected = Buffer.from(token);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(res, 401, { error: 'Invalid local session token' });
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2 * 1048576) return json(res, 413, { error: 'Request too large' }); }
        const message = JSON.parse(body);
        if (typeof message.method !== 'string' || !message.args || typeof message.args !== 'object') return json(res, 400, { error: 'Expected method and args' });
        const source = req.headers['x-psn-client'] === 'mcp' ? 'mcp' : 'desktop';
        const result = await workbench.call(message.method, message.args, source); return json(res, 200, { result });
      }
      const files = { '/': 'index.html', '/app.js': 'app.js', '/conversion.js': 'conversion.js', '/style.css': 'style.css' };
      if (req.method !== 'GET' || !Object.hasOwn(files, url.pathname)) return json(res, 404, { error: 'Not found' });
      const file = files[url.pathname], mime = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'text/css';
      res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      res.end(await readFile(path.join(root, 'ui', file)));
    } catch (e) { json(res, 400, { error: e.message }); }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'bridge.json'), JSON.stringify({ url, token, pid: process.pid }, null, 2));
  return { server, workbench, url, directory, close: async () => { await workbench.conversion.close(); await workbench.shadow.close(); await workbench.console.close(); await workbench.packages.close(); await workbench.packages.receiver.close(); await workbench.ps5Receiver.close(); await workbench.disconnect(); server.close(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startServer(); console.log(`PS Neighborhood: ${app.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
