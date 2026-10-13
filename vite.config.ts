/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
  test: {
    exclude: [...configDefaults.exclude, "vendor/**"],
  },
});
