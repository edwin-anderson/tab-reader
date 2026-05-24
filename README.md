# tab-reader

A local MCP server + Chrome extension that lets Claude Desktop know what
browser tab you're currently looking at.

## How it works

```
Chrome extension ──WebSocket──> MCP server (Node) <──stdio── Claude Desktop
   (watches tabs)                 (port 17321)               (calls get_current_tab)
```

- The extension watches the active tab and pushes `{ url, title }` over a
  local WebSocket whenever it changes.
- A small `"keepalive"` ping over the same WebSocket every 20s keeps the
  extension's MV3 service worker alive (per the
  [official Chrome guide](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)).
- The MCP server keeps the latest tab info in memory and exposes a single tool,
  `get_current_tab`, to Claude Desktop over stdio.

Two pieces, both required — neither works alone. Requires Chrome 116+.

## One-time setup

### 1. Add the server to Claude Desktop

Open the Claude Desktop config file:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

(create it if it doesn't exist). Add the `tab-reader` entry inside `mcpServers`.
If the file is empty, paste this whole thing:

```json
{
  "mcpServers": {
    "tab-reader": {
      "command": "node",
      "args": ["/Users/edwin/Documents/ClaudeCustom/MCP/tab-reader/server/build/index.js"]
    }
  }
}
```

If you already have other servers, just add the `tab-reader` block inside the
existing `mcpServers` object.

### 2. Fully quit and restart Claude Desktop

`Cmd+Q` — not just closing the window. The config is only re-read on a full
restart.

After restart, you should see `tab-reader` listed in the Claude Desktop
connectors menu (the "+" button → Connectors).

### 3. Load the Chrome extension

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the folder `/Users/edwin/Documents/ClaudeCustom/MCP/tab-reader/extension/`.
5. The extension should appear in the list as "Tab Reader (for Claude)".

Open the extension's "service worker" console (chrome://extensions →
Tab Reader → "Inspect views: service worker") and you should see:

```
[tab-reader] WebSocket open
```

If you see that, you're done.

## Testing

In Claude Desktop, ask:

> What tab am I on right now?

Claude should call `get_current_tab` and answer with the URL + title of your
active Chrome tab.

## Logs and debugging

- **MCP server logs** — Claude Desktop captures stderr from MCP servers:
  ```bash
  tail -f ~/Library/Logs/Claude/mcp-server-tab-reader.log
  ```
- **General MCP logs** —
  ```bash
  tail -f ~/Library/Logs/Claude/mcp.log
  ```
- **Extension logs** — `chrome://extensions` → Tab Reader → "Inspect views:
  service worker".

## Rebuilding the server

If you change `server/src/index.ts`:

```bash
cd /Users/edwin/Documents/ClaudeCustom/MCP/tab-reader/server
npm run build
```

Then fully quit and restart Claude Desktop.

## Reloading the extension

If you change `extension/background.js` or `manifest.json`:

`chrome://extensions` → Tab Reader → click the reload (↻) icon.

## Files

```
tab-reader/
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   └── index.ts        # MCP server + WebSocket server in one process
│   └── build/
│       └── index.js        # compiled output — what Claude Desktop runs
└── extension/
    ├── manifest.json       # MV3 manifest
    ├── background.js       # service worker — watches tabs, pushes over WS
    └── icon.png
```
