# HANDOVER.md — tab-reader

> Companion to `README.md`. The README explains how to **set up and use**
> tab-reader. This doc explains how it **actually works** under the hood and
> what's tricky to know when you change it. Read this before editing code.

**Last updated:** v2.0.0 (2026-05-24)
**Current state:** Working. v2.0 ships a documentation-grade Markdown
extractor that significantly outperforms Mozilla Readability on doc sites.

---

## TL;DR — what this project is

A two-piece system that lets Claude Desktop see and read the user's current
Chrome tab:

```
Chrome extension ──WebSocket──> MCP server (Node) <──stdio── Claude Desktop
   (watches tabs)                 (port 17321)               (calls tools)
```

The server exposes two tools to Claude Desktop:
- **`get_current_tab`** — returns `{ url, title, lastUpdated, extensionConnected }`. Cheap.
- **`fetch_current_tab`** — server-side HTTP GET of the current tab's URL,
  returns high-fidelity Markdown. The heavy lifter.

The extension does one job: push `{ url, title }` over WebSocket whenever
the active tab changes, and ping `"keepalive"` every 20s to keep the MV3
service worker alive.

---

## Repo layout

```
tab-reader/
├── README.md                                 # user-facing setup guide
├── HANDOVER.md                               # this file
├── server/
│   ├── package.json                          # v2.0.0
│   ├── tsconfig.json                         # ES2022, Node16 modules, strict
│   ├── src/
│   │   ├── index.ts                          # ~557 lines, the entire server
│   │   └── types/
│   │       └── turndown-plugin-gfm.d.ts      # ambient module decl (no @types pkg exists)
│   └── build/
│       └── index.js                          # what Claude Desktop spawns
└── extension/
    ├── manifest.json                         # MV3, minimum_chrome_version: 116
    ├── background.js                         # service worker
    └── icon.png                              # 128×128 teal "T"
```

---

## How the server is structured (`server/src/index.ts`)

One Node process runs two things in parallel:

1. **MCP server over stdio** — talks JSON-RPC to Claude Desktop.
2. **WebSocket server on `127.0.0.1:17321`** — accepts pushes from the Chrome
   extension.

They share one piece of in-memory state:

```ts
let latestTab: TabInfo | null = null;
let extensionConnected = false;
```

`latestTab` is whatever the extension pushed most recently. Both MCP tools
read from it.

### Critical invariant: never write to stdout

**stdout is the MCP JSON-RPC channel.** Any stray `console.log` will break the
protocol and Claude Desktop will silently lose the server. All logging in this
codebase uses `console.error` (stderr). If you add logging, do the same.

### File sections (in order)

The file is organized top-to-bottom in dependency order:

1. **Shared state** (`TabInfo`, `latestTab`, `extensionConnected`)
2. **WebSocket server** (`startWebSocketServer`) — accepts the extension,
   handles `"keepalive"` strings vs. JSON tab payloads, manages connect/disconnect.
3. **HTML → Markdown pipeline** (`makeTurndown`, `normalizeDom`,
   `JUNK_SELECTORS`, `extractContent`) — the heart of `fetch_current_tab`.
4. **fetch + extract** (`fetchAndExtract`) — does the HTTP GET, dispatches
   to `extractContent` for HTML responses.
5. **MCP server + tool registrations** (`server.registerTool` ×2)
6. **`main()`** — boots both servers.

---

## The extraction pipeline (v2.0 architecture — important)

**This is what changed in v2.0.** We previously used Mozilla Readability and
it failed badly on documentation sites (Mintlify in particular). v2.0 drops
Readability entirely.

### Why no Readability

Readability is designed for **news articles** with one big content blob in
the middle. It scores each DOM subtree by "content density" (text-to-tag
ratio, paragraph count, etc.) and keeps the highest scorer.

On documentation sites it strips things we need:
- Step-by-step walkthroughs (low density — lots of icons + nested divs).
- Code-heavy sections (Readability undervalues `<pre>`).
- Callouts (`<Note>`, `<Tip>`, etc. — they look like UI widgets to it).

