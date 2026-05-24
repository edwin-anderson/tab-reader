# HANDOVER.md — tab-reader

> Companion to `README.md`. The README explains how to **set up and use**
> tab-reader. This doc explains how it **actually works** under the hood and
> what's tricky to know when you change it. Read this before editing code.

**Last updated:** v2.1.0 (2026-05-24)
**Current state:** Working. v2.1 moves extraction into the Chrome extension's
content script and adds section-aligned image support. v2.0's documentation-
grade Markdown pipeline now lives in `server/src/pipeline.ts` as the single
source of truth — both the server's fallback path and the extension's
content-script extractor consume it.

---

## TL;DR — what this project is

A two-piece system that lets Claude Desktop see and read the user's current
Chrome tab — *including the images on the page, aligned to their sections*:

```
Chrome extension ──WebSocket──> MCP server (Node) <──stdio── Claude Desktop
   (watches tabs + runs the     (port 17321)              (calls tools)
    live-DOM extractor)
```

The server exposes two tools to Claude Desktop:
- **`get_current_tab`** — returns `{ url, title, lastUpdated, extensionConnected }`. Cheap.
- **`fetch_current_tab`** — returns the current tab as Markdown. When called
  with `include_images: true`, returns text and images **interleaved by
  section**: each image block appears in the response right after the text of
  its section. Works on logged-in pages and JS-rendered content because the
  extraction runs in the user's browser, not server-side. Falls back to a
  server-side HTTP GET (text only, public pages only) when the extension is
  disconnected.

The extension does three jobs:
1. Push `{ url, title }` over WebSocket whenever the active tab changes.
2. Ping `"keepalive"` every 20s (10s while a request is in flight) to keep
   the MV3 service worker alive.
3. On `extract` requests from the server, run the bundled content-script
   extractor (`dist/extractor.js`) in the active tab via
   `chrome.scripting.executeScript` and return the resulting content blocks.

---

## Repo layout

```
tab-reader/
├── README.md                                 # user-facing setup guide
├── HANDOVER.md                               # this file
├── server/
│   ├── package.json                          # v2.1.0
│   ├── tsconfig.json                         # ES2022, Node16 modules, strict
│   ├── src/
│   │   ├── index.ts                          # MCP server + WS server + fallback fetch
│   │   ├── pipeline.ts                       # SHARED extraction pipeline
│   │   │                                     # (used by BOTH server fallback AND extension)
│   │   └── types/
│   │       └── turndown-plugin-gfm.d.ts      # ambient module decl (no @types pkg exists)
│   └── build/                                # what Claude Desktop spawns
└── extension/
    ├── manifest.json                         # MV3, minimum_chrome_version: 116, v1.1.0
    ├── background.js                         # service worker (routes extraction + WS)
    ├── package.json                          # devDeps for the esbuild bundler
    ├── src/
    │   └── extractor.ts                      # content-script extractor, imports
    │                                         # ../../server/src/pipeline
    ├── dist/
    │   └── extractor.js                      # bundled output (esbuild IIFE)
    └── icon.png                              # 128×128 teal "T"
```

The shared extraction pipeline physically lives at `server/src/pipeline.ts`
(not at top-level `shared/`) so the server's existing tsconfig rootDir and
package.json `bin` path don't need to change. The extension's esbuild build
bundles `pipeline.ts` into `dist/extractor.js` via a relative import
(`../../server/src/pipeline`). Same source of truth, two consumers.

---

## How the server is structured (`server/src/index.ts`)

One Node process runs two things in parallel:

1. **MCP server over stdio** — talks JSON-RPC to Claude Desktop.
2. **WebSocket server on `127.0.0.1:17321`** — accepts pushes from the Chrome
   extension AND sends extraction requests back to it.

Shared in-memory state:

```ts
let latestTab: TabInfo | null = null;     // last { url, title } pushed by extension
let extensionConnected = false;
let extensionSocket: WebSocket | null = null;   // for sending requests
const pendingRequests = new Map<string, PendingRequest>();   // correlation
```

### Critical invariant: never write to stdout

