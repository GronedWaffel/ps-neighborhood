import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.env.PSN_DATA || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const pid = z.number().int().min(1).max(0xffffffff), addr = z.string().regex(/^(0x[\da-f]+|\d+)$/i), length = z.number().int().min(1).max(1048576);
const numericType = z.enum(['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64']);
const readShape = { pid: pid.optional(), address: addr, length: length.optional(), dumpId: z.string().optional() };
const tools = [
  ['shadow_status','Read the ShadowMount connection, game library, available transfer destinations and persistent transfer queue/progress. Transfers and game controls are started in the desktop ShadowMount page.',{}],
  ['shadow_refresh','Read ShadowMount version, games, configured scan roots and drive space. Uses the loaded PS5 companion to reach its local API without exposing it to the LAN.',{port:z.number().int().min(1).max(65535).optional()}],
  ['shadow_inspect','Inspect a local PS5 dump folder or supported ShadowMount image, returning title metadata, byte/file counts and a source fingerprint without uploading it.',{local:z.string()}],
  ['shadow_add','Add a local PS5 dump folder or image to the transfer queue; no console files are changed. Start the queue from the desktop ShadowMount page.',{local:z.string()}],
  ['console_status', 'Read detected firmware and compatibility, console drive capacity, installed games, separate update/DLC sizes, registered add-ons, cached bundled-content evidence, saves, scan and backup progress. Refresh first for current data.', {}],
  ['console_refresh', 'Start a read-only FTP console inventory and storage scan. Poll console_status until its job completes. Capacity needs the background receiver.', {}],
  ['console_backup', 'Download encrypted save containers and metadata with SHA-256 manifests. Set decrypted=true for a PS5 save to retain an encrypted backup and export decrypted files from a staged copy through the PS5 13.60 companion. The target game must be closed. Poll console_status. Restoring edited files requires desktop confirmation.', {id:z.string(),decrypted:z.boolean().optional()}],
  ['pkg_inspect', 'Validate a local PS4 CNT or PS5 FIH/CNT package for the selected platform and read its content ID, type and size without copying it. Header/bounds validation does not prove full content integrity.', { local: z.string() }],
  ['pkg_check', 'Check the loaded PS Neighbourhood background receiver install services, or the optional Remote Package Installer API. No install is started.', { mode: z.enum(['background','remote']).optional(), installerPort: z.number().int().min(1).max(65535).optional() }],
  ['pkg_status', 'Read package serving and installation progress. Start installs in the desktop PKG installer.', { refresh: z.boolean().optional() }],
  ['status', 'Get connection, scan, dump, transfer, and activity status.', {}],
  ['connect', 'Connect using the saved console profile, or explicitly open the simulated memory lab. Resets scan sessions.', { demo: z.boolean().optional() }],
  ['disconnect', 'Disconnect and cancel current scan/dump jobs.', {}],
  ['probe', 'Check debugger and FTP availability. The payload loader is intentionally not probed.', {}],
  ['processes', 'List userland processes through the selected PS4Debug or PS5Debug service.', {}],
  ['process_info', 'Get process identity, title ID, content ID and executable path.', { pid }],
  ['maps', 'List mapped memory with original 64-bit addresses, offsets, and RWX permissions.', { pid }],
  ['memory_read', 'Read up to 1 MiB of live memory or an offline dump. Addresses are strings to preserve 64-bit precision.', readShape],
  ['memory_readv', 'Batch 1–128 ranges with a combined 1 MiB limit; ordered, sequential reads.', { pid, ranges: z.array(z.object({ address: addr, length })).min(1).max(128) }],
  ['memory_inspect', 'Decode named typed fields at offsets from a structure base in live or dumped memory.', { pid: pid.optional(), address: addr, dumpId: z.string().optional(), fields: z.array(z.object({ name: z.string(), offset: z.number().int().min(0).max(65528), type: numericType })).min(1).max(64) }],
  ['memory_strings', 'Extract printable ASCII or UTF-16LE ASCII-range strings from a bounded live or offline memory region.', { ...readShape, minLength: z.number().int().min(2).max(128).optional(), encoding: z.enum(['ascii', 'utf16le']).optional() }],
  ['pointer_resolve', 'Resolve a 64-bit little-endian chain: for each offset, address = read_u64(address) + offset. Returns every hop.', { pid: pid.optional(), base: addr, offsets: z.array(z.string()).max(16), dumpId: z.string().optional() }],
  ['pointer_search', 'Reverse-search an offline RAM capture for multi-level pointer chains to a target. Up to depth 5 with bounded intermediate paths. Positive offsets. Poll pointer_status then pointer_results. Revalidate candidates across captures; roots are not guaranteed stable.', { dumpId: z.string(), target: addr, maxDepth: z.number().int().min(1).max(5).optional(), maxOffset: z.number().int().min(0).max(1048576).optional(), maxResults: z.number().int().min(1).max(50000).optional(), alignment: z.number().int().min(1).max(8).optional(), moduleName: z.string().optional() }],
  ['pointer_status', 'Get offline pointer search progress and truncation status.', {}],
  ['pointer_results', 'Page candidate pointer chains with roots, offsets and module-relative positions.', { offset: z.number().int().min(0).max(50000).optional(), limit: z.number().int().min(1).max(1000).optional() }],
  ['pointer_cancel', 'Cancel an offline pointer search.', {}],
  ['memory_write', 'Write at most 4096 bytes only if expected bytes still match; verify by reading back. Requires desktop MCP write toggle. This is not atomic against the running game.', { pid, address: addr, expectedHex: z.string(), hex: z.string() }],
  ['scan_start', 'Start a cancellable disk-backed scan or refine an existing session. Can scan an offline dump with dumpId. Backend auto uses detected NG for naturally aligned integers and host scanning otherwise. PS5Debug-NG 1.3.2 supports native integer scanning; other versions use host scanning. AOB values require space-separated pairs or wildcards, e.g. 48 8B ?? A?. ng requires compatible NG; refinement may use bounded host tail reads. Status reports actual backend and reason. Default selects writable readable mappings, capped at 512 MiB. Poll scan_status, then scan_results.', { pid: pid.optional(), dumpId: z.string().optional(), sessionId: z.string().optional(), backend: z.enum(['auto', 'host', 'ng']).optional(), type: z.enum(['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64', 'aob', 'text']).optional(), mode: z.enum(['exact', 'unknown', 'greater', 'less', 'between', 'changed', 'unchanged', 'increased', 'decreased']), value: z.string().optional(), value2: z.string().optional(), epsilon: z.number().nonnegative().optional(), start: addr.optional(), end: addr.optional(), alignment: z.number().int().min(1).max(64).optional(), writableOnly: z.boolean().optional() }],
  ['scan_status', 'Get scan job progress, errors, match count and completed session ID.', {}],
  ['scan_cancel', 'Cancel the current scan without replacing the last completed result set.', {}],
  ['scan_results', 'Page through full scan candidates. Values are captured at the last scan pass, not a live watch.', { sessionId: z.string(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(1000).optional() }],
  ['dump_start', 'Stream mapped RAM regions or a start/end range to a Ghidra-ready bundle: raw .bin files, address/permission manifest, SHA-256 and per-page hashes, and Java importer. Up to 4 GiB; sequential live capture, not atomic. Gaps are omitted. Poll dump_status for local output paths.', { pid, regionStarts: z.array(addr).optional(), start: addr.optional(), end: addr.optional() }],
  ['dump_status', 'Get dump progress, completion, output folder and manifest path.', {}],
  ['dump_cancel', 'Cancel export; incomplete bundles are explicitly marked and never listed as complete.', {}],
  ['dump_list', 'List completed local memory bundles available for offline analysis.', {}],
  ['dump_manifest', 'Read original memory map, SHA-256 hashes, addresses, permissions and capture metadata.', { id: z.string() }],
  ['dump_compare', 'Compare two captures by absolute virtual addresses and 4 KiB page hashes. Reports changed, added and removed pages. ASLR is not normalized.', { before: z.string(), after: z.string(), limit: z.number().int().min(1).max(10000).optional() }],
  ['watch_add', 'Save a typed watch with region-relative offset metadata. Absolute addresses must be revalidated after restarting a game.', { pid, address: addr, type: numericType, label: z.string().optional() }],
  ['watch_list', 'List saved watch definitions.', {}],
  ['watch_read', 'Read all saved watches; reports stale or inaccessible entries individually.', {}],
  ['watch_remove', 'Remove a saved watch definition.', { id: z.string() }],
  ['ftp_list', 'List a console directory through FTP.', { remote: z.string().optional() }],
  ['ftp_download', 'Download a console file to the local workspace downloads folder.', { remote: z.string() }]
];
export async function bridgeCall(method, args) {
  let bridge;
  try { bridge = JSON.parse(await readFile(path.join(directory, 'bridge.json'), 'utf8')); } catch { throw new Error('Open PS Neighbourhood first, or set PSN_DATA to its data folder.'); }
  const url = new URL(bridge.url); if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Bridge must be on IPv4 loopback');
  const response = await fetch(url + 'api/call', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bridge.token}`, 'X-PSN-Client': 'mcp' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(120000) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error); return data.result;
}
export function createMcp(call = bridgeCall) {
  const server = new McpServer({ name: 'ps-neighbourhood', version: '0.10.0' });
  for (const [name, description, shape] of tools) {
    const mutation = ['shadow_add','shadow_refresh','console_refresh','console_backup','connect', 'disconnect', 'memory_write', 'watch_add', 'watch_remove', 'scan_start', 'scan_cancel', 'dump_start', 'dump_cancel', 'pointer_search', 'pointer_cancel', 'ftp_download'].includes(name);
    server.registerTool('psn_' + name, { description, inputSchema: z.object(shape), annotations: { readOnlyHint: !mutation, destructiveHint: name === 'memory_write' || name === 'disconnect', openWorldHint: true } }, async args => {
      try { const result = await call(name, args); return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } }; }
      catch (e) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
    });
  }
  for (const [name, uri, method] of [['workspace', 'psn://workspace', 'status'], ['dumps', 'psn://dumps', 'dump_list'], ['watches', 'psn://watches', 'watch_list']]) {
    server.registerResource(name, uri, { mimeType: 'application/json', description: `PS Neighbourhood ${name}` }, async url => ({ contents: [{ uri: url.href, mimeType: 'application/json', text: JSON.stringify(await call(method, {})) }] }));
  }
  server.registerPrompt('offline-trainer-research', { description: 'A reproducible workflow for analyzing your own offline game memory.' }, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Inspect PS Neighbourhood status and processes, then identify the target process and memory maps. Ask which value or behavior I want to investigate. Start with read-only scans, refine against controlled changes, record module-relative offsets and title/version identity. Export selected mapped regions using psn_dump_start for Ghidra, poll completion, and report manifest and importer paths. Use dump reads, structure inspection, string extraction and pointer chains for offline analysis. Do not treat sequential live captures as atomic or absolute addresses as stable across launches. Propose any writes with expected bytes before applying them.' } }] }));
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await createMcp().connect(new StdioServerTransport());
