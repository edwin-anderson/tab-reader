/**
 * tab-reader Chrome extension — background service worker
 *
 * Connects to ws://127.0.0.1:17321 (the local tab-reader MCP server) and
 * pushes { url, title } whenever the active tab changes.
 *
 * MV3 notes (per https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets):
 *   - Service workers go idle after 30s of inactivity.
 *   - WebSocket message activity (send OR receive) resets that timer in Chrome 116+.
 *   - So we send a "keepalive" ping every 20s while the socket is open.
 *   - All state in this worker is ephemeral. On wake we just re-open the socket.
 */

const WS_URL = "ws://127.0.0.1:17321";
const KEEPALIVE_IDLE_MS = 20_000;
const KEEPALIVE_BUSY_MS = 10_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let webSocket = null;
let keepAliveIntervalId = null;
let reconnectDelay = RECONNECT_INITIAL_MS;
let reconnectTimeoutId = null;
let inFlightCount = 0;

// ---------- socket lifecycle ----------

function connect() {
  if (
    webSocket &&
    (webSocket.readyState === WebSocket.OPEN ||
      webSocket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  try {
    webSocket = new WebSocket(WS_URL);
  } catch (err) {
    console.error("[tab-reader] Failed to construct WebSocket:", err);
    scheduleReconnect();
    return;
  }

  webSocket.onopen = () => {
    console.log("[tab-reader] WebSocket open");
    reconnectDelay = RECONNECT_INITIAL_MS;
    startKeepAlive();
    // Push the current active tab right away so Claude has something to work with.
    pushActiveTab();
  };

  webSocket.onmessage = (event) => {
    const text = typeof event.data === "string" ? event.data : "";
    // "ack" is the server's reply to our keepalive — keeps the SW idle timer
    // reset on inbound traffic too. Nothing else to do.
    if (text === "ack") return;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn("[tab-reader] Ignored non-JSON message:", text);
      return;
    }
    if (!parsed || typeof parsed !== "object") return;

    if (parsed.type === "request" && typeof parsed.id === "string") {
      handleRequest(parsed).then(
        (response) => send(response),
        (err) => {
          send({
            type: "response",
            id: parsed.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    }
  };

  webSocket.onclose = () => {
    console.log("[tab-reader] WebSocket closed");
    stopKeepAlive();
    webSocket = null;
    scheduleReconnect();
  };

  webSocket.onerror = (err) => {
    console.warn("[tab-reader] WebSocket error:", err);
    // onclose will fire right after; reconnect is handled there.
  };
}

function startKeepAlive(intervalMs = KEEPALIVE_IDLE_MS) {
  stopKeepAlive();
  keepAliveIntervalId = setInterval(() => {
    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
      webSocket.send("keepalive");
    } else {
      stopKeepAlive();
    }
  }, intervalMs);
}

/**
 * While extraction requests are in flight, tighten the keepalive to 10s.
 * Image fetching for cross-origin assets can exceed the 30s MV3 service
 * worker idle threshold; the faster keepalive keeps the SW alive long enough
 * for the work to finish.
 */
function intensifyKeepAlive() {
  inFlightCount++;
  if (inFlightCount === 1) startKeepAlive(KEEPALIVE_BUSY_MS);
}

function relaxKeepAlive() {
  inFlightCount = Math.max(0, inFlightCount - 1);
  if (inFlightCount === 0) startKeepAlive(KEEPALIVE_IDLE_MS);
}

function stopKeepAlive() {
  if (keepAliveIntervalId !== null) {
    clearInterval(keepAliveIntervalId);
    keepAliveIntervalId = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimeoutId !== null) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    connect();
  }, delay);
}

function send(payload) {
  if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
    // Not connected — trigger a connect; the onopen handler will push the
    // current tab on its own, so we don't need to queue anything.
    connect();
    return;
  }
  try {
    webSocket.send(JSON.stringify(payload));
  } catch (err) {
    console.warn("[tab-reader] Failed to send:", err);
  }
}

// ---------- image fetch fallback (called from content script) ----------

const MAX_BYTES_PER_IMAGE = 2 * 1024 * 1024;

/**
 * Content script calls this when its in-page fetch fails (typically CORS).
 * The SW fetch uses the extension's origin so it bypasses CORS on cross-origin
 * images — at the cost of losing the user's cookies. Acceptable for public
 * CDN assets, fails (and is reported) for auth-gated cross-origin images.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "fetchImage" || typeof msg.url !== "string") return;
  fetchImageInBg(msg.url, msg.maxBytes || MAX_BYTES_PER_IMAGE)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // keep the channel open for the async response
});

async function fetchImageInBg(url, maxBytes) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  if (blob.size > maxBytes) {
    throw new Error(`image exceeds ${maxBytes} bytes (${blob.size})`);
  }
  const data = await blobToBase64Bg(blob);
  return { data, mimeType: blob.type || "image/png" };
}

function blobToBase64Bg(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader did not return a string"));
        return;
      }
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------- server-initiated request handling ----------

const EXTRACTOR_FILE = "dist/extractor.js";

async function handleRequest(req) {
  if (req.op === "extract") {
    const params = (req.params && typeof req.params === "object") ? req.params : {};
    const includeImages = params.includeImages === true;
    intensifyKeepAlive();
    try {
      const result = await runExtractor({ includeImages });
      return {
        type: "response",
        id: req.id,
        ok: true,
        content: result.content,
        meta: {
          rootKind: result.rootKind,
          url: result.url,
          title: result.title,
        },
      };
    } catch (err) {
      console.warn("[tab-reader] Extraction failed:", err);
      return {
        type: "response",
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      relaxKeepAlive();
    }
  }
  return {
    type: "response",
    id: req.id,
    ok: false,
    error: `Unknown op: ${req.op}`,
  };
}

/**
 * Two-step content-script injection:
 *   1. Load the bundled extractor; its IIFE assigns window.__tabReader.
 *   2. Call window.__tabReader.extract(params) and return the result.
 * Both injections use world="ISOLATED" so they share the same isolated world
 * (per Chrome docs: content scripts from the same extension share a world per
 * frame). Re-running step 1 is safe and idempotent — the bundle just
 * re-assigns window.__tabReader, which is what we want when the page has
 * navigated since the last call.
 */
async function runExtractor(params) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || typeof tab.id !== "number") {
    throw new Error("No active tab to extract from");
  }
  if (tab.url && /^(chrome|edge|brave|about|chrome-extension):/i.test(tab.url)) {
    throw new Error(`Cannot inject into browser-internal page: ${tab.url}`);
  }

  // Step 1 of 2: load the extractor bundle.
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: [EXTRACTOR_FILE],
    world: "ISOLATED",
  });

  // Step 2 of 2: call extract(params) and return its result.
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: (args) => {
      const tr = window.__tabReader;
      if (!tr || typeof tr.extract !== "function") {
        throw new Error("__tabReader.extract not present after bundle load");
      }
      return tr.extract(args);
    },
    args: [params],
  });

  const result = results && results[0] && results[0].result;
  if (!result || !Array.isArray(result.content)) {
    throw new Error("Extractor returned an invalid result");
  }
  return result;
}

// ---------- tab tracking ----------

async function pushActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!tab || !tab.url) return;
    send({
      url: tab.url,
      title: tab.title ?? "",
    });
  } catch (err) {
    console.warn("[tab-reader] Failed to query active tab:", err);
  }
}

// Tab switched within a window.
chrome.tabs.onActivated.addListener(() => {
  pushActiveTab();
});

// URL or title changed in the active tab (navigation, SPA route change, etc.).
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
    pushActiveTab();
  }
});

// User switched windows (focus changed).
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  pushActiveTab();
});

// ---------- boot ----------

chrome.runtime.onInstalled.addListener(() => {
  console.log("[tab-reader] Extension installed");
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[tab-reader] Chrome started");
  connect();
});

// Also connect on initial script load (the service worker can be woken by
// any registered event before either of the above listeners fires).
connect();
