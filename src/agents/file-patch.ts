import { extractJson } from "./llm.js";
import { getEnv } from "../config/env.js";

/**
 * Robust patch application for EXISTING files.
 *
 * A model reply may take one of three forms, tried in this order:
 *   1. a unified diff (`--- a/…`, `+++ b/…`, `@@ … @@` hunks),
 *   2. a JSON patch `{"edits":[{"oldText","newText"}]}` (or `{"content":"…"}`
 *      for an explicit full rewrite),
 *   3. the complete rewritten file — only when the existing file is below the
 *      configurable full-rewrite threshold (`PATCH_FULL_REWRITE_MAX_BYTES`,
 *      default 8KB) and the rewrite demonstrably keeps the file's lines.
 *
 * `oldText` is located through a ladder of match levels; a level is accepted
 * only when it yields EXACTLY ONE match:
 *   L0 exact bytes → L1 EOL/BOM normalization → L2 trailing-whitespace
 *   normalization → L3 anchor matching (first/last significant lines of
 *   oldText with a ±2-line tolerance on the region gap).
 *
 * Bytes outside the replaced region are never rewritten: every match is
 * located in a normalized space that carries an index map back to the original
 * string, so untouched lines stay byte-identical (CRLF, BOM and lone
 * characters included). New text is styled with the file's dominant EOL and
 * the original BOM is re-applied.
 *
 * When no level matches (or a level is ambiguous), a `PatchApplyError` is
 * thrown carrying line numbers and the closest region of the file so the
 * caller can send ONE corrective request back to the model instead of failing
 * the task immediately (`patchCorrectionContext`, `MAX_PATCH_CORRECTIONS`).
 */

/** Upper bound for any file the agent may write (platform safety cap). */
export const MAX_FILE_CHARS = 200_000;
/** Files at or below this many bytes may be replaced by a full rewrite. */
export const DEFAULT_FULL_REWRITE_MAX_BYTES = 8192;
/** Maximum corrective patch requests sent back to the model before failing. */
export const MAX_PATCH_CORRECTIONS = 2;
/** Binary/garbled model output marker; generated source must never contain one. */
const NUL = String.fromCharCode(0);

export type PatchErrorKind = "no-match" | "ambiguous" | "invalid" | "diff-mismatch" | "too-large";

/** A 1-based, line-numbered excerpt of the file shown to the model. */
export interface PatchRegion {
  startLine: number;
  endLine: number;
  excerpt: string;
}

export interface PatchErrorDetail {
  /** 0-based index of the failing edit within the patch. */
  editIndex?: number;
  /** Total lines of the file being patched. */
  lineCount: number;
  /** Closest region (no-match / diff-mismatch). */
  nearest?: PatchRegion;
  /** Line numbers of every match (ambiguous). */
  positions?: number[];
  /** 1-based line where a unified diff stopped matching. */
  failedLine?: number;
}

/**
 * A patch failure the model can correct. `correctable` distinguishes model
 * mistakes (bad oldText, wrong diff context, wrong JSON shape) from file-level
 * limits (oversized results) that a resend cannot fix.
 */
export class PatchApplyError extends Error {
  readonly kind: PatchErrorKind;
  readonly detail: PatchErrorDetail;

  constructor(kind: PatchErrorKind, message: string, detail: PatchErrorDetail) {
    super(message);
    this.name = "PatchApplyError";
    this.kind = kind;
    this.detail = detail;
  }

  get correctable(): boolean {
    return this.kind !== "too-large";
  }
}

/** Configured full-rewrite threshold (bytes). Falls back when env parsing fails. */
export function fullRewriteMaxBytes(): number {
  try {
    const v = getEnv().PATCH_FULL_REWRITE_MAX_BYTES;
    return Number.isFinite(v) ? v : DEFAULT_FULL_REWRITE_MAX_BYTES;
  } catch {
    return DEFAULT_FULL_REWRITE_MAX_BYTES;
  }
}

export interface ApplyFileEditsOptions {
  /** Override the full-rewrite byte threshold (defaults to env configuration). */
  fullRewriteMaxBytes?: number;
}

// ---------------------------------------------------------------------------
// line / EOL helpers
// ---------------------------------------------------------------------------

