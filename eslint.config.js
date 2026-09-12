import js from "@eslint/js";
import tseslint from "typescript-eslint";

const NODE_GLOBALS = {
  console: "readonly",
  process: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  FormData: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  queueMicrotask: "readonly",
  fetch: "readonly",
  structuredClone: "readonly",
  performance: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  globalThis: "readonly",
};

export default tseslint.config(
  {
    // Build output, dependencies, runtime data and the (not-yet-modularized)
    // browser bundle are outside the lint scope. `public/app.js` is linted once
    // it is split into modules (roadmap Phase 4).
    ignores: ["dist/**", "coverage/**", "data/**", "node_modules/**", "public/**", "*.md", ".husky/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: NODE_GLOBALS,
    },
    rules: {
      // TypeScript's own checker is authoritative for undefined references;
      // `no-undef` produces false positives on type-only imports/globals.
      "no-undef": "off",
      // Strict `no-explicit-any` is noisy on an actively-migrating codebase.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          // `const { drop, ...rest } = obj` — the omitted sibling is intentional.
          ignoreRestSiblings: true,
        },
      ],
      // `never` casts are used deliberately where a legacy shape is forced
      // through a stricter type (documented in the code).
      "@typescript-eslint/ban-ts-comment": ["error", { "ts-ignore": "allow-with-description" }],
      // Matching/sanitizing control characters in strings is a legitimate,
      // well-scoped pattern here (telemetry guards, binary-safe trimming).
      "no-control-regex": "off",
      // `while (true)` polling loops with explicit exit conditions are used in
      // several services; other constant conditions (e.g. `if (false)` guards)
      // are still flagged.
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: NODE_GLOBALS,
    },
    rules: {
      // CLI scripts report through the console by design.
      "no-console": "off",
    },
  },
);