**stdout is the MCP JSON-RPC channel.** Any stray `console.log` will break the
protocol and Claude Desktop will silently lose the server. All logging in this
codebase uses `console.error` (stderr). If you add logging, do the same.

### WS message protocol (v2.1)

The same socket carries three message kinds. Dispatch on the `type` field
where present; the legacy tab-update shape has no `type` and is recognized by
the presence of `url`+`title`.

```
// extension → server (legacy tab update; no `type` field)
{ "url": "...", "title": "..." }

// extension → server (response to a server-initiated request)
{ "type": "response", "id": "<uuid>", "ok": true,
  "content": ContentBlock[], "meta": { "url", "title", "rootKind" } }
{ "type": "response", "id": "<uuid>", "ok": false, "error": "..." }

// server → extension (extraction request)
{ "type": "request", "id": "<uuid>", "op": "extract",
  "params": { "includeImages": boolean } }

// extension ↔ server keepalive
"keepalive" / "ack"
```

`requestExtraction(includeImages)` generates a UUID, registers a `PendingRequest`
with a 30s timeout, sends the request, and resolves when the matching
response arrives. If the socket closes mid-request, all pending requests are
rejected with "Extension disconnected before responding".

### File sections (in order)

1. **Shared state** (`TabInfo`, `ContentBlock`, `ExtractionResponse`, the
   pendingRequests map).
2. **WebSocket server** (`startWebSocketServer`) — handles keepalive, dispatches
   responses to pending requests, accepts legacy tab updates.
3. **`requestExtraction`** — server-side caller of the extension's extract op.
4. **HTML → Markdown (server-side fallback)** — `extractContent` uses the
   shared pipeline from `./pipeline.ts` against jsdom. Used only when the
   extension is disconnected.
5. **`fetchAndExtract`** — HTTP GET + `extractContent` for the fallback path.
6. **MCP server + tool registrations** (`get_current_tab`, `fetch_current_tab`).
7. **`main()`** — boots both servers.

---

## The extraction pipeline

The pipeline (JUNK_SELECTORS, `normalizeDom`, `pickContentRoot`, `makeTurndown`)
lives in `server/src/pipeline.ts` and is consumed by **both** the server's
server-side fallback and the extension's content script. Single source of
truth — any change to selectors or Turndown rules takes effect in both
places after a rebuild.

### Why no Readability (v2.0 baseline, still binding)

Readability is designed for **news articles** with one big content blob in
the middle. It scores each DOM subtree by "content density" (text-to-tag
ratio, paragraph count, etc.) and keeps the highest scorer.

On documentation sites it strips things we need:
- Step-by-step walkthroughs (low density — lots of icons + nested divs).
- Code-heavy sections (Readability undervalues `<pre>`).
- Callouts (`<Note>`, `<Tip>`, etc. — they look like UI widgets to it).

Concretely, on `code.claude.com/docs/en/agent-view`, Readability dropped the
entire "Quick start" step content, leaving only the rendered badge numbers
"1 2 3 4 5". We do not use it.

### The pipeline (shared)

1. `applyJunkSelectors(doc)` removes elements matching `JUNK_SELECTORS`:
   nav, footer, sidebar, ads, anchor permalinks, Mintlify step-badge rails, etc.
2. `normalizeDom(doc)`:
   - Promote `[data-component-part="step-title"]` to `<h4>`.
   - Strip inline anchor permalinks inside headings (replace heading content
     with plain text via `h.textContent = ...`).
   - Convert `<span data-as="p">` to real `<p>`.
3. `pickContentRoot(doc)` picks the main content root in priority order:
   `<main>` → `<article>` → `[role='main']` → `#content` → `.content` → `<body>`.
   The chosen root is reported as `Root: <main>` in the output for debugging.
4. `makeTurndown()` returns a configured TurndownService:
   - ATX headings, fenced code blocks, GFM tables, inline links.
   - `drop-noise` rule removes `SCRIPT`/`STYLE`/`NOSCRIPT`/`IFRAME`/`SVG`/`LINK`/`META`.
   - `clean-img` rule emits `<img src="..." alt="..." width=... height=...>`
     stripped of `srcset`/`sizes`/`data-*`/classes.
   - `fenced-code-with-lang` rule emits ` ```foo ... ``` ` when
     `<pre><code class="language-foo">` is present.
     **Known limitation:** doesn't catch Mintlify's parent-`language` pattern
     (see "Known gaps").

