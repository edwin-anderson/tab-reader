# Handover — Multi-Client Support for tab-reader

**Status:** Research complete. No code written. Next session decides the implementation.

**Audience:** A future Claude Code session picking this up to design and implement a fix.

---

## TL;DR of the problem

`tab-reader` works perfectly when exactly one Claude app (Desktop **or** Code) is running. When both are running simultaneously, the second app's tools appear connected in `/mcp` but fail with "extension not connected" when called.

Root cause: the server is structured so that **a single Node process owns both** (a) the MCP stdio channel to one Claude app, and (b) the WebSocket server on `:17321` that the Chrome extension dials into. When each Claude app spawns its own copy of `server/build/index.js`, only the first one wins the port. The second process is alive on stdio but its WebSocket server failed to bind silently (`EADDRINUSE`), so it has no extension to talk to — yet Claude still routes tool calls to it.

This was confirmed empirically on the user's Mac:

```
$ ps aux | grep tab-reader/server/build/index.js
edwin  22383  …  /Applications/Claude.app/Contents/Helpers/disclaimer node …/index.js  ← Claude Desktop, owns :17321
edwin  72621  …                                                       node …/index.js  ← Claude Code, port-bind failed

$ lsof -i :17321
node 22383  …  LISTEN          ← only one process listening
Google 2028  …  ESTABLISHED    ← extension connected to PID 22383
node 22383  …  ESTABLISHED
```

So Claude Code's tab-reader hits PID 72621, which has `extensionConnected = false` in its memory, and returns the failure path the user saw.

---

## What's already been ruled out (so don't re-explore these)

- **Removing tab-reader from one of the two apps.** The user explicitly rejected this. They want both apps to work simultaneously.
- **Multi-port fallback** (second process picks `:17322` etc.). Doesn't help — the Chrome extension hardcodes `:17321` and even if made configurable would only connect to one port.
- **File-lock + "outbound-only" fallback** (the pattern from `anthropics/claude-code#40220` for Telegram bots). Doesn't apply: Telegram has useful tools that don't require the polled channel; tab-reader's tools all require the extension. There's no useful "degraded mode."
- **`get_current_tab`/`fetch_current_tab` failing silently.** The error handling in `server/src/index.ts` is already correct — the problem is purely architectural, not a bug in the tool handlers.

---

## What the prior research found

The shape of the problem is a well-known class in the MCP ecosystem. Several MCP servers in the same category as tab-reader have solved it. The dominant pattern in production is the **stdio↔WebSocket bridge**: a single shared "server" process owns the singleton resource (port, polling channel, etc.) and every MCP client connects via a thin bridge that proxies stdio JSON-RPC to/from that server over a localhost socket.

The closest precedent is **Kapture** — a Chrome DevTools Extension + WebSocket + MCP server for browser automation. Its architecture is described as:

```
Claude Desktop ──stdio──> bridge ──WebSocket──> Kapture Server ──> Chrome Extension ──> Browser Tabs
Other MCP Clients ─────────────WebSocket───────^
```

When `npx kapture-mcp` runs:
- If no server is on the well-known port, it starts one.
- If a server is already running, the new invocation detects this and exits gracefully, leaving its stdio side as a pass-through to the existing server.

Multiple Claude clients (Desktop, Cline, custom) all connect to the same single server and share state. This is the canonical "Kapture pattern" and it's been working in production since mid-2025.

Other production references for the same pattern:
- `@mcp-b/websocket-bridge` — a generic stdio↔WebSocket proxy for MCP.
- `1mcp-app/agent`'s `StdioProxyTransport` — pure transport-to-transport forwarding using the official `@modelcontextprotocol/sdk` primitives, no `Client` layer.
- The MCP TypeScript SDK itself exposes both `StdioServerTransport` and `StdioClientTransport` / `WebSocketClientTransport` (or `StreamableHTTPClientTransport`) which can be composed for proxying.

---

## Latency analysis (already done, summarised)

If the chosen fix introduces a localhost-WebSocket hop for the non-primary Claude app:
- Added latency per tool call: ~0.5–1ms (localhost loopback + tiny JSON serialize/parse).
- Tab-reader's existing baseline: ~58ms for `fetch_current_tab` (extension extraction dominates) and a few ms for `get_current_tab`.
- Overhead ratio: ~2% on `fetch_current_tab`, imperceptible to the user.
- The primary Claude app (whichever started first) pays zero added latency — it talks to its in-process server exactly as today.

This shouldn't drive the design decision.

---

## What I'd like the next session to do

**Please don't just adopt the Kapture pattern because I gestured at it.** Treat my research as a starting point and do your own. Specifically:

1. **Verify and deepen the Kapture pattern research.** Read Kapture's actual source code (not just docs) — `github.com/williamkapke/kapture`. Understand how they detect "server already running," how they handle the handover when the primary dies, what protocol they speak over the WebSocket, and what failure modes they document. Look for warts they haven't fixed.

2. **Look at `@mcp-b/websocket-bridge` and `1mcp-app/agent`'s `StdioProxyTransport`** to see how the bridge half is implemented using the official MCP SDK primitives. Decide whether to reuse one of these or write your own minimal version.

3. **Explore alternatives I may have dismissed too quickly.** In particular:
   - Could the Chrome extension itself be the multiplexer? (Each MCP process connects to it via separate WebSocket; the extension routes.) This inverts the current architecture but might be cleaner.
   - Could the MCP server adopt MCP's own `StreamableHTTP` transport for the secondary clients, since the SDK already supports it? That's the protocol-blessed answer for "remote MCP," and localhost is a degenerate case of remote.
   - Could a separate persistent daemon (launchd plist) own `:17321`, with all Claude apps as thin clients? Cleaner architecturally but adds installation burden — weigh the trade.

