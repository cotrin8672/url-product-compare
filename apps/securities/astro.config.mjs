import solid from "@astrojs/solid-js";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  // The API proxy uses extensionless /api/* paths without a trailing slash.
  trailingSlash: "ignore",
  server: { port: 5175 },
  devToolbar: { enabled: false },
  compressHTML: false,
  integrations: [solid()],
  build: { format: "directory", assets: "assets", inlineStylesheets: "never" },
  vite: {
    build: { assetsInlineLimit: 0 },
    server: { proxy: { "/api": process.env["API_PROXY_TARGET"] ?? "http://127.0.0.1:3001" } },
  },
});
