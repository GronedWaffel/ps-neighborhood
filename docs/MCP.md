# MCP setup

The server uses the official MCP TypeScript SDK and stdio transport. It is part of the app; no Python environment or `psn.mcp_server` module is needed.

## Recommended configuration

1. Start PS Neighbourhood and open **MCP bridge**.
2. Copy its generated configuration into your client's MCP server configuration (for example, Cursor's `mcpServers` configuration).
3. Restart/reconnect the MCP server in the client and request `psn_status`.
4. Keep PS Neighbourhood open while using its tools. Choose the memory lab explicitly or connect to your console.

The generated configuration uses absolute paths and the runtime included with a portable build. Avoid copying configuration from an older installation, because its data directory and bridge credential may differ.

For a source checkout with Node.js installed, adapt this example:

```json
{
  "mcpServers": {
    "ps-neighbourhood": {
      "command": "node",
      "args": ["C:/path/to/ps-neighbourhood/src/mcp.mjs"],
      "env": {
        "PSN_DATA": "C:/path/to/ps-neighbourhood/data"
      }
    }
  }
}
```

If your MCP client cannot find `node`, use its absolute executable path. In the portable configuration, the command is `PS Neighbourhood.exe`, with `ELECTRON_RUN_AS_NODE=1`; use the exact configuration produced by the app. The server reserves stdout for MCP messages.

## Permissions and boundaries

MCP memory writes start disabled. Enable **Allow MCP compare-and-write** in the desktop only when you want a client to modify memory. Writes require expected bytes and a verified read-back; they are not atomic against a running game. Turning the switch off stops subsequent trainer/MCP writes.

The bridge listens locally and authenticates requests using a credential in the app's data directory. Do not commit or share `bridge.json`. MCP clients can access the configured console and permitted local workflows; keep them trusted.

Installation submission, payload loading, game removal and power actions are desktop-only. There is no remote shell or generic native-call endpoint. The MCP server itself requires no cloud account or API key; an AI client may have separate requirements.

## Available tools

All tool names use the `psn_` prefix. The client can discover exact argument schemas with MCP `tools/list`.

- **Session:** `status`, `connect`, `disconnect`, `probe`.
- **Processes:** `processes`, `process_info`, `maps`.
- **Memory:** `memory_read`, `memory_readv`, `memory_inspect`, `memory_strings`, `memory_write`.
- **Scanning:** `scan_start`, `scan_status`, `scan_cancel`, `scan_results`.
- **RAM bundles:** `dump_start`, `dump_status`, `dump_cancel`, `dump_list`, `dump_manifest`, `dump_compare`.
- **Pointers:** `pointer_resolve`, `pointer_search`, `pointer_status`, `pointer_results`, `pointer_cancel`.
- **Watches:** `watch_add`, `watch_list`, `watch_read`, `watch_remove`.
- **FTP:** `ftp_list`, `ftp_download`.
- **Packages:** `pkg_inspect`, `pkg_check`, `pkg_status`.
- **Console:** `console_status`, `console_refresh`, `console_backup`.

## Limits and workflow

Addresses are strings to preserve 64-bit precision. Individual reads are capped at 1 MiB; vector reads allow 1–128 ranges with a combined 1 MiB limit and execute sequentially. Writes are capped at 4096 bytes. Scan selections are capped at 512 MiB; RAM captures allow up to 4 GiB. Pointer search is offline, up to five levels, and reports truncated results.

Start a scan or dump, poll its status, then request paged results or the completed manifest. `scan_results` contains values from the last scan pass, not a live watch. Use `watch_read` for fresh observations. Cancel long jobs through their cancel tool.

For Ghidra work, enumerate mappings, capture selected regions, wait for completion and inspect the manifest before importing. Use `dumpId` with supported memory/scan tools to work offline. Captures are sequential and comparisons use absolute addresses; ASLR is not normalized automatically.

## Troubleshooting

- **No module named psn:** remove the obsolete Python command and use `src/mcp.mjs` with Node or the generated Electron configuration.
- **Open PS Neighbourhood first:** start the main app and ensure `PSN_DATA` points to its actual data directory.
- **Write denied:** enable the desktop write switch and verify that you are connected to the intended console.
- **Connection closed:** verify executable/script paths and the runtime, then inspect the MCP client's stderr log.
- **Console unavailable:** verify its address, network route and existing PS4Debug service. Do not blindly reload PS4Debug over a running copy.
