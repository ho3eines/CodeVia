import { describe, expect, it } from "vitest";
import { LocalGitError, classifyGitFailure, isLocalGitError, trimGitStderr } from "../github/local-git-error.js";

/* ------------------------------------------------------------------ *
 * LocalGitError contract — the error taxonomy every consumer relies on:
 * routes read `statusCode`, repo-brief/project-state read `status`, the
 * worker reads `retryable`, and half-applied commits carry `committed`.
 * ------------------------------------------------------------------ */

describe("LocalGitError contract", () => {
  it("exposes statusCode and status with the same value", () => {
    const e = new LocalGitError("LOCAL_REF_NOT_FOUND", "x");
    expect(e.statusCode).toBe(404);
    expect(e.status).toBe(404);
  });

  it("maps each code to the agreed HTTP status", () => {
    const expected: Array<[LocalGitError["code"], number]> = [
      ["LOCAL_GIT_UNAVAILABLE", 503],
      ["LOCAL_REPO_NOT_FOUND", 404],
      ["LOCAL_REF_NOT_FOUND", 404],
      ["LOCAL_PATH_NOT_FOUND", 404],
      ["LOCAL_INVALID_INPUT", 400],
      ["LOCAL_STALE_PARENT", 409],
      ["LOCAL_LOCKED", 423],
      ["LOCAL_MERGE_CONFLICT", 409],
      ["LOCAL_HEAD_MOVED", 409],
      ["LOCAL_META_CORRUPT", 500],
      ["LOCAL_GIT_FAILED", 502],
    ];
    for (const [code, status] of expected) {
      expect(new LocalGitError(code, "m").statusCode, code).toBe(status);
    }
  });

  it("marks only the transient codes as retryable", () => {
    const retryable = ["LOCAL_GIT_UNAVAILABLE", "LOCAL_LOCKED", "LOCAL_GIT_FAILED"] as const;
    const permanent = [
      "LOCAL_REPO_NOT_FOUND",
      "LOCAL_REF_NOT_FOUND",
      "LOCAL_PATH_NOT_FOUND",
      "LOCAL_INVALID_INPUT",
      "LOCAL_STALE_PARENT",
      "LOCAL_MERGE_CONFLICT",
      "LOCAL_HEAD_MOVED",
      "LOCAL_META_CORRUPT",
    ] as const;
    for (const code of retryable) expect(new LocalGitError(code, "m").retryable, code).toBe(true);
    for (const code of permanent) expect(new LocalGitError(code, "m").retryable, code).toBe(false);
  });

  it("defaults committed to false and keeps the sha only when given", () => {
    const plain = new LocalGitError("LOCAL_GIT_FAILED", "m");
    expect(plain.committed).toBe(false);
    expect(plain.sha).toBeUndefined();
    const after = new LocalGitError("LOCAL_GIT_FAILED", "push", { committed: true, sha: "abc1234" });
    expect(after.committed).toBe(true);
    expect(after.sha).toBe("abc1234");
  });

  it("carries provider local-git, the name and the code", () => {
    const e = new LocalGitError("LOCAL_META_CORRUPT", "m");
    expect(e.provider).toBe("local-git");
    expect(e.name).toBe("LocalGitError");
    expect(e.code).toBe("LOCAL_META_CORRUPT");
  });

  it("keeps the cause when one is supplied", () => {
    const original = new Error("ENOENT");
    const e = new LocalGitError("LOCAL_GIT_UNAVAILABLE", "m", { cause: original });
    expect(e.cause).toBe(original);
  });

  it("is recognised by isLocalGitError and not by plain errors", () => {
    expect(isLocalGitError(new LocalGitError("LOCAL_GIT_FAILED", "m"))).toBe(true);
    expect(isLocalGitError(new Error("m"))).toBe(false);
    expect(isLocalGitError(undefined)).toBe(false);
  });
});

describe("classifyGitFailure", () => {
  it("classifies an index lock as LOCAL_LOCKED (retryable)", () => {
    const e = classifyGitFailure(
      "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running...",
      "git read-tree failed",
    );
    expect(e.code).toBe("LOCAL_LOCKED");
    expect(e.retryable).toBe(true);
    expect(e.statusCode).toBe(423);
  });

  it("classifies a locked branch reference as LOCAL_LOCKED", () => {
    const e = classifyGitFailure("error: cannot lock ref 'refs/heads/main'", "update-ref failed");
    expect(e.code).toBe("LOCAL_LOCKED");
  });

  it("classifies a compare-and-swap mismatch as LOCAL_STALE_PARENT", () => {
    const e = classifyGitFailure(
      "fatal: update_ref failed for ref 'refs/heads/main': cannot lock ref 'refs/heads/main': is at 0e1882ef5d04e702a30b8d80c115665d9a29d923 but expected 1234567890123456789012345678901234567890",
      "git update-ref failed",
    );
    expect(e.code).toBe("LOCAL_STALE_PARENT");
    expect(e.statusCode).toBe(409);
    expect(e.retryable).toBe(false);
  });

  it("falls back to LOCAL_GIT_FAILED with stderr attached", () => {
    const e = classifyGitFailure("fatal: bad object", "git cat-file failed");
    expect(e.code).toBe("LOCAL_GIT_FAILED");
    expect(e.message).toMatch(/git cat-file failed: fatal: bad object/);
  });

  it("uses a generic message when stderr is empty", () => {
    expect(classifyGitFailure("", "git failed").message).toMatch(/git exited with an error/);
  });
});

describe("trimGitStderr", () => {
  it("removes trailing whitespace and caps the length", () => {
    expect(trimGitStderr("abc   \n\n")).toBe("abc");
    expect(trimGitStderr("x".repeat(500), 10).length).toBe(10);
  });
});
