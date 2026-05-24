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
const KEEPALIVE_INTERVAL_MS = 20_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let webSocket = null;
let keepAliveIntervalId = null;
let reconnectDelay = RECONNECT_INITIAL_MS;
let reconnectTimeoutId = null;

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
    // The server doesn't send us anything meaningful right now, but receiving
    // a message also resets the SW idle timer — so we just log and move on.
    console.log("[tab-reader] WebSocket message:", event.data);
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

function startKeepAlive() {
  stopKeepAlive();
  keepAliveIntervalId = setInterval(() => {
    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
      webSocket.send("keepalive");
    } else {
      stopKeepAlive();
    }
  }, KEEPALIVE_INTERVAL_MS);
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
