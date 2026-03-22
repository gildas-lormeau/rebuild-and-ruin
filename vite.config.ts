import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? "/rebuild-and-ruin/" : "/",
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
