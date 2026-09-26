import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [solidPlugin()],
  server: { proxy: { "/api": "http://127.0.0.1:3001" } },
});
