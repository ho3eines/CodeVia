#!/usr/bin/env node
/**
 * Sensitive-path coverage gate.
 *
 * Reads the JSON summary produced by `npm run test:coverage` and enforces a
 * per-directory line-coverage floor for the security/execution surface
 * (auth, approvals, GitHub state, HTTP, tools, workers). A regression in one
 * of these paths fails CI even if the global threshold still passes.
 *
 *   npm run test:coverage
 *   npm run coverage:check
 */
import { readFileSync, existsSync } from "node:fs";

const SUMMARY = "coverage/coverage-summary.json";

const FLOORS = [
  { prefix: "src/auth", lines: 80, note: "identity, sessions, tokens" },
  { prefix: "src/approvals", lines: 90, note: "human-in-the-loop gating" },
  { prefix: "src/github", lines: 80, note: "repository state + connections" },
  { prefix: "src/http", lines: 70, note: "routes, guards, project-scoped access" },
  { prefix: "src/tools", lines: 80, note: "dangerous tool execution" },
  { prefix: "src/workers", lines: 65, note: "queue/worker + merge authorization" },
];

if (!existsSync(SUMMARY)) {
  console.error(`✗ ${SUMMARY} not found — run \`npm run test:coverage\` first.`);
  process.exit(1);
}

const json = JSON.parse(readFileSync(SUMMARY, "utf8"));

// Coverage reporters emit absolute paths (e.g. /home/user/CodeVia/src/…);
// normalize to "src/…" so the directory floors match on any machine/CI.
const normalize = (path) => {
  const i = path.indexOf("/src/");
  return i >= 0 ? path.slice(i + 1) : path;
};
const files = Object.entries(json)
  .filter(([key]) => key !== "total")
  .map(([key, value]) => [normalize(key), value]);

let failed = false;
for (const floor of FLOORS) {
  const inDir = files.filter(([path]) => path.startsWith(`${floor.prefix}/`) || path === `${floor.prefix}.ts`);
  if (inDir.length === 0) {
    console.error(`✗ no coverage data for ${floor.prefix}/ (${floor.note})`);
    failed = true;
    continue;
  }
  let covered = 0;
  let total = 0;
  for (const [, v] of inDir) {
    covered += v.lines.covered;
    total += v.lines.total;
  }
  const pct = total ? (covered / total) * 100 : 100;
  const ok = pct >= floor.lines;
  if (!ok) failed = true;
  console.log(`${ok ? "✓" : "✗"} ${floor.prefix}/  ${pct.toFixed(2)}% lines (floor ${floor.lines}%)  — ${floor.note}`);
}

if (failed) {
  console.error("\nSensitive-path coverage floors missed.");
  process.exit(1);
}
console.log("\nSensitive-path coverage floors satisfied.");