/** Split keeping line terminators; `join("")` reproduces the input exactly. */
function splitKeepEnds(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Line content without its terminator (CRLF, LF or CR). */
function stripEol(line: string): string {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  if (line.endsWith("\n") || line.endsWith("\r")) return line.slice(0, -1);
  return line;
}

function lineCountOf(text: string): number {
  return splitKeepEnds(text).length;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineNumberAt(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The file's dominant line ending (ties and empty files resolve to LF). */
function dominantEol(body: string): "\n" | "\r\n" {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < body.length; i++) {
    if (body.charCodeAt(i) === 10) {
      if (i > 0 && body.charCodeAt(i - 1) === 13) crlf++;
      else lf++;
    }
  }
  return crlf > lf ? "\r\n" : "\n";
}

/** Restyle generated text with the file's dominant line ending. */
function styleEol(text: string, eol: "\n" | "\r\n"): string {
  const lf = text.replace(/\r\n/g, "\n");
  return eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}

// ---------------------------------------------------------------------------
// normalized match spaces (with index maps back to the original bytes)
// ---------------------------------------------------------------------------

interface Unit {
  start: number;
  end: number;
}

interface Norm {
  text: string;
  /** For every character of `text`, the original [start, end) span it came from. */
  units: Unit[];
}

/** L1: unify `\r\n` → `\n`, remembering each character's original span. */
function normalizeEol(text: string): Norm {
  let out = "";
  const units: Unit[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) {
      out += "\n";
      units.push({ start: i, end: i + 2 });
      i++;
    } else {
      out += text[i];
      units.push({ start: i, end: i + 1 });
    }
  }
  return { text: out, units };
}

/** L2: additionally drop trailing spaces/tabs at the end of every line. */
function stripTrailingWs(src: Norm): Norm {
  let out = "";
  const units: Unit[] = [];
  let lineStart = 0;
  const emit = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      out += src.text[k];
      units.push(src.units[k]);
    }
  };
  for (let i = 0; i <= src.text.length; i++) {
    const atEnd = i === src.text.length;
    const isNewline = !atEnd && src.text[i] === "\n";
    if (atEnd || isNewline) {
      let end = i;
      while (end > lineStart && (src.text[end - 1] === " " || src.text[end - 1] === "\t")) end--;
      emit(lineStart, end);
      if (isNewline) {
        out += "\n";
        units.push(src.units[i]);
      }
      lineStart = i + 1;
    }
  }
  return { text: out, units };
}

/** Normalize a model-provided oldText to the same space as the file. */
function normalizeOldText(raw: string, level: 1 | 2): string {
  let text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  text = text.replace(/\r\n/g, "\n");
  if (level === 2) text = stripTrailingWs(normalizeEol(text)).text;
  return text;
}

/** All offsets of `needle` in `hay`, up to `cap` (overlapping matches included). */
function findAll(hay: string, needle: string, cap: number): number[] {
  const offsets: number[] = [];
  if (!needle) return offsets;
  let from = 0;
  while (offsets.length < cap) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    offsets.push(at);
    from = at + 1;
  }
  return offsets;
}

// ---------------------------------------------------------------------------
// nearest region (feedback for unmatched oldText)
// ---------------------------------------------------------------------------

function excerptLines(bodyLines: string[], fromIdx: number, toIdx: number): string {
  const parts: string[] = [];
  let chars = 0;
  for (let i = fromIdx; i < toIdx && parts.length < 40; i++) {
    const line = `${i + 1} | ${bodyLines[i]}`;
    if (chars + line.length > 2400) break;
    parts.push(line);
    chars += line.length + 1;
  }
  return parts.join("\n");
}

function regionAround(bodyLines: string[], centerIdx: number, span: number): PatchRegion | undefined {
  if (!bodyLines.length) return undefined;
  const from = Math.max(0, centerIdx - 2);
  const to = Math.min(bodyLines.length, from + Math.max(3, span));
  return { startLine: from + 1, endLine: to, excerpt: excerptLines(bodyLines, from, to) };
}

