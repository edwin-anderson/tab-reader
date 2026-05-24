#!/usr/bin/env node

/**
 * tab-reader MCP server (v2.0)
 *
 * Runs two things in one Node process:
 *   1. An MCP server over stdio (talks to Claude Desktop)
 *   2. A WebSocket server on port 17321 (the paired Chrome extension pushes
 *      tab updates here whenever the active tab changes)
 *
 * Shared state: `latestTab` — the most recent { url, title } the extension reported.
 *
 * IMPORTANT: never write to stdout. stdout is the MCP JSON-RPC channel.
 * All logging goes to stderr via console.error.
 *
 * Content extraction strategy:
 *   - DROP Readability entirely. It's designed for news articles and is hostile
 *     to documentation sites (e.g. Mintlify), where it strips step lists,
 *     callouts, and code-heavy sections because they score poorly on its
 *     content-density heuristic.
 *   - Instead: locate the main content root (<main> / <article> / <body>),
 *     surgically remove navigation/footer/sidebar/ads, normalize site-specific
 *     quirks (Mintlify step titles, heading permalinks), and hand the cleaned
 *     HTML to Turndown.
 *   - Result: faithful, near-lossless Markdown that preserves headings, code
 *     blocks (with language hints), tables, lists, and inline formatting,
 *     with no content silently dropped. Output is never truncated.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

// ---------- shared state ----------

interface TabInfo {
  url: string;
  title: string;
  updatedAt: string;
}

let latestTab: TabInfo | null = null;
let extensionConnected = false;

const WS_PORT = 17321;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 20_000;

// ---------- WebSocket server (talks to the Chrome extension) ----------

function startWebSocketServer() {
  const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });

  wss.on("listening", () => {
    console.error(`[tab-reader] WebSocket server listening on ws://127.0.0.1:${WS_PORT}`);
  });

  wss.on("connection", (socket: WebSocket) => {
    extensionConnected = true;
    console.error("[tab-reader] Chrome extension connected");

    socket.on("message", (raw) => {
      const text = raw.toString();

      if (text === "keepalive") {
        try {
          socket.send("ack");
        } catch {
          /* socket might be mid-close */
        }
        return;
      }

      try {
        const parsed = JSON.parse(text);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof parsed.url === "string" &&
          typeof parsed.title === "string"
        ) {
          latestTab = {
            url: parsed.url,
            title: parsed.title,
            updatedAt: new Date().toISOString(),
          };
          console.error(`[tab-reader] Tab updated: ${latestTab.title} — ${latestTab.url}`);
        } else {
          console.error("[tab-reader] Ignored malformed message:", parsed);
        }
      } catch (err) {
        console.error("[tab-reader] Failed to parse WS message:", err);
      }
    });

    socket.on("close", () => {
      extensionConnected = false;
      console.error("[tab-reader] Chrome extension disconnected");
    });

    socket.on("error", (err) => {
      console.error("[tab-reader] WS socket error:", err);
    });
  });

  wss.on("error", (err) => {
    console.error("[tab-reader] WebSocket server error:", err);
  });
}

// ---------- HTML → Markdown ----------

/**
 * Configure Turndown to produce high-fidelity Markdown:
 *   - ATX-style headings (#, ##, ###)
 *   - Fenced code blocks with language hints when available
 *   - GFM tables, strikethrough, task lists
 *   - Inline-style links
 *   - Clean <img> tags with just src + alt (drop srcset/sizes/data-* noise)
 */
function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    bulletListMarker: "*",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });

  td.use(gfm);

  // Drop noise tags. Using a filter function rather than .remove(["svg",...])
  // because some tag names aren't in TS's HTMLElementTagNameMap.
  const dropTags = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "IFRAME",
    "SVG",
    "LINK",
    "META",
  ]);
  td.addRule("drop-noise", {
    filter: (node) => dropTags.has(node.nodeName),
    replacement: () => "",
  });

  // <img>: emit a clean inline tag with just essential attributes.
  td.addRule("clean-img", {
    filter: "img",
    replacement: (_content, node) => {
      const el = node as unknown as {
        getAttribute(name: string): string | null;
      };
      const src = el.getAttribute("src") ?? "";
      if (!src) return "";
      const alt = (el.getAttribute("alt") ?? "").replace(/"/g, "&quot;");
      const w = el.getAttribute("width");
      const h = el.getAttribute("height");
      const dims = w && h ? ` width="${w}" height="${h}"` : "";
      return `<img src="${src}" alt="${alt}"${dims}>`;
    },
  });

  // <pre><code class="language-foo">...</code></pre> → fenced block with lang.
  td.addRule("fenced-code-with-lang", {
    filter: (node) => {
      if (node.nodeName !== "PRE") return false;
      const first = node.firstChild as { nodeName?: string } | null;
      return !!first && first.nodeName === "CODE";
    },
    replacement: (_content, node) => {
      const codeEl = (node as unknown as { firstChild: Element }).firstChild;
      const className = codeEl.getAttribute?.("class") ?? "";
      const langMatch = /language-([^\s]+)/.exec(className);
      const lang = langMatch ? langMatch[1] : "";
      const text = codeEl.textContent ?? "";
      const body = text.replace(/\n$/, "");
      return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
    },
  });

  return td;
}