Concretely, on `code.claude.com/docs/en/agent-view`, Readability dropped the
entire "Quick start" step content, leaving only the rendered badge numbers
"1 2 3 4 5". Built-in `WebFetch` in Claude Desktop also handles this with a
custom pipeline (we believe), not Readability.

### What we do instead

1. Parse the HTML with `JSDOM`.
2. Run a list of selectors over `doc.querySelectorAll` and remove obvious junk
   (nav, footer, sidebar, ads, anchor permalinks, Mintlify step-badge rails).
   See `JUNK_SELECTORS` in the source.
3. Apply site-specific DOM normalizations (`normalizeDom`):
   - Promote `[data-component-part="step-title"]` to `<h4>`.
   - Strip inline anchor permalinks inside headings (replace heading content
     with plain text via `h.textContent = ...`).
   - Convert `<span data-as="p">` to real `<p>`.
4. Pick the main content root, in priority order:
   `<main>` → `<article>` → `[role='main']` → `#content` → `.content` → `<body>`.
   The chosen root is reported in the response as `Root: <main>` so you can
   debug from the output.
5. Hand the root's `innerHTML` to Turndown with our custom rules.

### Turndown configuration (`makeTurndown`)

ATX headings, fenced code blocks, GFM tables, inline links. Three custom rules:

- **`drop-noise`** — removes `SCRIPT`/`STYLE`/`NOSCRIPT`/`IFRAME`/`SVG`/`LINK`/`META`.
  Done as a filter function because TypeScript's `HTMLElementTagNameMap`
  doesn't know `svg` as a removable string.
- **`clean-img`** — emits `<img src="..." alt="..." width="..." height="...">`
  with only the essential attributes. Drops `srcset`, `sizes`, `data-*`, classes —
  none of which an LLM reader needs.
- **`fenced-code-with-lang`** — on `<pre><code class="language-foo">`, emits
  ` ```foo ... ``` `. **Known limitation:** doesn't catch Mintlify's
  `<div ... language="shellscript">` pattern where the language is on a parent.
  See "Known gaps" below.

### Output format

Response from `fetch_current_tab` looks like:

```
URL: https://...
Title: ...
Status: 200
Content-Type: text/html; charset=utf-8
Bytes: 1307400
Fetched in: 257ms
Root: <main>

---

<markdown content here>
```

The `Root: <…>` line is debugging gold — it tells you whether a page was found
via `<main>` (best), `<article>`, `#content`, `body` (worst, means we couldn't
narrow at all), etc.

---

## The Chrome extension (`extension/background.js`)

MV3 service worker. About 160 lines. Three things to know:

### 1. WebSocket activity keeps the service worker alive

MV3 service workers idle out after 30s. **WebSocket message activity (send
OR receive) resets that timer in Chrome 116+.** Hence:

- We send `"keepalive"` (plain string, not JSON) every 20s.
- The server replies with `"ack"` so the SW also gets inbound traffic.

Source of truth: <https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets>

### 2. Reconnect with exponential backoff

If the WebSocket closes (server restarts, etc.), the extension retries with
delays of 1s, 2s, 4s, 8s, 16s, 30s, 30s, … This is why after you rebuild and
restart Claude Desktop, the extension auto-reconnects within ~30s.

### 3. We track `chrome.tabs.onActivated`, `chrome.tabs.onUpdated`, and `chrome.windows.onFocusChanged`

These three together cover: tab switch, URL change inside a tab (including
SPA navigations via `changeInfo.status === "complete"`), and window focus
change. Whenever any fires, we call `pushActiveTab()`.

`host_permissions` is intentionally **not** set — `host_permissions` is for
HTTP/cookie access, not WebSocket. Only `"tabs"` is needed.

---

## How to make changes

### Workflow for ANY change to `server/src/index.ts`

```bash
cd /Users/edwin/Documents/ClaudeCustom/MCP/tab-reader/server
npm run build
# Then: Cmd+Q Claude Desktop and reopen it.
```

**This is non-negotiable for every server change.** Claude Desktop:
- Spawns the server process only once at startup.
- Caches the tool list (descriptions, schemas) for the whole session.