4. **Check whether Claude Code itself has shipped any relevant capability** since this research was done. Specifically search the changelogs and `anthropics/claude-code` repo for "singleton MCP," "shared MCP server," anything about MCP lifecycle. If the framework now supports something native, that's better than a plugin-level fix.

5. **Read the existing code carefully before proposing changes.** Files of interest:
   - `server/src/index.ts` — the current single-process implementation. Lines around `startWebSocketServer()` and `main()` are the relevant entry points.
   - `server/src/pipeline.ts` — the extraction pipeline, shared with the extension. Shouldn't need changes.
   - `extension/src/` — the Chrome extension. Currently dials `ws://127.0.0.1:17321`. Whether it needs changes depends on which architecture you pick.
   - `HANDOVER.md` (the original, ~28KB) — describes the project history and design rationale. Read it before making invasive changes.

6. **Decide and propose, don't just implement.** After your research, write up the chosen approach (with rejected alternatives) in another handover file and discuss it with the user before changing source files. This is a small but architecturally meaningful change to a working project — worth getting right.

---

## Constraints to respect

- **The Chrome extension protocol** should ideally not change. If it must, document why and what changed.
- **The README install instructions** should remain valid for new users. Multi-client support should be transparent — no extra setup steps.
- **The user runs both Claude Desktop and Claude Code** and wants tab-reader available in both, simultaneously, without manual coordination.
- **No new heavy dependencies.** The project already depends on `ws`, `jsdom`, `@modelcontextprotocol/sdk`, `zod`. Stay within that orbit if possible.
- **Backwards compatibility.** A single Claude app should still work exactly as today — no regression for the most common case.

---

## Research sources

Primary references (read these):

- **GitHub issue `anthropics/claude-code#40220`** — "MCP servers with singleton resources conflict across concurrent sessions." Describes the exact shape of the problem class. Includes a file-lock fix proposal for the Telegram case.
  https://github.com/anthropics/claude-code/issues/40220

- **Kapture** — Chrome DevTools Extension + MCP server for browser automation. The closest architectural analog to tab-reader. Multi-client by design.
  - Repo: https://github.com/williamkapke/kapture
  - Multi-assistant guide: https://williamkapke.github.io/kapture/MULTI_ASSISTANT_GUIDE.html
  - npm: https://www.npmjs.com/package/kapture-mcp

- **`@mcp-b/websocket-bridge`** — generic stdio↔WebSocket bridge for MCP. Useful reference for the bridge half.
  https://www.npmjs.com/package/@mcp-b/websocket-bridge

- **`1mcp-app/agent` `StdioProxyTransport`** — production implementation of pure transport-to-transport forwarding using the official SDK.
  https://glama.ai/mcp/servers/@1mcp-app/agent/blob/75d8cb012db8f512a49003151f725d6bd77241e0/src/transport/stdioProxyTransport.ts

Secondary references (skim if relevant):

- **GitHub issue `zilliztech/claude-context#285`** — same class of problem, with the recommended remedy being "one long-lived shared MCP server."
  https://github.com/zilliztech/claude-context/issues/285

- **MCP spec — Transports** (2025-03-26 revision, current). Defines stdio and Streamable HTTP; clarifies SSE is deprecated.
  https://modelcontextprotocol.io/specification/2025-03-26/basic/transports

- **MCP TypeScript SDK** — has `StdioServerTransport`, `StdioClientTransport`, `StreamableHTTPClientTransport`. Relevant if reusing SDK primitives rather than rolling your own bridge.
  https://www.npmjs.com/package/@modelcontextprotocol/sdk

- **`chrome-extension-bridge-mcp` (Oanakiaja)** — another Chrome-extension MCP bridge. Different design choices than Kapture. Worth a glance for contrast.
  https://github.com/Oanakiaja/chrome-extension-bridge-mcp

- **Anthropics docs — Claude Code MCP setup.** For checking whether any framework-level singleton/shared support has shipped.
  https://docs.claude.com/en/docs/claude-code/mcp (and the up-to-date `code.claude.com/docs/en/mcp`)

---

## Empirical facts about the user's environment (verified via Desktop Commander)

- macOS, `/Users/edwin`
- Claude Code v2.1.150, Opus 4.7, model from `.claude/settings.json`
- Claude Desktop also installed and running
- tab-reader currently configured in **both** Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`) and Claude Code (`~/.claude.json`, user scope)
- Both configs spawn the same binary: `node /Users/edwin/Documents/ClaudeCustom/MCP/tab-reader/server/build/index.js`
- The Node binary in use is `/opt/homebrew/bin/node`
- Chrome extension is loaded and connected (verified via `lsof -i :17321` showing an `ESTABLISHED` connection from Google Chrome's PID 2028)
- A backup of Claude Desktop config was created at `claude_desktop_config.json.bak.20260525_235054` during a previous (aborted) intervention — feel free to delete if no longer needed

---

## A note on process

The user asked the previous session **not to prescribe the implementation**, only to hand off research and a general direction. Please honour that:

- Don't open this with "here's the code I'll write."
- Don't pick the Kapture pattern just because it was mentioned most.
- Do your own search. Form your own opinion. Disagree with the framing above if the evidence warrants it.
- When you're ready to act, surface your proposed approach to the user for sign-off before touching source files.

Good luck.
