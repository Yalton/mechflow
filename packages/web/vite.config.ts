import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    // Forward API and WebSocket traffic to the local mechflow server.
    // Overridable via MECHFLOW_SERVER_URL (defaults to the server's :3000).
    proxy: {
      "/api": {
        target: process.env.MECHFLOW_SERVER_URL ?? "http://127.0.0.1:3000",
        changeOrigin: true,
      },
      "/ws": {
        target: process.env.MECHFLOW_SERVER_URL ?? "http://127.0.0.1:3000",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    // The first test in a file pays for the cold first render (React Flow,
    // JIT warm-up): about 0.3 s alone, but over 3 s when `pnpm -r test` runs
    // every package at once, close to the 5 s default (mechflow-6gv).
    testTimeout: 15_000,
  },
});