/** Closest file region to the model's oldText, line-numbered for the correction round. */
function nearestRegion(body: string, oldRaw: string, lc: number): PatchRegion | undefined {
  if (!lc) return undefined;
  const bodyLines = splitKeepEnds(body).map(stripEol);
  const anchors = normalizeOldText(oldRaw, 2)
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .filter((l) => l.trim().length > 0)
    .slice(0, 6);
  if (!anchors.length) return undefined;
  const normalize = (s: string): string => s.replace(/[ \t]+$/, "");
  let best = -1;
  let bestScore = 0;
  const scan = (matches: (line: string, anchor: string) => boolean, prepare: (a: string) => string): void => {
    for (const anchorRaw of anchors) {
      const anchor = prepare(anchorRaw);
      for (let i = 0; i < bodyLines.length; i++) {
        if (!matches(bodyLines[i], anchor)) continue;
        const score = i === best ? bestScore + 1 : 1;
        if (score > bestScore) {
          best = i;
          bestScore = score;
        }
      }
    }
  };
  // 1) exact normalized line matches for any anchor line
  scan(
    (line, anchor) => normalize(line) === anchor,
    (a) => a,
  );
  // 2) trimmed matches — the anchor differs only by leading indent (tab vs space)
  if (best < 0)
    scan(
      (line, anchor) => line.trim() === anchor.trim(),
      (a) => a,
    );
  // 3) fallback: longest common prefix of trimmed lines with the first anchor
  if (best < 0) {
    const first = anchors[0].trim();
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i].trim();
      let k = 0;
      while (k < first.length && k < line.length && first[k] === line[k]) k++;
      if (k >= 4 && k > bestScore) {
        best = i;
        bestScore = k;
      }
    }
  }
  if (best < 0) return undefined;
  const span = Math.max(4, Math.min(40, anchors.length + 4));
  const from = Math.max(0, best - 2);
  const to = Math.min(bodyLines.length, from + span);
  return { startLine: from + 1, endLine: to, excerpt: excerptLines(bodyLines, from, to) };
}

// ---------------------------------------------------------------------------
// the oldText ladder
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

type AnchorResult = { kind: "none" } | { kind: "one"; span: Span } | { kind: "many"; positions: number[] };

