import { describe, expect, it } from "vitest";
import { applyFileEdits } from "../agents/implementation.js";

const lf = "namespace App;\n\npublic class A\n{\n    public int X { get; set; }\n}\n";
const before = "    public int X { get; set; }\n}";
const after = "    public int X { get; set; }\n    public int Y { get; set; }\n}";
const toCrlf = (text: string): string => text.replace(/\n/g, "\r\n");
const patch = (oldText: string, newText: string): string => JSON.stringify({ edits: [{ oldText, newText }] });

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

  it("stays strict for mixed line endings", () => {
    const mixed = "a\r\nb\nc\r\n";
    expect(() => applyFileEdits(mixed, patch("a\nb", "x"))).toThrow(/exactly once/);
  });

  it("still rejects ambiguous patches after normalization", () => {
    const twice = toCrlf("x = 1;\nx = 1;\n");
    expect(() => applyFileEdits(twice, patch("x = 1;", "x = 2;"))).toThrow(/exactly once/);
  });
});
