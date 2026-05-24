# tab-reader

A local MCP server + Chrome extension that lets Claude Desktop see and read
the browser tab you're currently looking at — including the **images** on
the page, aligned with their sections so Claude knows which figure belongs
to which heading.

## How it works

```
Chrome extension ──WebSocket──> MCP server (Node) <──stdio── Claude Desktop
   (watches tabs +               (port 17321)              (calls tools)
    runs the live-DOM extractor)
```

- The extension watches the active tab and pushes `{ url, title }` over a
  local WebSocket whenever it changes.
- A `"keepalive"` ping over the same WebSocket every 20s keeps the
  extension's MV3 service worker alive (per the
  [official Chrome guide](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)).
  While an extraction is in flight it tightens to 10s.
- When Claude Desktop calls `fetch_current_tab`, the server asks the extension
  to extract the current tab from the *live* DOM and stream back high-fidelity
  Markdown (and, when requested, the page's images interleaved in section-
  aligned order). Falls back to a server-side HTTP GET when the extension
  isn't connected (text only, public pages only).

Two MCP tools:

- **`get_current_tab`** — returns `{ url, title }`. Cheap.
- **`fetch_current_tab`** — returns the page as Markdown. Set
  `include_images: true` to get embedded images as MCP image blocks
  interleaved with the article text. Works on logged-in pages and JS-rendered
  content (because the extraction happens in the user's browser).

Two pieces, both required — neither works alone. Requires Chrome 116+.

## One-time setup

### 0. Build (if you cloned a fresh copy)

```bash
cd server && npm install && npm run build
cd ../extension && npm install && npm run build
```

The build outputs (`server/build/index.js` and `extension/dist/extractor.js`)
are committed to the repo so you can also skip this step if you don't plan to
modify the source.

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
4. Select the folder `<repo>/extension/` (the folder, not the `dist/` subfolder).
5. The extension should appear in the list as "Tab Reader (for Claude)".

Chrome will ask you to approve permissions on first install (and again after
any future permission additions). Tab Reader needs:

- **Tabs** — to know which tab you're currently looking at.
- **Scripting** — to run the extractor in the active tab when Claude asks.
- **Access to all websites** — to read the live DOM and fetch image bytes on
  whatever page you're on. The extension only acts on the page when you call
  the MCP tools, and the only network traffic it makes is to `localhost:17321`
  (the local MCP server) plus the image URLs the page itself loaded.

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

Then try:

> Summarize this page.

Claude should call `fetch_current_tab` and respond from the page's Markdown.

For images aligned with the article structure:

> Walk me through this page including the images.

Claude should call `fetch_current_tab` with `include_images: true` and see
each image in its correct section.

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

If you change `server/src/index.ts` or `server/src/pipeline.ts`:

```bash
cd <repo>/server
npm run build
```

Then fully quit and restart Claude Desktop.

## Rebuilding the extension

If you change `extension/src/extractor.ts`:

```bash
cd <repo>/extension
npm run build
```

If you change `extension/background.js` or `manifest.json` (no rebuild needed
for those — they're loaded as-is), then either way: `chrome://extensions` →
Tab Reader → click the reload (↻) icon.

## Files

```
tab-reader/
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts          # MCP server + WebSocket server in one process
│   │   └── pipeline.ts       # shared extraction pipeline (used by both
│   │                         #   the server's fallback path AND the extension)
│   └── build/                # compiled output — what Claude Desktop runs
└── extension/
    ├── manifest.json         # MV3 manifest
    ├── background.js         # service worker — watches tabs, routes extraction requests
    ├── package.json          # devDeps for the bundler
    ├── src/
    │   └── extractor.ts      # live-DOM extractor, bundled into dist/
    ├── dist/
    │   └── extractor.js      # bundled output — injected into the page
    └── icon.png
```