/** L3: pair the first/last significant lines of oldText as anchors (gap ±2 lines). */
function locateByAnchor(l2: Norm, old2: string, starts: number[]): AnchorResult {
  const oldLines = old2.split("\n");
  if (oldLines.length && oldLines[oldLines.length - 1] === "") oldLines.pop();
  const significant = oldLines.map((line, index) => ({ line, index })).filter((e) => e.line.trim().length > 0);
  if (significant.length < 2) return { kind: "none" };
  const first = significant[0];
  const last = significant[significant.length - 1];
  if (first.index === last.index) return { kind: "none" };
  const gap = last.index - first.index;

  const bodyLines: string[] = [];
  const lineStartIdx: number[] = [];
  {
    let pos = 0;
    for (const piece of splitKeepEnds(l2.text)) {
      bodyLines.push(piece.endsWith("\n") ? piece.slice(0, -1) : piece);
      lineStartIdx.push(pos);
      pos += piece.length;
    }
    if (l2.text === "") return { kind: "none" };
  }

  type Candidate = { i: number; j: number; delta: number };
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i] !== first.line) continue;
    for (const delta of [0, -1, 1, -2, 2]) {
      const j = i + gap + delta;
      if (j <= i || j >= bodyLines.length) continue;
      if (bodyLines[j] !== last.line) continue;
      const key = `${i}:${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ i, j, delta });
    }
  }
  if (!candidates.length) return { kind: "none" };
  // Prefer exact-gap candidates; ambiguity is judged within the best group.
  const minDelta = Math.min(...candidates.map((c) => Math.abs(c.delta)));
  const best = candidates.filter((c) => Math.abs(c.delta) === minDelta);
  const spanOf = (c: Candidate): Span => {
    const startLine = lineStartIdx[c.i];
    const endChar = lineStartIdx[c.j] + bodyLines[c.j].length; // last char of line j (before its \n)
    const endUnit = endChar > lineStartIdx[c.j] ? l2.units[endChar - 1] : l2.units[lineStartIdx[c.j]];
    return { start: l2.units[startLine]?.start ?? 0, end: endUnit?.end ?? 0 };
  };
  if (best.length === 1) return { kind: "one", span: spanOf(best[0]) };
  return { kind: "many", positions: best.map((c) => lineNumberAt(starts, spanOf(c).start)) };
}

function locate(body: string, oldRaw: string, editIndex: number): Span {
  const lc = lineCountOf(body);
  const starts = lineStarts(body);
  let ambiguous: number[] | undefined;

  // L0 — byte-exact
  const exact = findAll(body, oldRaw, 5);
  if (exact.length === 1) return { start: exact[0], end: exact[0] + oldRaw.length };
  if (exact.length > 1) ambiguous = exact.map((o) => lineNumberAt(starts, o));

  // L1 — EOL (and BOM) normalized
  const old1 = normalizeOldText(oldRaw, 1);
  if (old1.length) {
    const l1 = normalizeEol(body);
    const hits = findAll(l1.text, old1, 5);
    if (hits.length === 1) return { start: l1.units[hits[0]].start, end: l1.units[hits[0] + old1.length - 1].end };
    if (hits.length > 1 && !ambiguous) ambiguous = hits.map((h) => lineNumberAt(starts, l1.units[h].start));
  }

  // L2 — EOL + trailing whitespace per line
  const l2 = stripTrailingWs(normalizeEol(body));
  const old2 = normalizeOldText(oldRaw, 2);
  if (old2.length) {
    const hits = findAll(l2.text, old2, 5);
    if (hits.length === 1) return { start: l2.units[hits[0]].start, end: l2.units[hits[0] + old2.length - 1].end };
    if (hits.length > 1 && !ambiguous) ambiguous = hits.map((h) => lineNumberAt(starts, l2.units[h].start));
  }

  // L3 — anchor matching with surrounding lines
  const anchored = locateByAnchor(l2, old2, starts);
  if (anchored.kind === "one") return anchored.span;
  if (anchored.kind === "many" && !ambiguous) ambiguous = anchored.positions;

  if (ambiguous?.length)
    throw new PatchApplyError(
      "ambiguous",
      `Patch oldText must match exactly once; no ambiguous or missing replacements (matches at line(s) ${ambiguous.join(", ")})`,
      { lineCount: lc, editIndex, positions: ambiguous },
    );
  throw new PatchApplyError(
    "no-match",
    `Patch oldText must match exactly once; no ambiguous or missing replacements (not found after EOL/whitespace normalization and anchor matching; the file has ${lc} lines)`,
    { lineCount: lc, editIndex, nearest: nearestRegion(body, oldRaw, lc) },
  );
}

function applyEditList(body: string, edits: unknown[]): string {
  const lc = lineCountOf(body);
  if (edits.length === 0 || edits.length > 30)
    throw new PatchApplyError(
      "invalid",
      "Existing files require a JSON {edits:[{oldText,newText}]} patch, not a rewritten file",
      { lineCount: lc },
    );
  let result = body;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i] as { oldText?: unknown; newText?: unknown } | null;
    if (!edit || typeof edit.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string")
      throw new PatchApplyError("invalid", "Invalid file edit", { lineCount: lineCountOf(result), editIndex: i });
    const span = locate(result, edit.oldText, i);
    const eol = dominantEol(result);
    const newText = styleEol(edit.newText.startsWith("\uFEFF") ? edit.newText.slice(1) : edit.newText, eol);
    result = result.slice(0, span.start) + newText + result.slice(span.end);
  }
  if (result.length > MAX_FILE_CHARS)
    throw new PatchApplyError("too-large", "Generated file exceeds the safe size limit", {
      lineCount: lineCountOf(result),
    });
  return result;
}

// ---------------------------------------------------------------------------
// unified diff
// ---------------------------------------------------------------------------

interface DiffSegment {
  tag: " " | "-" | "+";
  text: string;
  noEol?: boolean;
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  segments: DiffSegment[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A reply is a unified diff when it has real hunk headers plus diff headers. */
export function isUnifiedDiff(text: string): boolean {
  if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text)) return false;
  return /^diff --git /m.test(text) || /^(--- |\+\+\+ )/m.test(text);
}

function parseUnifiedDiff(response: string): { hunks: ParsedHunk[]; sawNoEol: boolean } {
  const lines = response.replace(/\r\n/g, "\n").split("\n");
  const hunks: ParsedHunk[] = [];
  let sawNoEol = false;
  let cur: ParsedHunk | undefined;
  for (const line of lines) {
    const m = HUNK_HEADER.exec(line);
    if (m) {
      cur = { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), segments: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // `diff --git`, `---`/`+++`, index lines
    if (line.startsWith("\\ ")) {
      sawNoEol = true;
      const last = cur.segments[cur.segments.length - 1];
      if (last) last.noEol = true;
      continue;
    }
    const tag = line[0];
    if (tag === " " || tag === "-" || tag === "+") {
      cur.segments.push({ tag, text: line.slice(1) });
      continue;
    }
    // Models sometimes drop the leading space of an empty context line; recover
    // it while the declared old-line count is not yet satisfied.
    if (line === "" && cur.segments.filter((s) => s.tag !== "+").length < cur.oldCount) {
      cur.segments.push({ tag: " ", text: "" });
    }
    // Anything else between hunks is prose — ignore it.
  }
  return { hunks, sawNoEol };
}

function applyUnifiedDiff(body: string, response: string): string {
  const { hunks, sawNoEol } = parseUnifiedDiff(response);
  const lc = lineCountOf(body);
  if (!hunks.length)
    throw new PatchApplyError(
      "invalid",
      "Existing files require a JSON {edits:[{oldText,newText}]} patch, not a rewritten file (unified diff has no @@ hunk headers)",
      { lineCount: lc },
    );
  const rawLines = splitKeepEnds(body);
  const eol = dominantEol(body);
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    let target = hunk.oldStart > 0 ? hunk.oldStart - 1 : 0;
    if (target > rawLines.length)
      throw new PatchApplyError(
        "diff-mismatch",
        `Unified diff hunk @@ -${hunk.oldStart},${hunk.oldCount} @@ starts beyond the end of the file (${lc} lines)`,
        { lineCount: lc, failedLine: Math.min(target + 1, Math.max(lc, 1)) },
      );
    if (target < cursor) target = cursor; // hunks advance monotonically
    while (cursor < target) {
      out.push(rawLines[cursor]);
      cursor++;
    }
    let consumed = 0;
    const pending: string[] = [];
    let mismatchAt = -1;
    for (const seg of hunk.segments) {
      if (seg.tag === "+") {
        const text = styleEol(seg.text, eol);
        pending.push(seg.noEol ? text : text + eol);
        continue;
      }
      const idx = target + consumed;
      const actual = idx < rawLines.length ? stripEol(rawLines[idx]) : undefined;
      if (actual === undefined || actual !== seg.text) {
        mismatchAt = idx;
        break;
      }
      consumed++;
      if (seg.tag === " ") pending.push(rawLines[idx]); // byte-identical original line
      // "-": dropped
    }
    if (mismatchAt >= 0 || consumed !== hunk.oldCount) {
      const at = mismatchAt >= 0 ? mismatchAt : Math.min(target + consumed, Math.max(rawLines.length - 1, 0));
      throw new PatchApplyError(
        "diff-mismatch",
        `Unified diff does not match the file at line ${at + 1}${
          mismatchAt >= 0 ? "" : " (hunk declares more old lines than supplied)"
        }`,
        {
          lineCount: lc,
          failedLine: at + 1,
          nearest: regionAround(rawLines.map(stripEol), Math.max(0, at), hunk.segments.length + 4),
        },
      );
    }
    out.push(...pending);
    cursor = target + consumed;
  }
  while (cursor < rawLines.length) {
    out.push(rawLines[cursor]);
    cursor++;
  }
  let result = out.join("");
  // Honour the "\ No newline at end of file" marker when present; otherwise
  // preserve the original file's final-newline property.
  if (!sawNoEol && body !== "") {
    if (body.endsWith("\n") && !result.endsWith("\n")) result += eol;
    else if (!body.endsWith("\n") && result.endsWith("\n")) result = result.replace(/\r\n$/, "").replace(/\n$/, "");
  }
  if (result.length > MAX_FILE_CHARS)
    throw new PatchApplyError("too-large", "Generated file exceeds the safe size limit", {
      lineCount: lineCountOf(result),
    });
  return result;
}

// ---------------------------------------------------------------------------
// full rewrite
// ---------------------------------------------------------------------------

function applyRewrite(existing: string, response: string, maxBytes: number, explicit: boolean): string {
  const bom = existing.startsWith("\uFEFF");
  const body = bom ? existing.slice(1) : existing;
  let content = explicit
    ? response
    : // Strip a surrounding markdown fence: the opening line goes away with its
      // newline, the closing ``` fence is removed WITHOUT eating the file's own
      // final newline (files conventionally end with one).
      response.replace(/^\s*```[^\n]*\n/, "").replace(/```\s*$/, "");
  if (!content.trim())
    throw new PatchApplyError("invalid", "The full rewrite is empty", { lineCount: lineCountOf(body) });
  if (content.includes(NUL))
    throw new PatchApplyError("invalid", "The full rewrite contains a NUL byte", { lineCount: lineCountOf(body) });
  if (!explicit) {
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > maxBytes)
      throw new PatchApplyError(
        "invalid",
        `Existing files require a JSON {edits:[{oldText,newText}]} patch, not a rewritten file (file is ${bytes} bytes; full rewrites are allowed only below ${maxBytes} bytes)`,
        { lineCount: lineCountOf(body) },
      );
    // Safety net: a reply that shares no meaningful line with the file is far
    // more likely a prose answer than an intentional rewrite. An explicit
    // {"content": …} reply bypasses this guard.
    const fileLines = new Set(
      splitKeepEnds(body)
        .map((l) => stripEol(l).trim())
        .filter((l) => l.length >= 8),
    );
    const newLines = splitKeepEnds(content).map((l) => stripEol(l).trim());
    const overlap = newLines.some((l) => l.length >= 8 && fileLines.has(l));
    if (!overlap && lineCountOf(body) > 2 && fileLines.size > 0)
      throw new PatchApplyError(
        "invalid",
        'The full rewrite shares no unchanged lines with the existing file; reply with a JSON {edits:[{oldText,newText}]} patch, a unified diff, or {"content":"…"} if the rewrite is intentional',
        { lineCount: lineCountOf(body) },
      );
  }
  content = styleEol(content, dominantEol(body));
  if (bom && !content.startsWith("\uFEFF")) content = "\uFEFF" + content;
  else if (!bom && content.startsWith("\uFEFF")) content = content.slice(1);
  if (content.length > MAX_FILE_CHARS)
    throw new PatchApplyError("too-large", "Generated file exceeds the safe size limit", {
      lineCount: lineCountOf(content),
    });
  return content;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Apply a model reply to an existing file. Throws `PatchApplyError` (with line
 * numbers and the closest region) when the reply cannot be applied, or a plain
 * `Error` for invalid edit structures.
 */
