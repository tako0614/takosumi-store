import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: __dirname,
  plugins: [solid()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    host: true,
    proxy: {
      "/tcs": "http://localhost:8787",
      "/.well-known": "http://localhost:8787",
      "/healthz": "http://localhost:8787",
      "/readyz": "http://localhost:8787",
    },
  },
});