### Server-side path (fallback only)

`extractContent(html, url)` in `index.ts` parses with JSDOM, calls
`applyJunkSelectors` + `normalizeDom` + `pickContentRoot`, runs Turndown.
Used only when the extension is disconnected.

### Extension-side path (preferred when extension is connected)

`extension/src/extractor.ts` runs in the page's isolated world. It:

1. Identifies qualifying live images via `getBoundingClientRect()`
   (≥ 100×100 rendered) and `getComputedStyle()` (not display:none/hidden).
   For each, sets `data-tr-id="N"` on the **live** element.
2. Snapshots the document via
   `document.implementation.createHTMLDocument()` + `innerHTML` copy. The
   `data-tr-id` attributes ride along into the clone.
3. Removes `data-tr-id` from the live elements (mutation is brief and invisible).
4. Runs the **shared pipeline** on the clone: junk-strip → normalize → pickRoot.
   Images in junk zones get dropped here along with their tags.
5. For up to `MAX_IMAGES = 20` surviving images in the content root, schedules
   parallel byte fetches. The rest get `data-tr-skip="exceeded N-image limit"`.
6. Runs a Turndown variant that emits `[[TR_IMAGE_N]]` and
   `[[TR_IMAGE_PLACEHOLDER:reason]]` markers in place of tagged images.
7. Awaits all image fetches (`Promise.all`).
8. Splits the Markdown on markers and interleaves real image content blocks
   (or inline placeholder text blocks for failures) at the marker positions.
9. Returns `{ rootKind, url, title, content }` (content is the interleaved
   ContentBlock[]). The SW returns this to the server.

### Image fetching strategy (extension-side)

Per qualifying image, in order:

1. **Page-context fetch** with `fetch(url, { credentials: "include" })`.
   Carries user cookies + hits the browser cache (the image was already
   loaded to render the page). Works for same-origin and CORS-permissive
   cross-origin.
2. **SW-context fetch fallback.** Content script sends
   `{type:"fetchImage", url, maxBytes}` to the SW; SW does a plain `fetch`
   from extension origin (bypasses CORS via `<all_urls>` host_permissions)
   and returns base64. Loses user cookies — fine for public CDN assets.

Per-image cap: 2 MB pre-base64 (enforced both client-side and SW-side).

On any failure (CORS, HTTP error, oversize) the image becomes an inline
placeholder text block `[image omitted: <reason>]` at its position in the
section. Section alignment is preserved.

### SW lifecycle hardening

The keepalive runs at **10s** while a request is in flight (vs 20s idle).
Counter-based: `intensifyKeepAlive()` / `relaxKeepAlive()` wrap the request
handler in `handleRequest`.

### Output format

When extension is connected:
```
URL: https://...
Title: ...
Source: extension
Mode: include_images=true|false
Extracted in: 743ms
Root: <main>
[Note: active tab changed during extraction (...)]   ← only if URL drift detected

---

<text block 1>
<image block>
<text block 2>
<image block>
...
```

The `Note:` line appears only when the URL the extension extracted differs
from the URL the server last received in a tab update — useful for debugging
tab-switch races.

When extension is disconnected (server-side fallback, text only):
```
URL: ...
Title: ...
Status: 200
Content-Type: text/html; charset=utf-8
Bytes: 1307400
Fetched in: 257ms
Root: <main>

---

<markdown content here>
```

---

## The Chrome extension

MV3 service worker (`extension/background.js`) + bundled content script
(`extension/dist/extractor.js`, built from `extension/src/extractor.ts`).

### 1. WebSocket activity keeps the service worker alive

MV3 service workers idle out after 30s. **WebSocket message activity (send
OR receive) resets that timer in Chrome 116+.** Hence:

- We send `"keepalive"` (plain string, not JSON) every 20s (idle) or 10s
  (while an extraction request is in flight).
