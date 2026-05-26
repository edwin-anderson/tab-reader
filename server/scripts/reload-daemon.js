#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { SERVICE_TARGET } from "./lib.js";

function main() {
  try {
    execFileSync("launchctl", ["kickstart", "-k", SERVICE_TARGET], {
      stdio: "inherit",
    });
    console.log(`Restarted ${SERVICE_TARGET}`);
  } catch (err) {
    console.error(`Failed to kickstart ${SERVICE_TARGET}.`);
    console.error("Is the daemon installed?  Run 'npm run install-daemon' first.");
    process.exit(err.status ?? 1);
  }
}

main();
