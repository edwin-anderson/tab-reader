#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  BIN_PATH,
  DOMAIN_TARGET,
  LABEL,
  LOG_PATH,
  NODE_PATH,
  PLIST_PATH,
  SERVICE_TARGET,
  TEMPLATE_PATH,
  WS_PORT,
} from "./lib.js";

function isLoaded() {
  try {
    execFileSync("launchctl", ["print", SERVICE_TARGET], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runLaunchctl(args, { ignoreErrors = false } = {}) {
  try {
    execFileSync("launchctl", args, { stdio: "inherit" });
    return true;
  } catch (err) {
    if (ignoreErrors) return false;
    console.error(`[install-daemon] launchctl ${args.join(" ")} failed.`);
    process.exit(err.status ?? 1);
  }
}

function main() {
  if (!fs.existsSync(BIN_PATH)) {
    console.error(`[install-daemon] Build output not found at ${BIN_PATH}.`);
    console.error("Run 'npm run build' first, then re-run install-daemon.");
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

  const tmpl = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const plist = tmpl
    .replaceAll("__NODE_PATH__", NODE_PATH)
    .replaceAll("__BIN_PATH__", BIN_PATH)
    .replaceAll("__LOG_PATH__", LOG_PATH);

  const existingContent = fs.existsSync(PLIST_PATH)
    ? fs.readFileSync(PLIST_PATH, "utf8")
    : null;

  if (existingContent === plist && isLoaded()) {
    console.log(`Plist already up-to-date and service is loaded.`);
    console.log(`Plist: ${PLIST_PATH}`);
    console.log(`Logs:  ${LOG_PATH}`);
    return;
  }

  if (existingContent !== null) {
    // Bootout any currently-loaded version before rewriting; tolerate "not loaded".
    runLaunchctl(["bootout", DOMAIN_TARGET, PLIST_PATH], { ignoreErrors: true });
  }

  fs.writeFileSync(PLIST_PATH, plist, { mode: 0o644 });
  if (existingContent === null) {
    console.log(`Wrote new plist to ${PLIST_PATH}`);
  } else if (existingContent !== plist) {
    console.log(`Updated plist at ${PLIST_PATH}`);
  }

  runLaunchctl(["bootstrap", DOMAIN_TARGET, PLIST_PATH]);
  console.log(`Bootstrapped ${SERVICE_TARGET}`);
  console.log("");
  console.log(`Daemon installed. Listening on ws://127.0.0.1:${WS_PORT}.`);
  console.log(`Logs:  ${LOG_PATH}`);
  console.log(`Verify: launchctl list | grep ${LABEL}  &&  lsof -i :${WS_PORT}`);
}

main();
