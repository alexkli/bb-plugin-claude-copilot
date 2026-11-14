import { defineConfig } from "vitest/config";

// Runs the vendored upstream tests unchanged, plus this plugin's own.
export default defineConfig({
  test: {
    silent: "passed-only",
    include: ["vendor/provider-claude-code/src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
