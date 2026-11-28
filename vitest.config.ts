import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests for the pure logic only (no browser, no network).
// The test script pins TZ=Asia/Tokyo because several conversions are JST-based.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
