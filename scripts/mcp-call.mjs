// Local CLI client for the same stdio MCP server used by assistants.
// Pass one {method,args} or an array on stdin; PSN_DATA selects the open app.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

const calls = JSON.parse(await readFile(0, 'utf8').catch(async () => {
  let input = ''; for await (const chunk of process.stdin) input += chunk; return input;
}));
const client = new Client({ name: 'psn-research-client', version: '0.2.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))], env: { ...process.env } }));
  for (const call of Array.isArray(calls) ? calls : [calls]) {
    if (call.method === 'list_tools') { console.log(JSON.stringify((await client.listTools()).tools.map(t => t.name))); continue; }
    if (call.method === 'wait_scan') {
      const deadline = Date.now() + 300000;
      while (true) {
        const reply = await client.callTool({ name: 'psn_scan_status', arguments: {} });
        if (reply.isError) throw new Error(JSON.stringify(reply.content));
        const job = reply.structuredContent.result;
        if (job?.state !== 'running') {
          if (call.output) await writeFile(call.output, JSON.stringify(job, null, 2));
          console.log(JSON.stringify({ method: call.method, result: job }));
          if (job?.state !== 'complete') throw new Error(job?.error || 'Scan did not complete');
          break;
        }
        if (Date.now() > deadline) throw new Error('Still scanning; use scan_status to continue monitoring');
        await new Promise(r => setTimeout(r, 1000));
      }
      continue;
    }
    const reply = await client.callTool({ name: 'psn_' + call.method, arguments: call.args ?? {} }, undefined, { timeout: 120000 });
    if (reply.isError) throw new Error(reply.content.map(c => c.text || '').join('\n'));
    const result = reply.structuredContent?.result;
    if (call.output) await writeFile(call.output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ method: call.method, result: call.output ? { saved: call.output, count: Array.isArray(result) ? result.length : undefined } : result }));
  }
} finally { await client.close(); }
