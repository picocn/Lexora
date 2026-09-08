import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev server port and no console clearing.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Don't watch the Rust build output.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
