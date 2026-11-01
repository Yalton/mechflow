import http from "node:http";
import { join } from "node:path";
import { createRequestHandler } from "./api.js";
import { createWatcher } from "./watch.js";
import { attachWebSocketServer } from "./ws.js";

/** Package name, exposed for diagnostics and tests. */
export const PACKAGE = "@mechflow/server";

export interface ServerOptions {
  /** Directory scanned for model YAML files (default: `<cwd>/models`). */
  modelsRoot?: string;
  /** Directory served as static files (default: `<cwd>/packages/web/dist`). */
  webDist?: string;
}

export const DEFAULT_MODELS_ROOT = join(process.cwd(), "models");
export const DEFAULT_WEB_DIST = join(process.cwd(), "packages", "web", "dist");

/**
 * Build the mechflow request handler for the given roots. The returned server
 * is not listening; call `.listen(port, "127.0.0.1")` to start it. The server
 * binds to localhost only by convention (see bin.ts and the tests).
 */
export function createServer(options: ServerOptions = {}): http.Server {
  const { modelsRoot = DEFAULT_MODELS_ROOT, webDist = DEFAULT_WEB_DIST } = options;
  const handler = createRequestHandler(modelsRoot, webDist);
  return http.createServer(handler);
}

export { createRequestHandler } from "./api.js";
export {
  handleListModels,
  handleGetModel,
  handlePutModel,
  handleReport,
  handleStatic,
  readBody,
} from "./api.js";

export type { Broadcaster } from "./ws.js";
export { WS_PATH } from "./ws.js";
export type { ModelWatchEvent, WatcherHandle } from "./watch.js";
export { DEBOUNCE_MS } from "./watch.js";

/** A running server plus a `close` that stops watching and closes the port. */
export interface ServerHandle {
  server: http.Server;
  close(): Promise<void>;
}

/**
 * Start the full server: HTTP + static serving, the `/ws` WebSocket endpoint,
 * and file watching that broadcasts change notifications. The returned
 * `close` cleanly stops the watcher and the listener.
 */
export async function serve(options: ServerOptions = {}): Promise<ServerHandle> {
  const { modelsRoot = DEFAULT_MODELS_ROOT } = options;
  const server = createServer(options);
  const broadcaster = attachWebSocketServer(server);
  const watcher = createWatcher(modelsRoot, (event) => broadcaster.sendAll(event));
  return {
    server,
    close: async () => {
      watcher.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