export function applyFileEdits(existing: string, response: string, options: ApplyFileEditsOptions = {}): string {
  const maxBytes = options.fullRewriteMaxBytes ?? fullRewriteMaxBytes();
  const bom = existing.startsWith("\uFEFF");
  const body = bom ? existing.slice(1) : existing;
  const finish = (patched: string): string => (bom ? "\uFEFF" + patched : patched);

  // Checked first: diff bodies contain braces that JSON extraction could
  // otherwise mistake for a patch object.
  if (isUnifiedDiff(response)) return finish(applyUnifiedDiff(body, response));

  const parsed = extractJson(response);
  if (Array.isArray(parsed))
    throw new PatchApplyError(
      "invalid",
      "Existing files require a JSON {edits:[{oldText,newText}]} patch, not a rewritten file",
      { lineCount: lineCountOf(body) },
    );
  if (parsed !== undefined && parsed !== null && typeof parsed === "object") {
    const obj = parsed as { edits?: unknown; content?: unknown };
    if (Array.isArray(obj.edits)) return finish(applyEditList(body, obj.edits));
    if (typeof obj.content === "string") return applyRewrite(existing, obj.content, maxBytes, true);
    throw new PatchApplyError(
      "invalid",
      "Existing files require a JSON {edits:[{oldText,newText}]} patch, not a rewritten file",
      { lineCount: lineCountOf(body) },
    );
  }
  // Not a diff and not JSON: treat the reply as a full rewritten file.
  return applyRewrite(existing, response, maxBytes, false);
}