const turndown = makeTurndown();

interface ExtractedContent {
  title: string | null;
  markdown: string;
  /** Which strategy succeeded: "main", "article", "body", or "fallback". */
  rootKind: string;
}

/**
 * Site-specific normalizations applied to the DOM before conversion.
 * Each is small and targeted; they never remove content that could be
 * meaningful, only restructure or strip noise.
 */
function normalizeDom(doc: Document): void {
  // Mintlify renders <Step title="Foo"> as a nested div tree where the title
  // ends up in a <p data-component-part="step-title">. Promote those to <h4>
  // so they survive as Markdown headings.
  doc.querySelectorAll('[data-component-part="step-title"]').forEach((el) => {
    const h = doc.createElement("h4");
    h.textContent = el.textContent ?? "";
    el.replaceWith(h);
  });

  // Many doc sites (Mintlify, Docusaurus, MkDocs) wrap heading text in
  // permalink <a> tags. Turndown then renders the heading as several lines
  // of brackets and arrows. Replace each heading's content with plain text.
  for (let level = 1; level <= 6; level++) {
    doc.querySelectorAll(`h${level}`).forEach((h) => {
      const text = (h.textContent ?? "")
        .replace(/\s+/g, " ")
        .replace(/\u200B/g, "") // zero-width space
        .trim();
      h.textContent = text;
    });
  }

  // Some Mintlify pages use <span data-as="p"> instead of <p>. Convert so
  // Markdown sees them as proper paragraphs.
  doc.querySelectorAll('span[data-as="p"]').forEach((el) => {
    const p = doc.createElement("p");
    p.innerHTML = el.innerHTML;
    el.replaceWith(p);
  });
}

/**
 * Selectors for elements that are almost always noise.
 * Kept conservative — we want to keep all real content.
 */
const JUNK_SELECTORS = [
  // standard noise
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "link",
  "meta",
  // site chrome
  "nav",
  "header > nav",
  "footer",
  "aside",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[role='complementary']",
  "[aria-hidden='true']",
  ".sidebar",
  ".toc",
  ".table-of-contents",
  ".breadcrumb",
  ".skip-link",
  ".cookie-banner",
  ".newsletter",
  "[class*='advertisement']",
  "[class*='social-share']",
  // heading permalinks (Mintlify, Docusaurus, etc.)
  "a.header-anchor",
  "a[href^='#'][aria-label*='ermalink']",
  // Mintlify step number badges / rails (rendered icons, no text content)
  "[data-component-part='step-number']",
  "[data-component-part='step-rail']",
  "[data-component-part='step-marker']",
];

function extractContent(html: string, url: string): ExtractedContent {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // Strip universally-junk elements first (these are NEVER content).
  for (const sel of JUNK_SELECTORS) {
    doc.querySelectorAll(sel).forEach((n) => n.remove());
  }

  // Site-specific DOM normalizations (Mintlify, etc.).
  normalizeDom(doc);

  // Pick the main content root, in priority order.
  let rootKind = "fallback";
  let root: Element | null = doc.querySelector("main");
  if (root) {
    rootKind = "main";
  } else {
    root = doc.querySelector("article");
    if (root) {
      rootKind = "article";
    } else {
      root = doc.querySelector("[role='main']");
      if (root) {
        rootKind = "role-main";
      } else {
        root = doc.querySelector("#content") ?? doc.querySelector(".content");
        if (root) {
          rootKind = "id-content";
        } else {
          root = doc.body;
          rootKind = "body";
        }
      }
    }
  }

  const title =
    doc.title?.trim() ||
    doc.querySelector("h1")?.textContent?.trim() ||
    null;

  const htmlToConvert = root ? root.innerHTML : "";
  const rawMd = turndown.turndown(htmlToConvert).trim();

  // Post-process: collapse extra blank lines, strip zero-width spaces.
  const markdown = rawMd
    .replace(/\u200B/g, "") // zero-width space
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, markdown, rootKind };
}

// ---------- fetch + extract ----------

interface FetchResult {
  status: number;
  contentType: string;
  bytes: number;
  durationMs: number;
  extracted: ExtractedContent | null;
  rawText: string | null;
}

