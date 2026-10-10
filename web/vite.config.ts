import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = Number(process.env.SERVER_PORT ?? 8080);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    // In development the signaling server runs separately; proxy it so the
    // app is same-origin exactly like production.
    proxy: { "/ws": { target: `ws://localhost:${serverPort}`, ws: true } },
  },
  build: {
    outDir: process.env.VITE_OUT_DIR ?? "dist",
    target: "es2022",
    sourcemap: false,
    // Never inline assets as data: URIs (CSP allows img-src 'self' only).
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
