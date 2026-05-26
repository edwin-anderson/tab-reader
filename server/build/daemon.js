/**
 * tab-reader daemon
 *
 * Long-running process started by launchd (com.tab-reader.daemon
 * LaunchAgent). Owns three things on 127.0.0.1:17321:
 *
 *   1. WebSocket on `/`     — the Chrome extension dials in here and
 *                              pushes tab updates + answers extraction
 *                              requests we send back.
 *   2. WebSocket on `/mcp`  — each Claude app spawns a thin bridge
 *                              process that connects here; the daemon
 *                              instantiates a fresh per-bridge McpServer
 *                              wired to a custom WebSocketServerTransport.
 *                              Tool handlers close over the daemon's
 *                              module-scope state so all bridges share
 *                              the same view of the extension and tab.
 *   3. HTTP GET /status     — quick health probe (PID, extension state,
 *                              bridge count) used by `npm run status-daemon`.
 *
 * Shared state: `latestTab`, `extensionConnected`, `extensionSocket`,
 * `pendingRequests`, `bridgeConnections`. Everything tools care about
 * lives here at module scope, which is what makes the daemon a single
 * source of truth across multiple Claude clients.
 *
 * IMPORTANT: never write to stdout. The bridge processes use stdout for
 * MCP JSON-RPC. The daemon doesn't speak stdio MCP at all — but to keep
 * the rule consistent across the binary, all logs use stderr.
 *
 * Content extraction strategy: unchanged from v2.1. See `pipeline.ts`
 * for the shared rules; this file just orchestrates the
 * extension-vs-server-fetch decision per tool call.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebSocketServer, WebSocket } from "ws";
import { JSDOM } from "jsdom";
import { z } from "zod";
import { applyJunkSelectors, makeTurndown, normalizeDom, pickContentRoot, } from "./pipeline.js";
let latestTab = null;
let extensionConnected = false;
let extensionSocket = null;
const pendingRequests = new Map();
const bridgeConnections = new Set();
const startedAt = Date.now();
const WS_PORT = 17321;
const EXTRACTION_TIMEOUT_MS = 30_000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
const VERSION = "3.0.0";
// ---------- extension WebSocket handler (path "/") ----------
function handleExtensionConnection(socket) {
    if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
        console.error("[tab-reader] New extension connection arrived; closing the previous one.");
        try {
            extensionSocket.close();
        }
        catch {
            /* ignore */
        }
    }
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
            console.error("[tab-reader] Failed to parse extension WS message:", err);
            return;
        }
        if (typeof parsed !== "object" || parsed === null) {
            console.error("[tab-reader] Ignored non-object extension message");
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
        console.error("[tab-reader] Ignored malformed extension message:", msg);
    });
    socket.on("close", () => {
        if (extensionSocket === socket) {
            extensionConnected = false;
            extensionSocket = null;
            for (const [id, pending] of pendingRequests) {
                clearTimeout(pending.timer);
                pending.reject(new Error("Extension disconnected before responding"));
                pendingRequests.delete(id);
            }
            console.error("[tab-reader] Chrome extension disconnected");
        }
    });
    socket.on("error", (err) => {
        console.error("[tab-reader] Extension WS error:", err);
    });
}
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
// ---------- HTML → Markdown (server-side fallback) ----------
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
// ---------- tool registration (run per /mcp connection) ----------
function registerTools(server) {
    server.registerTool("fetch_current_tab", {
        description: "Fetches the FULL content of the browser tab the user is currently looking at, " +
            "as high-fidelity Markdown. Use this whenever the user asks about, refers to, " +
            "wants to discuss, summarize, or learn from the page they have open " +
            "(e.g. 'what is this page about', 'summarize this', 'explain this section', " +
            "'what does this article say'). Also use when the user asks 'what tab am I on?', " +
            "'what URL is this?', or just wants the page title — the response header always " +
            "includes URL and title. Skip for incidental mentions, hypotheticals, or " +
            "follow-ups on already-extracted content. " +
            "Does NOT need a URL argument — it always fetches " +
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
}
// ---------- bridge transport (MCP over WebSocket on /mcp) ----------
/**
 * A minimal MCP Transport that wraps a single ws WebSocket.
 *
 * Listeners are attached in the constructor (not in start()) so any
 * messages that arrive before McpServer.connect() finishes setting up
 * handlers get buffered and drained from start(). Without this, the
 * SDK's connect → handshake → setRequestHandler chain has a window
 * during which inbound 'initialize' could be silently dropped.
 */
class WebSocketServerTransport {
    socket;
    onclose;
    onerror;
    onmessage;
    sessionId;
    buffered = [];
    started = false;
    constructor(socket) {
        this.socket = socket;
        socket.on("message", (raw) => {
            const text = raw.toString().trim();
            if (text.length === 0)
                return;
            let parsed;
            try {
                parsed = JSON.parse(text);
            }
            catch (err) {
                this.onerror?.(err instanceof Error ? err : new Error(String(err)));
                return;
            }
            if (this.started) {
                this.onmessage?.(parsed);
            }
            else {
                this.buffered.push(parsed);
            }
        });
        socket.on("close", () => {
            this.onclose?.();
        });
        socket.on("error", (err) => {
            this.onerror?.(err);
        });
    }
    async start() {
        this.started = true;
        while (this.buffered.length > 0) {
            const msg = this.buffered.shift();
            this.onmessage?.(msg);
        }
    }
    async send(message) {
        if (this.socket.readyState !== WebSocket.OPEN)
            return;
        this.socket.send(JSON.stringify(message));
    }
    async close() {
        try {
            this.socket.close();
        }
        catch {
            /* already closed */
        }
    }
}
function handleBridgeConnection(socket) {
    bridgeConnections.add(socket);
    console.error(`[tab-reader] Bridge connected (${bridgeConnections.size} active)`);
    const server = new McpServer({ name: "tab-reader", version: VERSION });
    registerTools(server);
    const transport = new WebSocketServerTransport(socket);
    socket.on("close", () => {
        bridgeConnections.delete(socket);
        console.error(`[tab-reader] Bridge disconnected (${bridgeConnections.size} active)`);
    });
    server.connect(transport).catch((err) => {
        console.error("[tab-reader] McpServer.connect failed for bridge:", err);
        try {
            socket.close();
        }
        catch {
            /* already closed */
        }
    });
}
// ---------- HTTP /status endpoint ----------
function handleHttpRequest(req, res) {
    if (req.method === "GET" && (req.url === "/status" || req.url === "/status/")) {
        const body = JSON.stringify({
            version: VERSION,
            port: WS_PORT,
            uptime: (Date.now() - startedAt) / 1000,
            extensionConnected,
            latestTab,
            pendingRequests: pendingRequests.size,
            bridgeConnections: bridgeConnections.size,
        });
        res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        });
        res.end(body);
        return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found\n");
}
// ---------- bootstrap ----------
export function runDaemon() {
    const httpServer = http.createServer(handleHttpRequest);
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
        const url = req.url ?? "/";
        if (url === "/mcp" || url.startsWith("/mcp?") || url.startsWith("/mcp/")) {
            wss.handleUpgrade(req, socket, head, (ws) => {
                handleBridgeConnection(ws);
            });
        }
        else if (url === "/" || url.startsWith("/?")) {
            wss.handleUpgrade(req, socket, head, (ws) => {
                handleExtensionConnection(ws);
            });
        }
        else {
            // Unknown path — reject the upgrade with a 404.
            socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
            socket.destroy();
        }
    });
    httpServer.on("error", (err) => {
        const code = err.code;
        if (code === "EADDRINUSE") {
            console.error(`[tab-reader] Port ${WS_PORT} already in use; another daemon is running. Exiting to let launchd retry.`);
            process.exit(1);
        }
        console.error("[tab-reader] HTTP server error:", err);
    });
    httpServer.listen(WS_PORT, "127.0.0.1", () => {
        console.error(`[tab-reader] Daemon listening on http://127.0.0.1:${WS_PORT} (v${VERSION})`);
    });
    function shutdown(signal) {
        console.error(`[tab-reader] ${signal} received, shutting down cleanly`);
        for (const ws of bridgeConnections) {
            try {
                ws.close();
            }
            catch {
                /* ignore */
            }
        }
        if (extensionSocket) {
            try {
                extensionSocket.close();
            }
            catch {
                /* ignore */
            }
        }
        httpServer.close(() => process.exit(0));
        // Don't wait forever; force exit after 2s.
        setTimeout(() => process.exit(0), 2_000).unref();
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}
