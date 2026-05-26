/**
 * Bridge mode — stdio↔WebSocket pipe.
 *
 * Spawned by Claude Desktop or Claude Code as the MCP server binary.
 * Connects to the daemon's /mcp WebSocket endpoint and forwards
 * newline-delimited JSON-RPC bytes in both directions.
 *
 * Stdin is NOT read until the WebSocket is open. Until then, the OS
 * pipe buffer (~64KB on macOS) backpressures Claude's writes — nothing
 * accumulates in this process's memory.
 *
 * Retry policy on initial connect: 250ms → 500ms → 1s → 2s → 4s
 * exponential backoff (~8s total) before giving up. The window covers
 * a launchd daemon respawn and a possible TIME_WAIT delay on rebind.
 *
 * On WebSocket close *after* a successful open: exit cleanly. Claude's
 * MCP client treats this as a transport-level failure and respawns
 * the bridge, which restarts the cycle with a fresh initialize. This
 * is simpler than in-process reconnect-with-init-replay and the
 * user-visible recovery latency is the same (~1s), since Claude
 * respawn ≈ launchd respawn.
 *
 * IMPORTANT: stdout is the MCP JSON-RPC channel. Only daemon messages
 * may go there. All diagnostics use stderr.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER_DIR = resolve(__dirname, "..");
const PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  "com.tab-reader.daemon.plist",
);
const DAEMON_URL = "ws://127.0.0.1:17321/mcp";

const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000];

export async function runBridge(): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await pipe();
      // pipe() returns when the WebSocket closes cleanly. Exit calmly;
      // Claude will respawn if it still wants the MCP server.
      process.exit(0);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]!);
      }
    }
  }

  emitGiveUpError(lastError);
  process.exit(1);
}

function pipe(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(DAEMON_URL);
    let opened = false;

    ws.on("open", () => {
      opened = true;
      process.stderr.write(`[tab-reader bridge] Connected to ${DAEMON_URL}\n`);

      // Now safe to attach stdin reader. Anything Claude wrote before
      // this point sits in the OS pipe buffer; the kernel held it.
      process.stdin.setEncoding("utf8");

      let stdinBuffer = "";
      process.stdin.on("data", (chunk: string) => {
        stdinBuffer += chunk;
        let nl = stdinBuffer.indexOf("\n");
        while (nl !== -1) {
          const line = stdinBuffer.slice(0, nl + 1); // keep the \n
          stdinBuffer = stdinBuffer.slice(nl + 1);
          if (line.trim().length > 0 && ws.readyState === WebSocket.OPEN) {
            ws.send(line);
          }
          nl = stdinBuffer.indexOf("\n");
        }
      });

      process.stdin.on("end", () => {
        // Claude closed our stdin → shut down cleanly.
        ws.close();
      });
    });

    ws.on("message", (raw) => {
      // Daemon → Claude. Forward as a newline-terminated line.
      const text = raw.toString();
      if (text.endsWith("\n")) {
        process.stdout.write(text);
      } else {
        process.stdout.write(text + "\n");
      }
    });

    ws.on("error", (err) => {
      if (!opened) {
        reject(err);
      }
      // If already opened, 'close' fires next and is handled there.
    });

    ws.on("close", () => {
      if (opened) {
        // Connection was up and is now gone. Exit; Claude respawns.
        resolve();
      } else {
        reject(new Error("WebSocket closed before opening"));
      }
    });
  });
}

function emitGiveUpError(lastError: Error | null): void {
  const installed = existsSync(PLIST_PATH);
  const errSummary = lastError ? ` (${lastError.message})` : "";

  if (installed) {
    process.stderr.write(
      `\n[tab-reader] Cannot reach the tab-reader daemon at ${DAEMON_URL}${errSummary}.\n` +
        `The LaunchAgent is installed but the daemon isn't responding.\n\n` +
        `Check status:   launchctl list | grep com.tab-reader.daemon\n` +
        `Recent logs:    tail -50 ~/Library/Logs/tab-reader.log\n` +
        `Restart it:     cd ${SERVER_DIR} && npm run reload-daemon\n\n`,
    );
  } else {
    process.stderr.write(
      `\n[tab-reader] Cannot reach the tab-reader daemon at ${DAEMON_URL}${errSummary}.\n` +
        `The LaunchAgent has not been installed yet.\n\n` +
        `One-time setup:\n` +
        `  cd ${SERVER_DIR} && npm run install-daemon\n\n` +
        `Then restart this Claude session.\n\n`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