So any code change OR tool description change OR new/removed tool requires a
full Cmd+Q + reopen. Closing the window is not enough.

After reopen, the Chrome extension auto-reconnects in under 30s via its retry
loop. No extension reload needed unless you also changed extension files.

### Workflow for changes to `extension/background.js` or `manifest.json`

`chrome://extensions` → Tab Reader → click the reload (↻) icon. Then check the
service worker console for `[tab-reader] WebSocket open`.

### Testing extraction quality without restarting Claude Desktop

You can sanity-check the pipeline standalone by writing a tiny `.mjs` script
in `server/` that imports the same libs (`jsdom`, `turndown`, `turndown-plugin-gfm`),
fetches a URL, and prints the result. We did this during v2.0 development.
Don't commit those files — keep them as scratch.

The official MCP Inspector (`npx @modelcontextprotocol/inspector`) also works
if you want to test the JSON-RPC layer without Claude Desktop in the loop.

### What's safe to refactor

- The pipeline is intentionally split into pure functions: `normalizeDom`,
  `extractContent`, `fetchAndExtract`. Add new normalizations to `normalizeDom`.
  Add new junk selectors to `JUNK_SELECTORS`.
- The Turndown rules are independent — add a new `td.addRule(...)` for any
  new transformation.

### What requires care

- **Don't reintroduce Readability.** It will silently regress documentation
  sites. If you ever feel like you need it, look at the page's source HTML
  first — usually a junk selector or a `normalizeDom` rule is what's missing.
- **Don't add `console.log` anywhere in the server.** stderr only (`console.error`).
- **Don't put cleanup logic in regex when you can use DOM operations.** Our
  v1.3 attempt used string-level regex replacements on HTML and was less
  robust than the v2.0 approach of mutating the parsed DOM. JSDOM is already
  loaded — use it.

---

## Known gaps (good first PRs)

These are real but minor. Listed in order of how often they'd actually matter:

### 1. Mintlify-style code blocks lose their language hint

The Mintlify rendered HTML for a shell snippet looks roughly like:

```html
<div class="code-block" language="shellscript">
  <pre><code>claude agents</code></pre>
</div>
```

The language is on the **parent `<div>`**, not on the `<code>` element. Our
`fenced-code-with-lang` Turndown rule only looks for `class="language-foo"` on
`<code>`. So Mintlify code blocks render as bare ` ``` ` without a hint.

**Fix:** in `fenced-code-with-lang`, walk up to the closest ancestor with a
`language` attribute (or matching class) and use that. Or do the promotion in
`normalizeDom` — find any element with a `language="..."` attribute and copy
it onto a child `<code>` as `class="language-..."`.

### 2. Heading inline code formatting is lost

Our `normalizeDom` heading cleanup does `h.textContent = …`, which collapses
inline `<code>` inside heading text to plain text. So `### `claude agents` lists subagents instead of opening agent view`
becomes `### claude agents lists subagents instead of opening agent view`
(no backticks).

**Fix:** instead of replacing `textContent`, walk the heading's children and
strip only `<a class="header-anchor">` (or similar permalink elements), then
trim whitespace. Preserves `<code>`/`<em>`/`<strong>` inside headings.

### 3. The first Mintlify step still occasionally misses its heading

We saw this once during development — the v2.0 fix (DOM-based promotion of
`[data-component-part="step-title"]`) handles it, but Mintlify's exact DOM
shape varies between page templates. If you hit a page where step 1 isn't
headed, look for whether the title element has a different attribute or
extra wrapping `<a>`. The fix lives in `normalizeDom`.

### 4. No caching

Built-in `WebFetch` caches responses for ~15min. We don't. Every
`fetch_current_tab` call hits the network. Probably not worth the
complexity for a single-user local tool, but worth noting.

### 5. Only HTTP/HTTPS URLs work

`fetch_current_tab` is a server-side `fetch()`, so:
- `chrome://`, `file://`, extension pages → returns an error message.
- Logged-in pages (Gmail, internal dashboards) → server gets the public/login
  page, not what the user actually sees.

