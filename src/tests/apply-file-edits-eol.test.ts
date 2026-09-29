import { describe, expect, it } from "vitest";
import { applyFileEdits, PatchApplyError, MAX_FILE_CHARS } from "../agents/file-patch.js";

const lf = "namespace App;\n\npublic class A\n{\n    public int X { get; set; }\n}\n";
const before = "    public int X { get; set; }\n}";
const after = "    public int X { get; set; }\n    public int Y { get; set; }\n}";
const toCrlf = (text: string): string => text.replace(/\n/g, "\r\n");
const patch = (oldText: string, newText: string): string => JSON.stringify({ edits: [{ oldText, newText }] });
const patchN = (edits: Array<{ oldText: string; newText: string }>): string => JSON.stringify({ edits });

describe("applyFileEdits with Windows/.NET sources", () => {
  it("applies an LF model patch to a CRLF file and keeps CRLF line endings", () => {
    const out = applyFileEdits(toCrlf(lf), patch(before, after));
    expect(out).toBe(toCrlf(lf.replace(before, after)));
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("accepts a CRLF patch against a CRLF file", () => {
    const out = applyFileEdits(toCrlf(lf), patch(toCrlf(before), toCrlf(after)));
    expect(out).toBe(toCrlf(lf.replace(before, after)));
  });

  it("preserves a UTF-8 BOM", () => {
    const out = applyFileEdits(`\uFEFF${toCrlf(lf)}`, patch(before, after));
    expect(out.startsWith("\uFEFF")).toBe(true);
    expect(out.slice(1)).toBe(toCrlf(lf.replace(before, after)));
  });

  it("keeps LF files byte-exact outside the replacement", () => {
    expect(applyFileEdits(lf, patch(before, after))).toBe(lf.replace(before, after));
  });

  it("applies a unique normalized match in a mixed-EOL file and keeps untouched bytes", () => {
    const mixed = "a\r\nb\nc\r\n";
    // L1 (EOL normalization) matches "a\nb" exactly once; the untouched tail
    // "\nc\r\n" — including its lone LF and its CRLF — stays byte-identical.
    expect(applyFileEdits(mixed, patch("a\nb", "x"))).toBe("x\nc\r\n");
  });

  it("still rejects ambiguous patches in a mixed-EOL file, with line numbers", () => {
    try {
      applyFileEdits("a\r\na\n", patch("a", "x"));
      expect.unreachable("ambiguous patch must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PatchApplyError);
      const e = err as PatchApplyError;
      expect(e.message).toMatch(/exactly once/);
      expect(e.kind).toBe("ambiguous");
      expect(e.detail.positions).toEqual([1, 2]);
    }
  });

  it("still rejects ambiguous patches after normalization", () => {
    const twice = toCrlf("x = 1;\nx = 1;\n");
    expect(() => applyFileEdits(twice, patch("x = 1;", "x = 2;"))).toThrow(/exactly once/);
  });

  it("applies an explicit full rewrite to a BOM + CRLF file preserving both", () => {
    const existing = `\uFEFF${toCrlf("line one;\nline two;\n")}`;
    const rewritten = "line one;\nline two;\nline three;\n";
    const out = applyFileEdits(existing, JSON.stringify({ content: rewritten }));
    expect(out).toBe(`\uFEFF${toCrlf(rewritten)}`);
  });
});

describe("applyFileEdits match ladder (EOL / whitespace / anchors)", () => {
  it("L2: matches when only trailing spaces/tabs differ", () => {
    const file = "const a = 1;   \nconst b = 2;\n";
    const out = applyFileEdits(file, patch("const a = 1;\nconst b", "const a = 11;\nconst b"));
    expect(out).toBe("const a = 11;\nconst b = 2;\n");
    const tabbed = "function f() {\t\n  return 1;\n}\n";
    const out2 = applyFileEdits(tabbed, patch("function f() {\n  return 1;", "function f() {\n  return 2;"));
    expect(out2).toBe("function f() {\n  return 2;\n}\n");
  });

  it("L3: anchor pair locates the region when interior lines do not match", () => {
    const file = 'function greet() {\n  return "hi";\n}\nexport const version = 1;\n';
    const oldText = 'function greet() {\n  return "bye";\n}';
    const newText = 'function greet() {\n  return "hi and bye";\n}';
    expect(applyFileEdits(file, patch(oldText, newText))).toBe(
      'function greet() {\n  return "hi and bye";\n}\nexport const version = 1;\n',
    );
  });

  it("L3: ambiguous anchor pairs report every matching line", () => {
    const file = "function f() {\n  return 1;\n}\n\nfunction f() {\n  return 2;\n}\n";
    const oldText = "function f() {\n  return 9;\n}";
    try {
      applyFileEdits(file, patch(oldText, "/* fixed */"));
      expect.unreachable("ambiguous anchors must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PatchApplyError);
      expect((err as PatchApplyError).kind).toBe("ambiguous");
      expect((err as PatchApplyError).detail.positions).toEqual([1, 5]);
    }
  });

  it("no-match: reports the closest region with line numbers (tab vs space indent)", () => {
    const file = "\tconst x = 1;\n\tconst y = 2;\n";
    try {
      applyFileEdits(file, patch("  const x = 1;", "const x = 2;"));
      expect.unreachable("unmatched oldText must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PatchApplyError);
      const e = err as PatchApplyError;
      expect(e.kind).toBe("no-match");
      expect(e.message).toMatch(/exactly once/);
      expect(e.detail.lineCount).toBe(2);
      expect(e.detail.nearest).toBeDefined();
      expect(e.detail.nearest!.startLine).toBe(1);
      expect(e.detail.nearest!.excerpt).toContain("const x = 1;");
      expect(e.detail.nearest!.excerpt).toMatch(/^1 \| /m);
    }
  });

  it("matches several edits in one patch, each through its own ladder level", () => {
    const file = "export const a = 1;\r\nexport const b = 2;\r\n";
    const out = applyFileEdits(
      file,
      patchN([
        { oldText: "export const a = 1;", newText: "export const a = 11;" }, // L0 exact
        { oldText: "export const b = 2;\n", newText: "export const b = 22;\n" }, // L1: LF oldText on CRLF file
      ]),
    );
    expect(out).toBe("export const a = 11;\r\nexport const b = 22;\r\n");
  });
});

describe("applyFileEdits with a TypeScript file (unified diff)", () => {
  const ts = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";
  const diff = [
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1,3 +1,3 @@",
    " export const a = 1;",
    "-export const b = 2;",
    "+export const b = 22;",
    " export const c = 3;",
    "",
  ].join("\n");

  it("applies a unified diff and keeps untouched lines byte-identical", () => {
    expect(applyFileEdits(ts, diff)).toBe("export const a = 1;\nexport const b = 22;\nexport const c = 3;\n");
  });

  it("applies an LF-written diff to a CRLF file, styling added lines CRLF", () => {
    const crlf = toCrlf(ts);
    const out = applyFileEdits(crlf, diff);
    expect(out).toBe(toCrlf("export const a = 1;\nexport const b = 22;\nexport const c = 3;\n"));
    // context lines keep their original \r\n bytes
    expect(out.startsWith("export const a = 1;\r\n")).toBe(true);
  });

  it("rejects a diff whose context does not match, pointing at the line", () => {
    const bad = diff.replace("export const a = 1;", "export const a = 999;");
    try {
      applyFileEdits(ts, bad);
      expect.unreachable("mismatching diff must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PatchApplyError);
      const e = err as PatchApplyError;
      expect(e.kind).toBe("diff-mismatch");
      expect(e.detail.failedLine).toBeGreaterThanOrEqual(1);
      expect(e.message).toMatch(/line \d+/);
    }
  });

  it("honours the no-newline-at-EOF marker", () => {
    const noNl = "line one;\nline two;";
    const diffNoNl = [
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,2 +1,2 @@",
      " line one;",
      "-line two;",
      "+line 2;",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(applyFileEdits(noNl, diffNoNl)).toBe("line one;\nline 2;");
  });
});

describe("applyFileEdits full rewrite (below the configured threshold)", () => {
  it("accepts a raw full rewrite for a small file when lines are kept", () => {
    const existing = "export const keep = true;\nexport const a = 1;\nexport const b = 2;\n";
    const rewritten = "export const keep = true;\nexport const a = 11;\nexport const c = 3;\n";
    expect(applyFileEdits(existing, rewritten)).toBe(rewritten);
  });

  it("accepts a fence-wrapped full rewrite for a small file", () => {
    const existing = "export const keep = true;\nexport const a = 1;\n";
    const rewritten = "export const keep = true;\nexport const a = 2;\n";
    expect(applyFileEdits(existing, "```ts\n" + rewritten + "```")).toBe(rewritten);
  });

  it("accepts an explicit {content} rewrite even with no shared lines", () => {
    const existing = "alpha line one\nbeta line two\ngamma line three\n";
    const rewritten = "totally new content\nnothing in common here\n";
    expect(applyFileEdits(existing, JSON.stringify({ content: rewritten }))).toBe(rewritten);
  });

  it("rejects a raw rewrite above the threshold with the JSON-patch message", () => {
    const large = "y".repeat(9000);
    expect(() => applyFileEdits(large, "export const changed = 1;")).toThrow(/JSON/);
  });

  it("honours a custom fullRewriteMaxBytes option", () => {
    const existing = "z".repeat(50);
    expect(() => applyFileEdits(existing, "raw", { fullRewriteMaxBytes: 10 })).toThrow(/JSON/);
    expect(applyFileEdits(existing, "raw", { fullRewriteMaxBytes: 100 })).toBe("raw");
  });

  it("rejects a prose reply that shares no line with a real file", () => {
    const existing = [
      "export function one() { return 1; }",
      "export function two() { return 2; }",
      "export function three() { return 3; }",
      "export function four() { return 4; }",
      "export function five() { return 5; }",
      "",
    ].join("\n");
    const prose = "I could not find the text you asked me to replace in this file.";
    try {
      applyFileEdits(existing, prose);
      expect.unreachable("prose must not be applied as a rewrite");
    } catch (err) {
      expect(err).toBeInstanceOf(PatchApplyError);
      expect((err as PatchApplyError).kind).toBe("invalid");
      expect((err as PatchApplyError).message).toMatch(/JSON/);
    }
  });

  it("rejects a rewrite containing a NUL byte", () => {
    const existing = "export const keep = true;\nexport const a = 1;\n";
    expect(() => applyFileEdits(existing, `export const keep = true;\n\u0000bad();\n`)).toThrow(/NUL/);
  });

  it("rejects results above the safety cap as non-correctable", () => {
    try {
      applyFileEdits("seed line here\n", patch("seed line here", "x".repeat(MAX_FILE_CHARS + 10)));
      expect.unreachable("oversized result must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PatchApplyError);
      const e = err as PatchApplyError;
      expect(e.kind).toBe("too-large");
      expect(e.correctable).toBe(false);
    }
  });

  it("keeps rejecting structured replies without edits", () => {
    expect(() => applyFileEdits("export const a = 1;", JSON.stringify({ path: "a.ts" }))).toThrow(/JSON/);
    expect(() => applyFileEdits("export const a = 1;", JSON.stringify([{ oldText: "a" }]))).toThrow(/JSON/);
    expect(() => applyFileEdits("export const a = 1;", JSON.stringify({ edits: [] }))).toThrow(/JSON/);
  });
});