async function fetchAndExtract(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const durationMs = Date.now() - started;

    if (!response.ok) {
      return {
        status: response.status,
        contentType,
        bytes: body.length,
        durationMs,
        extracted: null,
        rawText: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
      const extracted = extractContent(body, url);
      return {
        status: response.status,
        contentType,
        bytes: body.length,
        durationMs,
        extracted,
        rawText: null,
      };
    }

    // Non-HTML: return as-is (plain text, JSON, XML, etc.).
    return {
      status: response.status,
      contentType,
      bytes: body.length,
      durationMs,
      extracted: null,
      rawText: body,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- MCP server (talks to Claude Desktop) ----------

const server = new McpServer({
  name: "tab-reader",
  version: "2.0.0",
});

server.registerTool(
  "get_current_tab",
  {
    description:
      "Returns the URL and title of the browser tab the user is currently looking at. " +
      "Use this when the user refers to 'this page', 'this tab', 'what I'm reading', " +
      "or otherwise expects you to know what they have open in their browser. " +
      "Cheap and fast — does not fetch the page content. Pair with fetch_current_tab " +
      "when the user wants the actual content of the page. " +
      "Requires the paired Chrome extension to be installed and Chrome to be running.",
    inputSchema: {},
  },
  async () => {
    if (!latestTab) {
      const hint = extensionConnected
        ? "The Chrome extension is connected but hasn't reported a tab yet."
        : "The Chrome extension isn't connected.";
      return {
        content: [{ type: "text", text: `No tab info available. ${hint}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              url: latestTab.url,
              title: latestTab.title,
              lastUpdated: latestTab.updatedAt,
              extensionConnected,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "fetch_current_tab",
  {
    description:
      "Fetches the FULL content of the browser tab the user is currently looking at, " +
      "as high-fidelity Markdown. Use this whenever the user asks about, refers to, " +
      "wants to discuss, summarize, or learn from the page they have open " +
      "(e.g. 'what is this page about', 'summarize this', 'explain this section', " +
      "'what does this article say'). Does NOT need a URL argument — it always fetches " +
      "whatever tab the user currently has active. " +
      "Output preserves structure: headings (#, ##), code blocks with language hints, " +
      "lists, tables, links, and inline formatting. No truncation. " +
      "Performs a server-side HTTP GET, so it only works for publicly accessible pages " +
      "(no logged-in content, intranet, or chrome:// pages).",
    inputSchema: {},
  },
  async () => {
    if (!latestTab) {
      const hint = extensionConnected
        ? "The Chrome extension is connected but hasn't reported a tab yet."
        : "The Chrome extension isn't connected.";
      return {
        content: [{ type: "text", text: `No tab info available. ${hint}` }],
        isError: true,
      };
    }

    const url = latestTab.url;
    if (!/^https?:\/\//i.test(url)) {
      return {
        content: [
          {
            type: "text",
            text:
              `Can't fetch ${url} — only http(s) URLs are supported. ` +
              `Pages like chrome://, file://, or extension pages aren't reachable from ` +
              `a server-side fetch. The user is currently on "${latestTab.title}".`,
          },
        ],
        isError: true,
      };
    }

    try {
      console.error(`[tab-reader] Fetching: ${url}`);
      const result = await fetchAndExtract(url);
      console.error(
        `[tab-reader] Fetched ${url} — ${result.status} ${result.contentType}, ` +
          `${result.bytes} bytes, ${result.durationMs}ms` +
          (result.extracted ? ` (root: ${result.extracted.rootKind})` : ""),
      );

      const headerLines = [
        `URL: ${url}`,
        `Title: ${result.extracted?.title ?? latestTab.title}`,
        `Status: ${result.status}`,
        `Content-Type: ${result.contentType || "unknown"}`,
        `Bytes: ${result.bytes}`,
        `Fetched in: ${result.durationMs}ms`,
      ];
      if (result.extracted) {
        headerLines.push(`Root: <${result.extracted.rootKind}>`);
      }

      const body =
        result.extracted?.markdown ?? result.rawText ?? "(no content extracted)";

      const responseText = [headerLines.join("\n"), "", "---", "", body].join("\n");

      return {
        content: [{ type: "text", text: responseText }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tab-reader] Fetch failed for ${url}: ${message}`);
      return {
        content: [
          {
            type: "text",
            text:
              `Failed to fetch ${url}: ${message}. ` +
              `This may mean the page requires login, is blocked by the server, ` +
              `or is on a private network. The user is currently on "${latestTab.title}".`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ---------- bootstrap ----------

async function main() {
  startWebSocketServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[tab-reader] MCP server connected on stdio (v2.0.0)");
}

main().catch((err) => {
  console.error("[tab-reader] Fatal error:", err);
  process.exit(1);
});