If you ever need authenticated content, the only path is extension-side
extraction (have the extension call `document.body.innerText` and push that
over the WebSocket). That's a real architectural change — defer until needed.

---

## Out of scope / explicitly rejected

These came up during development and we chose not to do them. Don't re-add
without a real reason.

- **AI summarization inside the server.** The point is faithful raw content
  in Markdown. Let Claude do the summarizing.
- **Caching.** See above.
- **MCP Registry publication / version control.** Local-only personal tool.
- **Multiple-tab tracking.** Only one active tab at a time.
- **Authenticated fetches.** Would need extension-side DOM extraction.
- **Output truncation.** No cap. The whole page is returned. If context
  becomes a problem someday, add an opt-in `max_chars` parameter — don't
  truncate by default.
- **Matching built-in `WebFetch` output byte-for-byte.** Our goal is
  "highest-quality data" (user's words), not parity. v2.0 is **better** than
  the built-in on documentation sites (full step content vs. flattened steps).

---

## How to verify everything works end-to-end

After any change:

1. **Server compiles:** `cd server && npm run build` → no errors.
2. **Claude Desktop spawns it:** `tail ~/Library/Logs/Claude/mcp-server-tab-reader.log`
   right after Cmd+Q + reopen should show:
   ```
   [tab-reader] MCP server connected on stdio (v2.0.0)
   [tab-reader] WebSocket server listening on ws://127.0.0.1:17321
   ```
3. **Extension connects:** within ~30s of Claude Desktop reopening, the same
   log should show:
   ```
   [tab-reader] Chrome extension connected
   [tab-reader] Tab updated: <some title> — <some url>
   ```
4. **Tools respond:** in Claude Desktop, ask "what tab am I on?" → should call
   `get_current_tab` and return the URL + title. Then ask "summarize this
   page" → should call `fetch_current_tab` and respond from the Markdown.

If step 3 doesn't happen, check `chrome://extensions` → Tab Reader →
"Inspect views: service worker" — should show `[tab-reader] WebSocket open`.

---

## Version history

- **v1.0** — cheerio + plain-text strip + 12k char cap. Lossy, no structure.
  Only had `get_current_tab`.
- **v1.1** — added `fetch_current_tab` with the same lossy extraction.
- **v1.2** — switched to Readability + Turndown. Big quality jump for blog-like
  content; revealed the Mintlify failure mode.
- **v1.3** — added Mintlify-specific HTML preprocessing on top of Readability.
  Didn't fully fix the issue because Readability still dropped step content
  in its content-density scoring pass.
- **v2.0** *(current)* — dropped Readability entirely. Direct DOM extraction
  with JUNK_SELECTORS + `normalizeDom` + Turndown. Significantly better on
  documentation sites. This is the architecture to keep building on.

---

## Reference: claude_desktop_config.json entry

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

Path is `~/Library/Application Support/Claude/claude_desktop_config.json`.
The config likely also has `desktop-commander` and `claude-code` entries —
don't touch those.

---

## Reference: key file paths

| What | Where |
|---|---|
| Server source | `/Users/edwin/Documents/ClaudeCustom/MCP/tab-reader/server/src/index.ts` |
| Server build output | `/Users/edwin/Documents/ClaudeCustom/MCP/tab-reader/server/build/index.js` |
| Extension source | `/Users/edwin/Documents/ClaudeCustom/MCP/tab-reader/extension/` |
| Claude Desktop config | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Server stderr log | `~/Library/Logs/Claude/mcp-server-tab-reader.log` |
| General MCP log | `~/Library/Logs/Claude/mcp.log` |
| Extension service worker log | `chrome://extensions` → Tab Reader → Inspect views: service worker |

---

## When in doubt

- Read the comments in `server/src/index.ts` — they're the source of truth for
  the "why" of each rule.
- The Chrome WebSocket guide is the canonical reference for the MV3
  service-worker dance: <https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets>
- MCP docs index (for SDK questions): <https://modelcontextprotocol.io/llms.txt>
