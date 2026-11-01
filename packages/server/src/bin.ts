#!/usr/bin/env node
import { serve } from "./index.js";

interface CliOptions {
  port: number;
  host: string;
  modelsRoot?: string;
}

/**
 * Parse CLI flags. Supports `--port <n>` / `--port=<n>`, `--host <addr>` /
 * `--host=<addr>` and `--models <dir>` / `--models=<dir>`; defaults to port
 * 3000, host 127.0.0.1 and `<cwd>/models`.
 */
function parseArgs(argv: string[]): CliOptions {
  let port = 3000;
  let host = "127.0.0.1";
  let modelsRoot: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    const inline = arg.includes("=");
    const value = inline ? arg.slice(arg.indexOf("=") + 1) : argv[i + 1];
    if (arg === "--port" || (inline && arg.startsWith("--port="))) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) port = parsed;
    } else if (arg === "--host" || (inline && arg.startsWith("--host="))) {
      if (value) host = value;
    } else if (arg === "--models" || (inline && arg.startsWith("--models="))) {
      if (value) modelsRoot = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log("usage: mechflow-serve [--port <n>] [--host <addr>] [--models <dir>]");
      process.exit(0);
    }
    if (!inline) i++;
  }
  return { port, host, modelsRoot };
}

const { port, host, modelsRoot } = parseArgs(process.argv);

// Loopback by default: this is a local dev server with no auth. `--host` exists
// for the container, which must bind 0.0.0.0 for its published port to work.
// The watcher feeds live model changes to /ws clients, which re-fetch on
// notification.
const handle = await serve({ modelsRoot });
handle.server.listen(port, host, () => {
  const addr = handle.server.address();
  const actualPort = addr && typeof addr === "object" ? addr.port : port;
  console.log(`mechflow-server listening on http://${host}:${actualPort}`);
});
