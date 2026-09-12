import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildApp, readManifest } from "../../scripts/build-app.mjs";

/**
 * The SPA is authored as feature modules under `client/app/` and assembled into
 * the single `public/app.js` file that the JSDOM regression tests eval and that
 * the server version-stamps. These tests pin that contract so a fragment edit
 * can never silently drift from the served bundle.
 */
const root = process.cwd(); // vitest runs from the repo root

describe("SPA feature-module assembly", () => {
  it("regenerates public/app.js byte-for-byte from the manifest fragments", () => {
    const bundle = buildApp();
    const artifact = readFileSync(resolve(root, "public/app.js"), "utf8");
    expect(bundle).toBe(artifact);
  });

  it("lists every fragment in the manifest and covers the artifact exactly once", () => {
    const manifest = readManifest();
    const artifact = readFileSync(resolve(root, "public/app.js"), "utf8");
    const lines = artifact.split("\n");
    expect(manifest.output).toBe("public/app.js");
    expect(manifest.modules.length).toBeGreaterThan(10);

    let cursor = 1;
    for (const mod of manifest.modules) {
      expect(mod.from, `${mod.file} starts right after the previous fragment`).toBe(cursor);
      const content = readFileSync(resolve(root, "client/app", mod.file), "utf8");
      const slice = lines.slice(mod.from - 1, mod.to).join("\n") + "\n";
      expect(content, `${mod.file} matches app.js lines ${mod.from}-${mod.to}`).toBe(slice);
      cursor = mod.to + 1;
    }
    expect(cursor - 1).toBe(lines.length - 1); // artifact line count (no trailing "" counted)
  });

  it("parses as a syntactically valid script", () => {
    const bundle = buildApp();
    expect(() => new Function(bundle)).not.toThrow();
  });
});
