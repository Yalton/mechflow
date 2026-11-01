import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

/**
 * WebSocket endpoint for live updates.
 *
 * Attaches a {@link WebSocketServer} bound to the HTTP server at `/ws`. Any
 * payload sent through the returned {@link Broadcaster} is JSON-encoded and
 * fanned out to every connected client; the web app re-fetches the model on
 * notification. Upgrades to other paths are dropped by the server.
 */

/** Fans a JSON-encoded message out to every connected WebSocket client. */
export type Broadcaster = { sendAll(message: unknown): void };

/** The pathname clients connect to for live updates. */
export const WS_PATH = "/ws";

/**
 * Register the `/ws` upgrade handler on `server` and return a broadcaster for
 * pushing change notifications to connected clients.
 */
export function attachWebSocketServer(server: HttpServer): Broadcaster {
  const wss = new WebSocketServer({ server, path: WS_PATH });

  wss.on("connection", (ws) => {
    const drop = (): void => {
      if (wss.clients.has(ws)) wss.clients.delete(ws);
    };
    ws.on("close", drop);
    ws.on("error", drop);
  });

  return {
    sendAll(message: unknown): void {
      const payload = JSON.stringify(message);
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    },
  };
}
