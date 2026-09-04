import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 20000,
    pool: "forks",
    // Node's experimental `node:sqlite` is not a Vite-recognized builtin; mark it
    // external so it is loaded straight from the Node runtime at test time.
    deps: {
      external: ["node:sqlite"],
    },
    server: {
      deps: {
        external: ["node:sqlite", "node:test", "node:assert"],
      },
    },
  },
  ssr: {
    external: ["node:sqlite"],
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
