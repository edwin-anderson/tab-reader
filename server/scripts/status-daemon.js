#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import { execFileSync } from "node:child_process";
import {
  LABEL,
  LOG_PATH,
  PLIST_PATH,
  SERVICE_TARGET,
  WS_PORT,
} from "./lib.js";

function getLaunchctlInfo() {
  try {
    const out = execFileSync("launchctl", ["print", SERVICE_TARGET], {
      encoding: "utf8",
    });
    const pidMatch = out.match(/^\s*pid\s*=\s*(\d+)/m);
    const exitMatch = out.match(/^\s*last exit code\s*=\s*(.+)$/m);
    return {
      loaded: true,
      pid: pidMatch ? Number(pidMatch[1]) : null,
      lastExit: exitMatch ? exitMatch[1].trim() : null,
    };
  } catch {
    return { loaded: false, pid: null, lastExit: null };
  }
}

function isListening() {
  try {
    execFileSync(
      "lsof",
      ["-i", `:${WS_PORT}`, "-sTCP:LISTEN", "-P", "-n"],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function fetchStatus() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: WS_PORT,
        path: "/status",
        method: "GET",
        timeout: 2000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function formatUptime(seconds) {
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

async function main() {
  console.log("tab-reader daemon status");
  console.log("========================");

  const plistExists = fs.existsSync(PLIST_PATH);
  console.log(`plist:             ${plistExists ? PLIST_PATH : "NOT INSTALLED"}`);

  const info = getLaunchctlInfo();
  if (info.loaded) {
    console.log(
      `launchctl:         loaded${info.pid !== null ? `, pid ${info.pid}` : ""}`,
    );
  } else {
    console.log(`launchctl:         not loaded`);
  }
  if (info.lastExit) console.log(`last exit:         ${info.lastExit}`);

  const listening = isListening();
  console.log(`port :${WS_PORT}:       ${listening ? "listening" : "FREE"}`);

  if (listening) {
    try {
      const s = await fetchStatus();
      console.log(`extension:         ${s.extensionConnected ? "connected" : "disconnected"}`);
      console.log(`bridges:           ${s.bridgeConnections}`);
      console.log(`pending requests:  ${s.pendingRequests}`);
      console.log(`uptime:            ${formatUptime(s.uptime)}`);
      if (s.latestTab) {
        console.log(`latest tab:        ${s.latestTab.title}`);
        console.log(`                   ${s.latestTab.url}`);
      } else {
        console.log(`latest tab:        (none reported yet)`);
      }
    } catch (err) {
      console.log(`/status:           unreachable (${err.message})`);
    }
  }

  console.log(`logs:              ${LOG_PATH}`);
}

main().catch((err) => {
  console.error(`[status-daemon] ${err.message}`);
  process.exit(1);
});
