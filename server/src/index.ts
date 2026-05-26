#!/usr/bin/env node

/**
 * tab-reader entry point.
 *
 * One binary, two modes selected by argv:
 *   - `--daemon`: the long-running daemon process started by launchd.
 *     Owns the WebSocket server on :17321, talks to the Chrome extension
 *     on `/`, accepts MCP-over-WebSocket bridge connections on `/mcp`,
 *     and serves a simple JSON status endpoint on GET /status.
 *   - default (no args): bridge mode. Spawned by Claude Desktop or
 *     Claude Code as the MCP server binary. Pipes Claude's stdio MCP
 *     traffic to/from the daemon's `/mcp` endpoint.
 *
 * The daemon and bridge intentionally live in separate modules so each
 * stays small and there is no chance of accidentally pulling daemon-only
 * dependencies (jsdom, turndown, the extraction pipeline) into the
 * lightweight bridge process.
 */

const isDaemon = process.argv.slice(2).includes("--daemon");

if (isDaemon) {
  const { runDaemon } = await import("./daemon.js");
  runDaemon();
} else {
  const { runBridge } = await import("./bridge.js");
  runBridge();
}
