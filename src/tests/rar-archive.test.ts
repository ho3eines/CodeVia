import { describe, expect, it, vi } from "vitest";
import { extractProjectRar, type RarProcessOutput, type RarProcessRunner } from "../projects/rar-archive.js";
import { DEFAULT_PROJECT_ARCHIVE_LIMITS, type ProjectArchiveLimits } from "../projects/project-archive.js";

/* ------------------------------------------------------------------ *
 * RAR import.
 *
 * 7z is an external binary, so the tests inject the process runner: they pin
 * the listing/streaming protocol, the size and link checks, and the fact that
 * entry names are passed after `--` (never interpreted as switches).
 * ------------------------------------------------------------------ */

const limits = (patch: Partial<ProjectArchiveLimits> = {}): ProjectArchiveLimits => ({
  ...DEFAULT_PROJECT_ARCHIVE_LIMITS,
  ...patch,
});

const fileRecord = (path: string, size: number, packed = size, extra: string[] = []): string[] => [
  `Path = ${path}`,
  `Size = ${size}`,
  `Packed Size = ${packed}`,
  "Attributes = A",
  ...extra,
  "----------",
];

const listing = (entries: string[][]): string =>
  ["Path = upload.rar", "Type = Rar", "Physical Size = 2048", "----------", ...entries.flat()].join("\n");

const empty: RarProcessOutput = { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };

function runnerWith(files: Record<string, Buffer>, listText = ""): RarProcessRunner {
  return async (_binary, args) => {
    if (args[0] === "l") return { code: 0, stdout: Buffer.from(listText), stderr: Buffer.alloc(0) };
    const entry = args[args.length - 1];
    const content = files[entry];
    if (!content) return { code: 2, stdout: Buffer.alloc(0), stderr: Buffer.from("missing") };
    return { code: 0, stdout: content, stderr: Buffer.alloc(0) };
  };
}

describe("extractProjectRar", () => {
  it("lists with 7z and streams each file back", async () => {
    const files = {
      "src/index.ts": Buffer.from("export {}"),
      "README.md": Buffer.from("# hi"),
    };
    const run = vi.fn(
      runnerWith(
        files,
        listing([
          fileRecord("src/index.ts", files["src/index.ts"].length),
          fileRecord("README.md", files["README.md"].length),
        ]),
      ),
    );
    const result = await extractProjectRar(Buffer.from("rar-bytes"), {
      limits: limits(),
      run,
      binaryCandidates: ["7z"],
    });
    expect(result.map((file) => file.path)).toEqual(["src/index.ts", "README.md"]);
    expect(result[0].content.toString("utf8")).toBe("export {}");

    const extraction = run.mock.calls.find((call) => call[1][0] === "e");
    expect(extraction).toBeTruthy();
    expect(extraction![1]).toEqual(expect.arrayContaining(["-so", "-spd", "-bd", "-bb0", "--", "src/index.ts"]));
  });

  it("reports a missing 7z binary as 503 instead of falling back to the host", async () => {
    const run: RarProcessRunner = async () => {
      throw Object.assign(new Error("spawn 7z ENOENT"), { code: "ENOENT" });
    };
    await expect(
      extractProjectRar(Buffer.from("x"), { limits: limits(), run, binaryCandidates: ["7z", "7zz"] }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("rejects a corrupt listing and an empty archive", async () => {
    const bad = vi.fn(async () => ({ code: 2, stdout: Buffer.alloc(0), stderr: Buffer.from("boom") }));
    await expect(
      extractProjectRar(Buffer.from("x"), { limits: limits(), run: bad, binaryCandidates: ["7z"] }),
    ).rejects.toThrow(/could not list/i);

    const emptyListing = runnerWith({}, listing([]));
    await expect(
      extractProjectRar(Buffer.from("x"), { limits: limits(), run: emptyListing, binaryCandidates: ["7z"] }),
    ).rejects.toThrow(/no regular files/i);
  });

  it("rejects unsafe paths, links and declared oversize entries", async () => {
    const cases: Array<[string[], RegExp]> = [
      [fileRecord("../evil.txt", 1), /Invalid project archive/],
      [fileRecord("link.txt", 1, 1, ["Symbolic Link = /etc/passwd"]), /symbolic or hard link/i],
      [fileRecord("huge.bin", 50), /per-file limit/],
      [fileRecord("bomb.txt", 10, 0.05), /compression ratio/i],
    ];
    for (const [record, error] of cases) {
      await expect(
        extractProjectRar(Buffer.from("x"), {
          limits: limits({ maxFileBytes: 10, maxCompressionRatio: 100 }),
          run: runnerWith({}, listing([record])),
          binaryCandidates: ["7z"],
        }),
      ).rejects.toThrow(error);
    }
  });

  it("skips directories and enforces the file count", async () => {
    const directory = ["Path = src", "Size = 0", "Packed Size = 0", "Folder = +", "----------"];
    const run = runnerWith({ "a.txt": Buffer.from("a") }, listing([directory, fileRecord("a.txt", 1)]));
    const files = await extractProjectRar(Buffer.from("x"), {
      limits: limits(),
      run,
      binaryCandidates: ["7z"],
    });
    expect(files.map((file) => file.path)).toEqual(["a.txt"]);

    await expect(
      extractProjectRar(Buffer.from("x"), {
        limits: limits({ maxFiles: 1 }),
        run: runnerWith({}, listing([fileRecord("a.txt", 1), fileRecord("b.txt", 1)])),
        binaryCandidates: ["7z"],
      }),
    ).rejects.toThrow(/too many entries/i);
  });

  it("rejects a size mismatch, a duplicate path and an oversized upload", async () => {
    const mismatch = async (_binary: string, args: string[]) =>
      args[0] === "l"
        ? { code: 0, stdout: Buffer.from(listing([fileRecord("a.txt", 5)])), stderr: empty.stderr }
        : { ...empty, stdout: Buffer.from("abcd") };
    await expect(
      extractProjectRar(Buffer.from("x"), { limits: limits(), run: mismatch, binaryCandidates: ["7z"] }),
    ).rejects.toThrow(/size mismatch/i);

    await expect(
      extractProjectRar(Buffer.from("x"), {
        limits: limits(),
        run: runnerWith({}, listing([fileRecord("A.txt", 1), fileRecord("a.txt", 1)])),
        binaryCandidates: ["7z"],
      }),
    ).rejects.toThrow(/duplicate or case-colliding/i);

    await expect(
      extractProjectRar(Buffer.alloc(2048), {
        limits: limits({ maxUploadBytes: 1024 }),
        run: runnerWith({}, listing([])),
        binaryCandidates: ["7z"],
      }),
    ).rejects.toThrow(/compressed archive exceeds/i);
  });
});
