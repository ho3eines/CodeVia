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
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/tests/**", "src/**/__tests__/**", "src/db/seed.ts", "src/index.ts"],
      reporter: ["text", "text-summary", "json-summary", "html"],
      // Global coverage floor. `npm run test:coverage` fails when these are
      // missed. Per-directory floors for the sensitive surface are enforced by
      // `npm run coverage:check` (scripts/check-coverage.mjs).
      thresholds: {
        lines: 75,
        functions: 75,
        statements: 75,
        branches: 70,
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
