# tab-reader

A local MCP server + Chrome extension that lets Claude Desktop and Claude
Code see and read the browser tab you're currently looking at — including
the **images** on the page, aligned with their sections so Claude knows
which figure belongs to which heading.

## How it works

```
                              ┌───────────────────────────┐
                              │ launchd LaunchAgent        │
                              │ com.tab-reader.daemon      │
                              │ runs at login, KeepAlive   │
                              └─────────────┬─────────────┘
                                            │ spawns / restarts
                                            ▼
   Chrome extension ──ws://127.0.0.1:17321/──> tab-reader daemon ◄── ws /mcp ── bridge ◄── stdio ── Claude Desktop
   (watches tabs +                              owns the port,                                       (or another bridge for
    runs the live-DOM extractor)                shared state, &                                       Claude Code, etc.)
                                                /status endpoint
```

- The **daemon** is a long-running Node process that owns
  `ws://127.0.0.1:17321`. It survives Claude restarts. launchd starts it
  at login and auto-restarts it on the rare crash.
- The **Chrome extension** dials the daemon, pushes
  `{ url, title }` whenever the active tab changes, and runs the live-DOM
  extractor when asked. A `"keepalive"` ping over the same WebSocket every
  20s keeps the extension's MV3 service worker alive (per the
  [official Chrome guide](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)).
- Each **Claude app** (Desktop or Code) configures `tab-reader` as a stdio
  MCP server pointing at the same `build/index.js` binary. When invoked
  without `--daemon`, the binary acts as a thin **bridge** that pipes
  Claude's stdio MCP traffic to the daemon's `/mcp` endpoint. Multiple
  bridges can connect simultaneously — Claude Desktop and Claude Code
  share the daemon and the extension without stepping on each other.

Two MCP tools:

- **`get_current_tab`** — returns `{ url, title }`. Cheap.
- **`fetch_current_tab`** — returns the page as Markdown. Set
  `include_images: true` to get embedded images as MCP image blocks
  interleaved with the article text. Works on logged-in pages and JS-
  rendered content (because the extraction happens in the user's browser).

Three pieces — the daemon, the Claude config, and the Chrome extension.
Requires macOS and Chrome 116+.

## One-time setup

### 0. Build (if you cloned a fresh copy)

```bash
cd server && npm install && npm run build
cd ../extension && npm install && npm run build
```

The build outputs (`server/build/index.js` and `extension/dist/extractor.js`)
are committed to the repo so you can skip this step if you don't plan to
modify the source.

### 1. Install the daemon

```bash
cd server
npm run install-daemon
```

This writes `~/Library/LaunchAgents/com.tab-reader.daemon.plist` (pointing at
the absolute path of `build/index.js`) and `launchctl bootstrap`s it. The
daemon starts immediately and re-launches at every login until you
`npm run uninstall-daemon`.

Verify:

```bash
launchctl list | grep com.tab-reader.daemon
lsof -i :17321              # should show one node process LISTENing
npm run status-daemon        # PID, uptime, extension/bridge state in one block
```

If you ever move the repo to a different directory (or `git pull` resets a
moved checkout), re-run `npm run install-daemon` from the new location to
re-template the plist with the new path.

### 2. Add the server to Claude Desktop

Open `~/Library/Application Support/Claude/claude_desktop_config.json` and
add the `tab-reader` entry inside `mcpServers`. If the file is empty, paste:

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

Replace the path with your own. Same binary as the daemon — when invoked
without `--daemon` it runs as a bridge that connects to the daemon.

`Cmd+Q` and reopen Claude Desktop. After restart, `tab-reader` should be
listed in the Connectors menu.

### 3. (Optional) Add the server to Claude Code

To use tab-reader from Claude Code too:

```bash
claude mcp add --scope user tab-reader -- \
  node /Users/edwin/Documents/ClaudeCustom/MCP/tab-reader/server/build/index.js
```

(or edit `~/.claude.json` directly). Same binary, same bridge mode. Both
Claude apps will share the same daemon, the same Chrome extension, and the
same view of the active tab.

### 4. Load the Chrome extension

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select `<repo>/extension/` (the folder, not the `dist/` subfolder).
5. The extension appears as "Tab Reader (for Claude)".

Open the extension's service-worker console
(chrome://extensions → Tab Reader → "Inspect views: service worker") and
you should see:

```
[tab-reader] WebSocket open
```

If you see that, you're done.

## Testing

In Claude Desktop or Claude Code, ask:

> What tab am I on right now?

Claude should call `get_current_tab` and answer with the URL + title of
your active Chrome tab.

Then try:

> Summarize this page.

Claude should call `fetch_current_tab` and respond from the page's
Markdown.

For images aligned with the article structure:

> Walk me through this page including the images.

Claude should call `fetch_current_tab` with `include_images: true` and see
each image in its correct section.

## Logs and debugging

- **Daemon logs** —
  ```bash
  tail -f ~/Library/Logs/tab-reader.log
  ```
- **MCP-side logs from Claude Desktop** (bridge process stderr) —
  ```bash
  tail -f ~/Library/Logs/Claude/mcp-server-tab-reader.log
  ```
- **Extension logs** — `chrome://extensions` → Tab Reader → "Inspect views:
  service worker".
- **Quick status** — `cd server && npm run status-daemon`.

## Rebuilding

If you change `server/src/*.ts` or `server/src/pipeline.ts`:

```bash
cd <repo>/server
npm run build
npm run reload-daemon          # picks up the new code in the daemon
```

(The bridge processes are short-lived and will use the new build on the
next Claude spawn.)

If you change `extension/src/extractor.ts`:

```bash
cd <repo>/extension
npm run build
```

If you change `extension/background.js` or `manifest.json`: no rebuild
needed for those — they load as-is. Either way: `chrome://extensions` →
Tab Reader → reload (↻).

## Uninstall

```bash
cd server
npm run uninstall-daemon
```

This `launchctl bootout`s the agent and removes the plist. Remove the
`tab-reader` entry from `claude_desktop_config.json` and/or
`~/.claude.json`, and remove the extension from `chrome://extensions`.

## Files

```
tab-reader/
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts          # entry point — dispatches to daemon or bridge
│   │   ├── daemon.ts         # long-running daemon: WS server, /status, per-bridge McpServers
│   │   ├── bridge.ts         # stdio↔WebSocket pipe spawned by each Claude app
│   │   └── pipeline.ts       # shared extraction pipeline (server fallback + extension bundle)
│   ├── scripts/
│   │   ├── com.tab-reader.daemon.plist.tmpl   # LaunchAgent template
│   │   ├── install-daemon.js
│   │   ├── uninstall-daemon.js
│   │   ├── reload-daemon.js
│   │   ├── status-daemon.js
│   │   └── lib.js
│   └── build/                # compiled output — what Claude bridges + launchd run
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
