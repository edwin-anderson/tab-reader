# tab-reader

A local MCP server + Chrome extension pair that lets Claude Desktop see and
read the browser tab you're currently looking at — *as high-fidelity Markdown,
with images aligned to the article's sections*.

This is a personal tool. It's not on the MCP Registry, it doesn't talk to
any third-party service, and it doesn't need an API key. Everything runs on
your laptop: the MCP server (Node, stdio), the Chrome extension (MV3), and
the local WebSocket bridge between them.

This document is the project's "what / why / how" overview. For setup,
see [README.md](README.md). For the editing handbook (file structure,
invariants, change workflows), see [HANDOVER.md](HANDOVER.md).

---

## What it does

Two MCP tools exposed to Claude Desktop:

### `get_current_tab`
Returns `{ url, title, lastUpdated, extensionConnected }`. Cheap and fast.
The extension is constantly pushing the active tab over WebSocket; the
server just reads the latest cached value. Use when the user refers to
"this page", "this tab", or "what I'm reading".

### `fetch_current_tab`
Returns the FULL content of the active tab as Markdown. Two modes:

- **`include_images: false`** (default) — text only. Returns headings,
  paragraphs, code blocks (with language hints), tables, lists, and links
  as Markdown. No truncation.

- **`include_images: true`** — text **and** images, interleaved by
  section. The response is an array of MCP content blocks like:

  ```
  [text:  "## Quick Start\n…prose…"]
  [image: PNG bytes — the screenshot under "Quick Start"]
  [text:  "## Configuration\n…prose…"]
  [image: PNG bytes — the diagram under "Configuration"]
  ```

  Order is the article's order. Each image block sits right after its
  section's text, so Claude knows which figure belongs to which heading
  without any `[Figure 1]` references or captions.

When the extension is connected, both modes extract from your browser's
live DOM via a content script. When it isn't, `include_images: false`
falls back to a server-side HTTP GET (public pages only); `include_images:
true` returns an error.

---

## What makes it good

### 1. Section-aligned images, encoded by position
MCP's tool result `content` array supports interleaved text/image/audio
blocks in any order, and hosts (including Claude Desktop) preserve that
order when feeding it to the model. We exploit this so that **section
alignment is a property of position in the response**, not metadata or
references. The model sees an image right after its section's text — same
as reading the article top-to-bottom. No prompting tricks, no schema
hacks, no captions to parse.

### 2. ~30× faster than v2.0 on a typical doc page — *same Markdown quality*
v2.0 fetched HTML server-side (HTTP GET + JSDOM parse). v2.1 reads
Chrome's already-rendered DOM directly. The HTTP round-trip and the
JSDOM-parse-1.3MB-of-HTML steps are gone entirely.

Concrete numbers from a Mintlify page (`code.claude.com/docs/en/agent-view`):

| Mode | v2.0 (server fetch) | v2.1 (extension live-DOM) |
|---|---|---|
| Text only | ~1237 ms | **~41 ms** |
| With images | n/a | ~600 ms – 1.2 s (parallel image fetches; mostly cache hits) |

The "30×" is for that specific page. Tiny pages: maybe 5×. Slow CDNs or
huge pages: easily 50×. The win is consistent because the time was
dominated by the network, and the network is now gone.

### 3. Auth pages and JS-rendered content just work
Server-side `fetch()` saw the public/login page for Gmail, and the
pre-hydration skeleton for React/Vue apps. The content script in the
extension sees what *you* see: post-JS DOM, your session cookies, lazy-
loaded images already resolved. Gmail, private GitHub READMEs, internal
dashboards, SPA-rendered docs — all in scope now.

### 4. Single source of truth for extraction
`server/src/pipeline.ts` exports `JUNK_SELECTORS`, `normalizeDom`,
`pickContentRoot`, and `makeTurndown`. The server's fallback path
imports it directly. The extension's content script bundles it via
esbuild. Same logic, two consumers. Change a junk selector once → both
paths pick it up after rebuilds. This was the highest-value architectural
decision in v2.1: it makes the codebase actually maintainable.

