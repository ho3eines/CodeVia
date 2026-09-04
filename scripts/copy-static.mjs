import { cpSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Copy the static web UI into dist/ so the production entry (`node dist/index.js`)
// serves it from a single artifact. Matches how the SPA is resolved at runtime
// (../public relative to the bundle would not exist after a clean install).
const src = resolve(process.cwd(), "public");
const dest = resolve(process.cwd(), "dist", "public");

if (existsSync(src)) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`Copied static UI -> ${dest}`);
} else {
  console.warn(`public/ not found at ${src}; skipping static copy`);
}
