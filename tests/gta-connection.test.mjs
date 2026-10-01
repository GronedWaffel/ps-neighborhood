import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gtaConnection } from '../src/gta-connection.mjs';

test('GTA finds the separate PS5 workspace and refuses ambiguous active consoles', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gta-connection-'));
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: { mode: 'live', profile: { platform: 'ps5' } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(path.join(root, 'data/ps5'), { recursive: true });
    const config = JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token: 'test' });
    await writeFile(path.join(root, 'data/ps5/bridge.json'), config);
    assert.equal((await gtaConnection(root, null)).data, path.join(root, 'data/ps5'));
    await writeFile(path.join(root, 'data/bridge.json'), config);
    await assert.rejects(gtaConnection(root, null), /Two PS5 workspaces/);
    assert.equal((await gtaConnection(root, path.join(root, 'data'))).data, path.join(root, 'data'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
