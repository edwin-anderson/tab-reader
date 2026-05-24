#!/usr/bin/env node
/**
 * tab-reader MCP server
 *
 * Runs two things in one Node process:
 *   1. An MCP server over stdio (talks to Claude Desktop)
 *   2. A WebSocket server on port 17321 (the paired Chrome extension pushes
 *      tab updates here whenever the active tab changes; the server can also
 *      send extraction requests to the extension over this socket)
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
 *   - The pipeline lives in ./pipeline.ts and is shared with the extension's
 *     content script (bundled by esbuild). Single source of truth.
 *   - Server path (this file): fetch HTML → jsdom → apply pipeline → Markdown.
 *     Used as fallback when the extension is disconnected, or when the caller
 *     does not request images.
 *   - Extension path: live DOM → apply pipeline → interleaved text+image blocks.
 *     Used when include_images=true (auth pages, JS-rendered, lazy-loaded).
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { JSDOM } from "jsdom";
import { z } from "zod";
import { applyJunkSelectors, makeTurndown, normalizeDom, pickContentRoot, } from "./pipeline.js";
let latestTab = null;
let extensionConnected = false;
let extensionSocket = null;
const pendingRequests = new Map();
const WS_PORT = 17321;
const EXTRACTION_TIMEOUT_MS = 30_000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
// ---------- WebSocket server (talks to the Chrome extension) ----------
function startWebSocketServer() {
    const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });
    wss.on("listening", () => {
        console.error(`[tab-reader] WebSocket server listening on ws://127.0.0.1:${WS_PORT}`);
    });
    wss.on("connection", (socket) => {
        extensionConnected = true;
        extensionSocket = socket;
        console.error("[tab-reader] Chrome extension connected");
        socket.on("message", (raw) => {
            const text = raw.toString();
            if (text === "keepalive") {
                try {
                    socket.send("ack");
                }
                catch {
                    /* socket might be mid-close */
                }
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(text);
            }
            catch (err) {
                console.error("[tab-reader] Failed to parse WS message:", err);
                return;
            }
            if (typeof parsed !== "object" || parsed === null) {
                console.error("[tab-reader] Ignored non-object message");
                return;
            }
            const msg = parsed;
            // Response to a server-initiated extraction request.
            if (msg.type === "response" && typeof msg.id === "string") {
                const pending = pendingRequests.get(msg.id);
                if (!pending) {
                    console.error(`[tab-reader] Response for unknown request id: ${msg.id}`);
                    return;
                }
                clearTimeout(pending.timer);
                pendingRequests.delete(msg.id);
                if (msg.ok) {
                    const content = Array.isArray(msg.content) ? msg.content : [];
                    const meta = msg.meta && typeof msg.meta === "object" ? msg.meta : {};
                    pending.resolve({ content, meta });
                }
                else {
                    const err = typeof msg.error === "string" ? msg.error : "Extension reported failure";
                    pending.reject(new Error(err));
                }
                return;
            }
            // Tab update (legacy shape: { url, title } with no `type` field).
            if (typeof msg.url === "string" && typeof msg.title === "string") {
                latestTab = {
                    url: msg.url,
                    title: msg.title,
                    updatedAt: new Date().toISOString(),
                };
                console.error(`[tab-reader] Tab updated: ${latestTab.title} — ${latestTab.url}`);
                return;
            }
            console.error("[tab-reader] Ignored malformed message:", msg);
        });
        socket.on("close", () => {
            extensionConnected = false;
            if (extensionSocket === socket)
                extensionSocket = null;
            // Reject any in-flight extraction requests; the extension can't answer them now.
            for (const [id, pending] of pendingRequests) {
                clearTimeout(pending.timer);
                pending.reject(new Error("Extension disconnected before responding"));
                pendingRequests.delete(id);
            }
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
/**
 * Ask the connected extension to extract the current tab's content.
 * Sends a request over the WebSocket and awaits the matching response by id.
 * Rejects if the extension is not connected, the timeout elapses, or the
 * extension reports a failure.
 */
function requestExtraction(includeImages) {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("Extension not connected"));
    }
    const id = randomUUID();
    const socket = extensionSocket;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`Extension request timed out after ${EXTRACTION_TIMEOUT_MS}ms`));
        }, EXTRACTION_TIMEOUT_MS);
        pendingRequests.set(id, { resolve, reject, timer });
        try {
            socket.send(JSON.stringify({
                type: "request",
                id,
                op: "extract",
                params: { includeImages },
            }));
        }
        catch (err) {
            clearTimeout(timer);
            pendingRequests.delete(id);
            reject(err);
        }
    });
}
// ---------- HTML → Markdown (server-side path, used when the extension is offline) ----------
const turndown = makeTurndown();
function extractContent(html, url) {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;
    applyJunkSelectors(doc);
    normalizeDom(doc);
    const { root, kind: rootKind } = pickContentRoot(doc);
    const title = doc.title?.trim() ||
        doc.querySelector("h1")?.textContent?.trim() ||
        null;
    const rawMd = turndown.turndown(root.innerHTML).trim();
    // Post-process: collapse extra blank lines, strip zero-width spaces.
    const markdown = rawMd
        .replace(/​/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return { title, markdown, rootKind };
}
async function fetchAndExtract(url) {
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
    }
    finally {
        clearTimeout(timer);
    }
}
// ---------- MCP server (talks to Claude Desktop) ----------
const server = new McpServer({
    name: "tab-reader",
    version: "2.1.0",
});
server.registerTool("get_current_tab", {
    description: "Returns the URL and title of the browser tab the user is currently looking at. " +
        "Use this when the user refers to 'this page', 'this tab', 'what I'm reading', " +
        "or otherwise expects you to know what they have open in their browser. " +
        "Cheap and fast — does not fetch the page content. Pair with fetch_current_tab " +
        "when the user wants the actual content of the page. " +
        "Requires the paired Chrome extension to be installed and Chrome to be running.",
    inputSchema: {},
}, async () => {
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
                text: JSON.stringify({
                    url: latestTab.url,
                    title: latestTab.title,
                    lastUpdated: latestTab.updatedAt,
                    extensionConnected,
                }, null, 2),
            },
        ],
    };
});
server.registerTool("fetch_current_tab", {
    description: "Fetches the FULL content of the browser tab the user is currently looking at, " +
        "as high-fidelity Markdown. Use this whenever the user asks about, refers to, " +
        "wants to discuss, summarize, or learn from the page they have open " +
        "(e.g. 'what is this page about', 'summarize this', 'explain this section', " +
        "'what does this article say'). Does NOT need a URL argument — it always fetches " +
        "whatever tab the user currently has active. " +
        "Output preserves structure: headings (#, ##), code blocks with language hints, " +
        "lists, tables, links, and inline formatting. No truncation. " +
        "Set include_images=true when the user wants Claude to actually see the images " +
        "embedded in the page (screenshots, diagrams, figures). Images are returned " +
        "interleaved with the article text in section-aligned order — each image appears " +
        "in the response right after the text of its section. Requires the Chrome " +
        "extension to be connected; works on logged-in pages and JS-rendered content. " +
        "Default false (text-only). With include_images=false this performs a server-side " +
        "HTTP GET and only works for publicly accessible pages.",
    inputSchema: {
        include_images: z
            .boolean()
            .optional()
            .default(false)
            .describe("When true, return images embedded in the page interleaved with the article " +
            "text in section-aligned order. Requires the Chrome extension to be connected."),
    },
}, async (args) => {
    const includeImages = args?.include_images === true;
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
                    text: `Can't fetch ${url} — only http(s) URLs are supported. ` +
                        `Pages like chrome://, file://, or extension pages aren't reachable. ` +
                        `The user is currently on "${latestTab.title}".`,
                },
            ],
            isError: true,
        };
    }
    // Prefer the extension path whenever it's connected — it works on
    // logged-in pages, JS-rendered content, and lazy-loaded images. The
    // server-side fetch path below is the fallback for when it isn't.
    if (extensionConnected) {
        try {
            console.error(`[tab-reader] Requesting extraction from extension (includeImages=${includeImages}) for ${url}`);
            const started = Date.now();
            const { content: extracted, meta } = await requestExtraction(includeImages);
            const durationMs = Date.now() - started;
            const actualUrl = meta.url ?? url;
            const actualTitle = meta.title ?? latestTab.title;
            console.error(`[tab-reader] Extraction returned ${extracted.length} block(s) in ${durationMs}ms` +
                (meta.rootKind ? ` (root: ${meta.rootKind})` : ""));
            const headerLines = [
                `URL: ${actualUrl}`,
                `Title: ${actualTitle}`,
                `Source: extension`,
                `Mode: include_images=${includeImages}`,
                `Extracted in: ${durationMs}ms`,
            ];
            if (meta.rootKind)
                headerLines.push(`Root: <${meta.rootKind}>`);
            if (actualUrl !== url) {
                headerLines.push(`Note: active tab changed during extraction (server expected ${url}; extracted ${actualUrl}).`);
            }
            const header = {
                type: "text",
                text: headerLines.join("\n") + "\n\n---\n",
            };
            return { content: [header, ...extracted] };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[tab-reader] Extension extraction failed: ${message}`);
            if (includeImages) {
                // Images can only be sourced from the extension — no fallback possible.
                return {
                    content: [
                        {
                            type: "text",
                            text: `Extension extraction failed: ${message}. ` +
                                `Retry, or call without include_images for text-only via server-side fetch.`,
                        },
                    ],
                    isError: true,
                };
            }
            // Text-only: fall through to server-side fetch.
            console.error(`[tab-reader] Falling back to server-side fetch`);
        }
    }
    else if (includeImages) {
        return {
            content: [
                {
                    type: "text",
                    text: `include_images=true requires the Chrome extension to be connected, ` +
                        `but it isn't right now. Either ask the user to enable the extension, ` +
                        `or retry without include_images (text-only, via server-side fetch).`,
                },
            ],
            isError: true,
        };
    }
    try {
        console.error(`[tab-reader] Fetching: ${url}`);
        const result = await fetchAndExtract(url);
        console.error(`[tab-reader] Fetched ${url} — ${result.status} ${result.contentType}, ` +
            `${result.bytes} bytes, ${result.durationMs}ms` +
            (result.extracted ? ` (root: ${result.extracted.rootKind})` : ""));
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
        const body = result.extracted?.markdown ?? result.rawText ?? "(no content extracted)";
        const responseText = [headerLines.join("\n"), "", "---", "", body].join("\n");
        return {
            content: [{ type: "text", text: responseText }],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[tab-reader] Fetch failed for ${url}: ${message}`);
        return {
            content: [
                {
                    type: "text",
                    text: `Failed to fetch ${url}: ${message}. ` +
                        `This may mean the page requires login, is blocked by the server, ` +
                        `or is on a private network. The user is currently on "${latestTab.title}".`,
                },
            ],
            isError: true,
        };
    }
});
// ---------- bootstrap ----------
async function main() {
    startWebSocketServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[tab-reader] MCP server connected on stdio (v2.1.0)");
}
main().catch((err) => {
    console.error("[tab-reader] Fatal error:", err);
    process.exit(1);
});