- The server replies with `"ack"` so the SW also gets inbound traffic.

Source of truth: <https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets>

### 2. Reconnect with exponential backoff

If the WebSocket closes (server restarts, etc.), the extension retries with
delays of 1s, 2s, 4s, 8s, 16s, 30s, 30s, … This is why after you rebuild and
restart Claude Desktop, the extension auto-reconnects within ~30s.

### 3. Tab events tracked

`chrome.tabs.onActivated`, `chrome.tabs.onUpdated`, and
`chrome.windows.onFocusChanged`. Together they cover tab switch, URL change
inside a tab (including SPA navigations via `changeInfo.status === "complete"`),
and window focus change. Whenever any fires, we call `pushActiveTab()`.

### 4. Extraction request handling

When the server sends `{type:"request", op:"extract", ...}`:

1. SW queries the active tab via `chrome.tabs.query({active:true, lastFocusedWindow:true})`.
2. Rejects browser-internal URLs (`chrome://`, `chrome-extension://`, etc.).
3. **Two-step `chrome.scripting.executeScript`** in `world: "ISOLATED"`:
   - First call loads `dist/extractor.js` (the IIFE assigns
     `window.__tabReader = { extract }` in the isolated world).
   - Second call uses `func:` to invoke `window.__tabReader.extract(args)`
     and returns its result. Both calls share the same isolated world
     because they're from the same extension into the same tab/frame.
4. Returns `{type:"response", id, ok, content, meta}` to the server.

`intensifyKeepAlive()` / `relaxKeepAlive()` wrap the handler to switch the
keepalive cadence while the work is in flight.

### 5. Permissions (v2.1)

