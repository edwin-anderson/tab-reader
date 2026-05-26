#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { DOMAIN_TARGET, PLIST_PATH, SERVICE_TARGET } from "./lib.js";

function main() {
  if (!fs.existsSync(PLIST_PATH)) {
    console.log(`No plist at ${PLIST_PATH}; nothing to uninstall.`);
    return;
  }

  try {
    execFileSync("launchctl", ["bootout", DOMAIN_TARGET, PLIST_PATH], {
      stdio: "inherit",
    });
    console.log(`Booted out ${SERVICE_TARGET}`);
  } catch {
    // bootout fails if not loaded; the plist still needs deleting.
    console.log(
      `launchctl bootout returned non-zero (service may not have been loaded); continuing.`,
    );
  }

  fs.unlinkSync(PLIST_PATH);
  console.log(`Removed ${PLIST_PATH}`);
}

main();