### 5. Graceful fallback
If the extension is disconnected (you turned it off, Chrome isn't
running, the tab is on `chrome://something`), `fetch_current_tab` with
the default `include_images: false` still works via server-side HTTP
GET. The output header indicates which path was used (`Source: extension`
vs the full `Status / Content-Type / Bytes / Fetched in` block from the
fallback). Failures are visible, not silent.

### 6. Honest hard limits, with position preserved
Image extraction caps: 20 images per response, 2 MB per image
(pre-base64), only images rendered ≥ 100×100 px inside the cleaned
content root. When a limit is hit (or a cross-origin CORS-blocked
auth-required image can't be fetched), we emit an inline placeholder
text block at that position: `[image omitted: <reason>]`. **Section
alignment is preserved even when we can't deliver the bytes.**

### 7. Faithful, near-lossless Markdown
We dropped Mozilla Readability in v2.0 because it's tuned for news
articles and silently destroys documentation pages (drops step
walkthroughs, undervalues code blocks, mistakes callouts for UI
widgets). Our pipeline instead surgically removes nav/footer/sidebar/ads
and applies site-specific normalizations (Mintlify, Docusaurus,
GitBook patterns). Result: no content silently dropped, headings and
code blocks intact, structure preserved.

---

## Architecture in 30 seconds

```
Claude Desktop ──MCP/stdio──> Node server ──WS:17321──> Chrome extension SW
                                  ▲                            │
                                  │                            │ chrome.scripting.executeScript
                                  │                            ▼
                                  │              content script in active tab
                                  │              (live DOM, post-JS)
                                  │                            │
                                  │              ┌─────────────┘
                                  │              │ shared pipeline:
                                  │              │   applyJunkSelectors
                                  │              │   normalizeDom
                                  │              │   pickContentRoot
                                  │              │   Turndown
                                  │              │ + image walker
                                  │              │   (Promise.all fetches)
                                  │              ▼
                                  └──── ContentBlock[]  (interleaved text+image)
```

The WebSocket is bidirectional. Extension → server: tab updates
(`{url, title}`) and keepalives. Server → extension: extraction requests
(`{type:"request", id, op:"extract", params:{includeImages}}`). Extension
→ server: matching responses (`{type:"response", id, ok, content, meta}`).

Fallback path (extension disconnected): server-side `fetch(url)` → JSDOM
→ same pipeline → Markdown text block. No images.

---

## Key design decisions, with their tradeoffs

### "Extend the existing tool with `include_images`, don't add a new one"
Considered: a separate `fetch_current_tab_with_images` tool. Rejected
because Claude already reads the tool description well enough to set the
flag based on phrasing ("walk me through this including the diagrams").
One tool, one mental model.

### "Move ALL extraction to the extension when connected, not just images"
Considered: hybrid where server does text and only images come from the
extension. Rejected because (a) it would require matching server's static-
HTML images to the live DOM's resolved URLs, (b) it leaves the auth-pages
and JS-rendered-content gaps unsolved, (c) it duplicates the pipeline.
The full move is simpler in the end and strictly more capable.

### "Pipeline lives in `server/src/pipeline.ts`, not top-level `shared/`"
Top-level `shared/` was the architectural ideal but would have required
changing the server's tsconfig `rootDir`, the `bin` path, and the user's
Claude Desktop config. Putting `pipeline.ts` inside `server/src/` keeps
the existing build paths and lets the extension import via esbuild
relative path. Same functional outcome (single source of truth), zero
config disruption.

### "Opt-in for images, not always-on"
Each image is ~1700+ vision tokens. A doc page with 10 images = ~17K
tokens before any text. We default to off and let Claude flip the flag
when the user's phrasing clearly wants visuals. Cheap by default,
explicit when it matters.

### "Min image side 100×100 rendered, content root only"
Filters out tracking pixels, decorative icons, avatars, and nav-bar
logos. Tuned conservatively — if real content gets dropped, lower to
80×80 (note in `extension/src/extractor.ts` near `MIN_RENDERED_SIDE`).

### "No screenshots (viewport or full-page)"
A viewport screenshot via `chrome.tabs.captureVisibleTab` would have
been simpler but only catches what's visible. Full-page via
`chrome.debugger` + DevTools Protocol catches everything but shows a
persistent "Tab Reader is debugging this browser" banner — too
intrusive. The interleaved-embedded-images approach gives Claude the
actual page assets with section context, at a fraction of the token cost
of a rasterized screenshot of the same page.

### "Local only, single user, no API keys"
No telemetry, no third-party calls, no MCP Registry publication. The
only network traffic the extension makes is to `localhost:17321` and the
image URLs the page itself already loaded. The server only fetches when
the extension is disconnected and the user is on a public page.

### "Never write to stdout in the server"
The MCP stdio transport uses stdout for JSON-RPC. A stray `console.log`
breaks the protocol and Claude Desktop loses the server silently. All
logging is `console.error`. This is *the* most common way to silently
break an MCP server — don't.

---

## Performance characteristics

| Scenario | Latency | Notes |
|---|---|---|
| `get_current_tab` | < 10 ms | Pure read of in-memory state. |
| `fetch_current_tab`, text-only, extension connected | ~100–350 ms | Live DOM read, no HTTP. ~30× faster than v2.0. |
| `fetch_current_tab`, text-only, fallback | ~300 ms – 1.5 s | Server HTTP GET + JSDOM. v2.0 behavior. |
| `fetch_current_tab`, with images (typical, ≤10 cached) | ~600 ms – 1.2 s | Parallel browser-cache fetches dominate. |
| `fetch_current_tab`, with images (heavy, 20 uncached) | ~3 – 10 s | Capped by 30 s server timeout. |

Why the image path stays bounded: parallel fetches via `Promise.all` (N
images don't multiply latency), browser cache hits dominate (the images
were already loaded to render the page), and hard limits on image count
and per-image size cap the worst case.

---

## Stack

- **Node 18+** with native `fetch` and `crypto.randomUUID`.
- **TypeScript 5** with `module: "Node16"`, strict mode.
- **`@modelcontextprotocol/sdk`** for the MCP server side.
- **`ws`** for the local WebSocket bridge.
- **`jsdom`** for the server-side fallback parse only (extension uses
  native DOM).
- **`turndown` + `turndown-plugin-gfm`** for HTML→Markdown.
- **`zod`** for the `include_images` parameter schema.
- **`esbuild`** for the extension bundle (one IIFE, ~37 KB).
- **Chrome MV3**, `minimum_chrome_version: 116` (the version that
  established WebSocket-keepalive-resets-SW-idle-timer behavior).

No build framework, no test runner (yet), no linter. Two `npm run build`
commands: `cd server && npm run build` (tsc) and
`cd extension && npm run build` (esbuild). Both fast (< 5 s).

---

## Repo layout (just the parts that matter)

```
tab-reader/
├── README.md                        # user setup
├── HANDOVER.md                      # editing handbook (read before changing code)
├── ABOUT.md                         # this file
├── server/
│   ├── src/
│   │   ├── index.ts                 # MCP server + WS server + fallback fetch
│   │   └── pipeline.ts              # SHARED extraction pipeline
│   └── build/
└── extension/
    ├── manifest.json                # MV3
    ├── background.js                # service worker (WS + scripting injection)
    ├── src/
    │   └── extractor.ts             # content-script extractor
    │                                  (imports ../../server/src/pipeline)
    └── dist/
        └── extractor.js             # esbuild bundle (committed)
```

Both `server/build/` and `extension/dist/` are committed so the repo is
clone-and-load-ready. Build outputs are the binaries the user runs;
sources are for editing.

---

## Status, known gaps, and what's deliberately out of scope

The full list lives in [HANDOVER.md](HANDOVER.md#known-gaps-good-first-prs).
In short:

- **Mintlify-style code blocks lose their language hint** when the
  `language="…"` attribute sits on a parent `<div>` rather than the
  `<code>`. Fix would live in `normalizeDom` or the `fenced-code-with-lang`
  Turndown rule.
- **Heading inline code formatting is lost** because `normalizeDom` does
  `h.textContent = …` to strip permalink anchors. Fix: walk children
  selectively instead.
- **Inline SVG and `<canvas>`** content aren't extracted as images.
  Would need serialization or rasterization. Defer.
- **Same-origin iframes are skipped.** The extractor runs in the top
  frame only. Defer until needed.
- **Cross-origin auth-required images without CORS** can't be fetched
  (page-context fails CORS; SW-context fallback bypasses CORS but loses
  cookies). Becomes a placeholder — section alignment preserved.
- **No caching.** Built-in `WebFetch` caches ~15 min; we don't.
  Probably not worth the complexity.

Deliberately out of scope: AI summarization in the server, output
truncation by default, multiple-tab tracking, full-page screenshot mode,
matching `WebFetch` output byte-for-byte.

---

## For the next agent

If you're picking this up cold, here's the shortest productive path:

1. **Read [HANDOVER.md](HANDOVER.md) first.** It has the architecture
   diagram, the WS protocol, the editing rules (esp. "never write to
   stdout"), and the change workflows. Without it you'll trip on
   invariants you can't see in the code.

2. **Skim the three source files** in this order:
   - `server/src/pipeline.ts` — small, the heart of the extraction.
   - `server/src/index.ts` — MCP tools, WS server, fallback path.
   - `extension/src/extractor.ts` — content-script image walker.

3. **Find the relevant gap or feature in HANDOVER's "Known gaps"
   section** before writing new code. The gaps describe the right
   place for a fix and often the right approach.

4. **Test by running the actual tools end-to-end.** Type-check passes
   and unit tests don't exist; the real validation is asking Claude
   Desktop "what tab am I on?", then "summarize this page", then "walk
   me through this with images". The HANDOVER's "How to verify
   everything works end-to-end" section has the full checklist.

5. **The plan file for v2.1 lives at**
   `~/.claude/plans/humble-tickling-church.md` — useful if you want to
   see how the v2.1 work was structured. Don't follow it as a recipe;
   it's now history.

### Things that look wrong but aren't

- **The extension imports a TypeScript file from the server's source
  tree** (`../../server/src/pipeline`). Not a bug — that's the
  single-source-of-truth design. esbuild bundles it.
- **The same image is sometimes fetched twice** (once by the page,
  once by us). Not a bug — `fetch(url, {credentials:"include"})` from
  the content script hits the browser cache, so the second fetch is
  ~free (< 50 ms).
- **The WebSocket carries both text strings and JSON.** Not a bug —
  `"keepalive"` and `"ack"` are intentionally plain strings (smaller,
  cheaper to parse). JSON messages have a `type` field. Legacy tab
  updates have `url`+`title` and no `type`.
- **`data-tr-id` attributes appear on `<img>` elements briefly during
  extraction.** Not a bug — they're added to live elements long enough
  to be copied into a clone, then immediately removed. The mutation is
  microseconds and invisible to the user.

### Common pitfalls

- **Forgetting to rebuild the extension** after a `pipeline.ts` change.
  The pipeline is bundled into `dist/extractor.js`. Server changes
  alone don't update the extension.
- **Forgetting to Cmd+Q + reopen Claude Desktop.** Closing the window
  isn't enough — Claude Desktop caches the tool list and the spawned
  server for the whole session.
- **Adding a permission to `manifest.json`.** Chrome will require the
  user to re-approve on next extension reload. Mention it in commit
  message and docs.
- **Using `console.log` in the server.** It will silently break the
  MCP protocol. Always `console.error`.

---

## Version history

See [HANDOVER.md → Version history](HANDOVER.md#version-history) for
the full lineage. The current major architectural era is **v2.1**:
extension-side extraction, shared pipeline, section-aligned images,
auth-pages and JS-rendered content supported.

---

## Repo

<https://github.com/edwin-anderson/tab-reader>
