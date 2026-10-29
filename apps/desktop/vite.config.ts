import { runnerBridge } from "./scripts/vite-runner";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss(), runnerBridge()],
  resolve: {
    alias: [
      { find: "electrobun/view", replacement: resolve(__dirname, "src/mainview/lib/electrobun-stub.ts") },
      { find: "@", replacement: resolve(__dirname, "src/mainview") },
    ],
  },
  root: "src/mainview",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