/**
 * Build the corrective instruction sent back to the model after a failed
 * patch (up to MAX_PATCH_CORRECTIONS times). Returns undefined for errors a
 * resend cannot fix.
 */
export function patchCorrectionContext(err: unknown, path: string): string | undefined {
  if (!(err instanceof PatchApplyError) || !err.correctable) return undefined;
  const d = err.detail;
  const parts: string[] = [`Your previous reply could NOT be applied to "${path}".`, `Reason: ${err.message}`];
  if (d.positions?.length)
    parts.push(
      `oldText matches at line(s) ${d.positions.join(", ")}. Copy more surrounding lines from the file so it matches exactly once, or use the first/last lines of the region as anchors.`,
    );
  if (d.nearest) parts.push(`Closest region in the file:\n${d.nearest.excerpt}`);
  else parts.push(`The file has ${d.lineCount} lines.`);
  if (d.failedLine !== undefined) parts.push(`First mismatch is near line ${d.failedLine}.`);
  parts.push(
    'Reply with exactly ONE patch format, copying oldText EXACTLY from the file: JSON {"edits":[{"oldText","newText"}]}, a unified diff (--- a/…, +++ b/…, @@ hunks with exact context), or {"content":"<complete file>"} for an intentional full rewrite of a small file.',
  );
  return parts.join("\n");
}