- `tabs` — to know which tab is active.
- `scripting` — to inject the extractor.
- `host_permissions: ["<all_urls>"]` — required so that
  `chrome.scripting.executeScript` can target any page without a user
  gesture (we're triggered by the server, not by an extension-UI click).
  Also lets the SW fetch arbitrary image URLs as the CORS fallback.

---

## How to make changes

### Workflow for ANY change to `server/src/index.ts` or `server/src/pipeline.ts`

```bash
cd <repo>/server
npm run build
# Then: Cmd+Q Claude Desktop and reopen it.
```

**Cmd+Q + reopen is non-negotiable for every server change.** Claude Desktop:
- Spawns the server process only once at startup.
- Caches the tool list (descriptions, schemas) for the whole session.

After reopen, the Chrome extension auto-reconnects in under 30s via its retry
loop.

If you changed `pipeline.ts`, **also rebuild the extension** — the pipeline is
bundled into `dist/extractor.js`, so the extension won't pick up your change
otherwise:
```bash
cd <repo>/extension && npm run build
# Then: chrome://extensions → Tab Reader → reload.
```

### Workflow for changes to `extension/src/extractor.ts`

```bash
cd <repo>/extension
npm run build       # esbuild bundles to dist/extractor.js
# Then: chrome://extensions → Tab Reader → reload.
```

No Claude Desktop restart needed — the SW reloads on its own and
`chrome.scripting.executeScript` will inject the new bundle on the next call.

### Workflow for changes to `extension/background.js` or `manifest.json`

No build step (these are loaded as-is). `chrome://extensions` → Tab Reader
→ reload (↻). Then check the service worker console for `[tab-reader] WebSocket open`.

### Testing extraction quality

The extension's extractor produces the same Markdown structure as the
server's fallback for a given page (they share `pipeline.ts`). Differences
come from JSDOM-vs-live-DOM, which is mostly a feature: the extension sees
post-JS content, lazy-loaded images, and the user's authenticated view.

For quick sanity checks of pipeline changes without Claude Desktop in the
loop, write a small `.mjs` in `server/` that imports `./pipeline.js`, parses
a fixture HTML with jsdom, and prints. Don't commit those scripts.

The official MCP Inspector (`npx @modelcontextprotocol/inspector`) is useful
for testing the JSON-RPC layer with handcrafted tool calls.

### What's safe to refactor

- `pipeline.ts` is a single source of truth — change once, both consumers
  pick it up after rebuilds.
- Add new junk selectors to `JUNK_SELECTORS`. Add new normalizations to
  `normalizeDom`. Add new Turndown rules in `makeTurndown`.
- The image walker in `extractor.ts` is independent of the text pipeline.
  Its hard limits (`MAX_IMAGES`, `MAX_BYTES_PER_IMAGE`, `MIN_RENDERED_SIDE`)
  are at the top of the file — easy to tune.

### What requires care

- **Don't reintroduce Readability.** It will silently regress documentation
  sites. If you ever feel like you need it, look at the page's source HTML
  first — usually a junk selector or a `normalizeDom` rule is what's missing.
- **Don't add `console.log` anywhere in the server.** stderr only
  (`console.error`). stdout = JSON-RPC; logs to it break the protocol.
- **Don't put extraction cleanup logic in regex when you can use DOM
  operations.** Our v1.3 attempt used string-level regex on HTML and was
  less robust than the v2.0 DOM-mutation approach.
- **Don't import Node-only modules in `pipeline.ts`.** It's consumed by the
  extension bundle too — jsdom, ws, fs, etc. must stay in `index.ts`.
- **Don't mutate the live DOM unnecessarily in the extractor.** The current
  `data-tr-id` tagging is removed immediately after the clone is taken
  (within microseconds, invisible). Anything longer-lived would affect the
  user's view of the page.

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

### 5. Inline SVG and `<canvas>`-rendered content

The image walker only handles `<img>` elements. Inline `<svg>` (diagrams,
icons that have real content), `<canvas>` (charts, Figma-style editors), and
`<video>` posters are not captured. SVG would need serialization (or
rasterization via the new bundle); canvas would need `toDataURL()` and is
tainted by cross-origin draws. Defer until a real case demands them.

### 6. Same-origin iframes are skipped

The extractor runs in the top frame only. Images inside same-origin iframes
are out of scope. Cross-origin iframes are inaccessible regardless. A future
fix would be `all_frames: true` injection plus frame coordination — moderate
work, defer.

### 7. Browser-internal pages still don't work

`chrome://`, `chrome-extension://`, `about:`, `edge://`, `brave://`, etc.
The SW rejects these explicitly (`chrome.scripting.executeScript` can't
inject into them). Fallback path also rejects them. There's no fix —
this is by Chrome's design.

### 8. Cross-origin auth-required images without CORS

Page-context fetch works only when the cross-origin image's server returns
CORS headers. SW-context fallback bypasses CORS but loses the user's
cookies. If a cross-origin image is auth-required AND lacks CORS, we can't
fetch it — that image becomes a placeholder text block. Rare in practice
(most auth-gated images are same-origin to the page).

### 9. No caching

Built-in `WebFetch` caches responses for ~15min. We don't. Every
`fetch_current_tab` call hits the live DOM (or the network, in fallback).
Probably not worth the complexity for a single-user local tool.

---

## Out of scope / explicitly rejected

These came up during development and we chose not to do them. Don't re-add
without a real reason.

- **AI summarization inside the server.** The point is faithful raw content
  in Markdown. Let Claude do the summarizing.
- **Caching.** See gap #9.
- **MCP Registry publication.** Local-only personal tool.
- **Multiple-tab tracking.** Only one active tab at a time.
- **Output truncation.** No cap on text. The whole page is returned. Image
  walker has hard limits (20 images, 2 MB each) but text is uncapped. If
  context becomes a problem, add an opt-in `max_chars` parameter — don't
  truncate by default.
- **Matching built-in `WebFetch` output byte-for-byte.** Our goal is
  "highest-quality data" (user's words), not parity.
- **Full-page screenshot mode** (via `chrome.tabs.captureVisibleTab` or
  DevTools Protocol). The interleaved-image approach gives Claude the actual
  embedded images with section alignment — better signal at lower token cost.
  The DevTools-via-debugger approach also shows a persistent "Tab Reader is
  debugging this browser" banner, which is intrusive.
- **Always-on images** (no opt-in). Each image is ~1700+ vision tokens.
  `include_images` defaults to false; Claude opts in based on the user's
  intent ("show me this page including the diagrams").

---

## How to verify everything works end-to-end

After any change:

1. **Both builds clean:**
   ```bash
   cd <repo>/server && npm run build
   cd <repo>/extension && npm run build
   ```
   No errors. The extension build prints something like
   `dist/extractor.js  37.2kb`.

2. **Reload extension:** `chrome://extensions` → Tab Reader → reload (↻).
   If you changed `manifest.json` (new permissions), Chrome will prompt to
   re-approve.

3. **Restart Claude Desktop:** Cmd+Q, then reopen.
   ```bash
   tail ~/Library/Logs/Claude/mcp-server-tab-reader.log
   ```
   should show:
   ```
   [tab-reader] MCP server connected on stdio (v2.1.0)
   [tab-reader] WebSocket server listening on ws://127.0.0.1:17321
   ```
   then within ~30s:
   ```
   [tab-reader] Chrome extension connected
   [tab-reader] Tab updated: <title> — <url>
   ```

4. **Tools respond:**
   - "what tab am I on?" → `get_current_tab` → URL + title.
   - "summarize this page" → `fetch_current_tab` (default text-only via
     extension) → Markdown with `Source: extension` in the header.
   - "show me this page including the images" → `fetch_current_tab`
     with `include_images:true` → interleaved text + image blocks. Each
     image appears between the text of its section and the next section's
     text. The header shows `Mode: include_images=true`.

5. **Fallback path:** disable the extension in `chrome://extensions`. Ask
   `fetch_current_tab` again. Should fall back to server-side HTTP GET with
   the full `Status / Content-Type / Bytes / Fetched in` header. Re-enable
   afterwards.

6. **Auth-page sanity check:** on a logged-in page (Gmail, internal dashboard,
   private GitHub README), call `fetch_current_tab`. The extension path
   should extract the real content (closes the old gap #5).

If the extension doesn't connect, check `chrome://extensions` → Tab Reader →
"Inspect views: service worker" — should show `[tab-reader] WebSocket open`.
If extraction fails with "scripting permission" errors, the new permissions
weren't approved — reload the extension and accept the prompt.

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
- **v2.0** — dropped Readability entirely. Direct DOM extraction with
  JUNK_SELECTORS + `normalizeDom` + Turndown. Significantly better on
  documentation sites.
- **v2.1** *(current)* — moved extraction into the Chrome extension's content
  script (live DOM, post-JS, with the user's session). Pipeline lifted into
  `server/src/pipeline.ts` as the single source of truth, consumed by both
  the extension bundle and the server's fallback path. Added
  `include_images: true` parameter on `fetch_current_tab` that returns
  embedded images as MCP image content blocks interleaved with article text
  in section-aligned order. Closed the auth-pages and JS-rendered-content
  gaps. New permissions: `scripting` + `<all_urls>` host permission.

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
| Server source | `server/src/index.ts` |
| Shared extraction pipeline | `server/src/pipeline.ts` |
| Server build output | `server/build/index.js` |
| Extension manifest | `extension/manifest.json` |
| Extension SW source | `extension/background.js` |
| Content-script source | `extension/src/extractor.ts` |
| Content-script build | `extension/dist/extractor.js` |
| Claude Desktop config | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Server stderr log | `~/Library/Logs/Claude/mcp-server-tab-reader.log` |
| General MCP log | `~/Library/Logs/Claude/mcp.log` |
| Extension service worker log | `chrome://extensions` → Tab Reader → Inspect views: service worker |

---

## When in doubt

- Read the file headers and comments in `server/src/index.ts`,
  `server/src/pipeline.ts`, and `extension/src/extractor.ts` — they document
  the "why" of each piece.
- The Chrome WebSocket guide is the canonical reference for the MV3
  service-worker dance: <https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets>
- The Chrome scripting API reference for content-script injection:
  <https://developer.chrome.com/docs/extensions/reference/api/scripting>
- MCP docs index (for SDK questions, content-block types):
  <https://modelcontextprotocol.io/llms.txt>
- MCP tool result spec (text + image + audio content blocks, order preservation):
  <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
