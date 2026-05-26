import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LABEL = "com.tab-reader.daemon";
export const WS_PORT = 17321;

export const SCRIPTS_DIR = __dirname;
export const SERVER_DIR = path.resolve(__dirname, "..");
export const BIN_PATH = path.join(SERVER_DIR, "build", "index.js");
export const TEMPLATE_PATH = path.join(__dirname, "com.tab-reader.daemon.plist.tmpl");
export const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const LOG_PATH = path.join(os.homedir(), "Library", "Logs", "tab-reader.log");
export const NODE_PATH = process.execPath;

const uid = process.getuid?.() ?? 0;
export const DOMAIN_TARGET = `gui/${uid}`;
export const SERVICE_TARGET = `gui/${uid}/${LABEL}`;
