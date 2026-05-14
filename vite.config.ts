import { defineConfig } from "vite";
import { resolve } from "node:path";
import process from "node:process";

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? "/rebuild-and-ruin/" : "/",
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        "sprite-viewer": resolve(__dirname, "sprite-viewer.html"),
      },
    },
  },
  server: {
    host: true,
    proxy: {
      "/ws/play": {
        target: "ws://localhost:8001",
        ws: true,
      },
      "/api": {
        target: "http://localhost:8001",
      },
    },
  },
});
