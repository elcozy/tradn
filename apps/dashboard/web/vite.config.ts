import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: resolve(here, "../dist"), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8787", "/ws": { target: "ws://127.0.0.1:8787", ws: true } },
  },
});
