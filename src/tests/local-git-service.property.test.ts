import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGitService } from "../github/local-git-service.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn() })) },
}));

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Dev",
  GIT_AUTHOR_EMAIL: "dev@local",
  GIT_COMMITTER_NAME: "Dev",
  GIT_COMMITTER_EMAIL: "dev@local",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/* ---------- deterministic PRNG (mulberry32): failures are reproducible via the seed ---------- */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)],
    text: (maxLen: number) => {
      const alphabet = ["a", "Z", "0", " ", "\n", "\r\n", "\t", "ü", "中", "😀", "{", "}", "#", "-", "‌"];
      const n = Math.floor(next() * (maxLen + 1));
      let out = "";
      for (let i = 0; i < n; i++) out += alphabet[Math.floor(next() * alphabet.length)];
      return out;
    },
  };
}

const SEEDS = [1, 7, 42, 1337, 2024];
const ITER = 15;

let root: string;
let svc: LocalGitService;
const ref = { owner: "acme", name: "shop" };
const repoDir = () => join(root, "acme", "shop");

function makeRepo(branch = "main") {
  const dir = repoDir();
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", branch);
  writeFileSync(join(dir, "README.md"), "x");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
}
const head = async (branch = "main") => (await svc.listBranches(ref)).find((b) => b.name === branch)!.sha;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cv-prop-"));
  svc = new LocalGitService({ rootDir: root, defaultOwner: "local", autoPush: false, autoFetch: false });
  makeRepo();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("LocalGit property: content round-trip", () => {
  for (const seed of SEEDS) {
    it(`P1 any UTF-8 content (incl. CRLF, emoji, empty) round-trips byte-identical [seed ${seed}]`, async () => {
      const r = rng(seed);
      for (let i = 0; i < ITER; i++) {
        const content = r.text(200);
        const path = `CodeVia/p${i}.md`;
        await svc.commit(ref, "main", `p${i}`, [{ path, content }], await head());
        const got = await svc.getFile(ref, path, "main");
        expect(got?.content, `seed=${seed} iter=${i}`).toBe(content);
      }
    });
  }
});

describe("LocalGit property: model-based state equivalence", () => {
  for (const seed of SEEDS) {
    it(`P2 random write/delete sequences match an in-memory model [seed ${seed}]`, async () => {
      const r = rng(seed);
      const model = new Map<string, string>();
      const names = ["a.md", "b.md", "c.md", "sub/d.md", "sub/e.md"];
      for (let i = 0; i < ITER; i++) {
        const name = r.pick(names);
        const path = `CodeVia/${name}`;
        if (model.size > 0 && r.int(0, 2) === 0) {
          const victim = r.pick([...model.keys()]);
          await svc.deleteFiles(ref, "main", `del ${i}`, [victim], await head());
          model.delete(victim);
        } else {
          const content = r.text(60);
          await svc.commit(ref, "main", `w ${i}`, [{ path, content }], await head());
          model.set(path, content);
        }
        const listed = (await svc.listFiles(ref, "main", "CodeVia").catch(() => []))
          .filter((e) => e.type === "blob")
          .map((e) => e.path)
          .sort();
        expect(listed, `seed=${seed} step=${i}`).toEqual([...model.keys()].sort());
      }
      for (const [p, c] of model) {
        expect((await svc.getFile(ref, p, "main"))?.content, `seed=${seed} ${p}`).toBe(c);
      }
    });
  }
});

describe("LocalGit property: path normalization", () => {
  for (const seed of SEEDS) {
    it(`P3 backslash and slash spellings address the same file [seed ${seed}]`, async () => {
      const r = rng(seed);
      for (let i = 0; i < ITER; i++) {
        const segs = Array.from({ length: r.int(1, 3) }, (_, k) => `seg${k}${r.int(0, 9)}`);
        const slash = `CodeVia/${segs.join("/")}.md`;
        const back = slash.replace(/\//g, "\\");
        const content = `v${i}`;
        await svc.commit(ref, "main", `n${i}`, [{ path: slash, content }], await head());
        expect((await svc.getFile(ref, back, "main"))?.content, `seed=${seed} iter=${i} ${back}`).toBe(content);
      }
    });

    it(`P4 traversal-like segments never read or write outside the repository [seed ${seed}]`, async () => {
      const r = rng(seed);
      const bad = ["..", ".", "", "a/../../etc", "./x", "a//b"];
      for (let i = 0; i < ITER; i++) {
        const p = `${r.pick(bad)}/${r.int(0, 99)}`;
        expect(await svc.getFile(ref, p, "main"), `seed=${seed} path=${p}`).toBeUndefined();
      }
    });
  }
});

describe("LocalGit property: compare-and-swap and concurrency", () => {
  for (const seed of SEEDS) {
    it(`P5 any stale parent is refused; the current parent (or none) always succeeds [seed ${seed}]`, async () => {
      const r = rng(seed);
      for (let i = 0; i < 6; i++) {
        const stale = await head();
        await svc.commit(ref, "main", `adv ${i}`, [{ path: `CodeVia/s${i}.md`, content: "s" }], stale);
        const current = await head();
        expect(current).not.toBe(stale);
        await expect(
          svc.commit(ref, "main", "stale", [{ path: `CodeVia/x${i}.md`, content: "x" }], stale),
        ).rejects.toThrow(/changed after inspection/);
        // a valid parent — either the fresh head or no parent at all — must work:
        const cur = r.int(0, 1) === 0 ? current : undefined;
        await svc.commit(ref, "main", "ok", [{ path: `CodeVia/ok${i}.md`, content: "ok" }], cur);
      }
    });

    it(`P6 N concurrent commits without a parent all land; history length is exact [seed ${seed}]`, async () => {
      const r = rng(seed);
      let total = 0;
      for (let batch = 0; batch < 3; batch++) {
        const n = r.int(2, 6);
        await Promise.all(
          Array.from({ length: n }, (_, k) =>
            svc.commit(ref, "main", `b${batch}-${k}`, [{ path: `CodeVia/b${batch}-${k}.md`, content: "c" }]),
          ),
        );
        total += n;
      }
      expect(git(repoDir(), "rev-list", "--count", "main")).toBe(String(1 + total));
      const files = (await svc.listFiles(ref, "main", "CodeVia")).filter((e) => e.type === "blob");
      expect(files).toHaveLength(total);
    });
  }
});

describe("LocalGit property: pull requests and merges", () => {
  for (const seed of SEEDS) {
    it(`P7 PR creation is idempotent and numbers are dense [seed ${seed}]`, async () => {
      const r = rng(seed);
      const k = r.int(2, 5);
      const created: number[] = [];
      for (let i = 0; i < k; i++) {
        await svc.createBranch(ref, `f${i}`, await head());
        const pr = await svc.createPullRequest(ref, `t${i}`, "", `f${i}`, "main");
        created.push(pr.number);
        const again = await svc.createPullRequest(ref, `t${i}`, "", `f${i}`, "main");
        expect(again.number).toBe(pr.number);
      }
      expect(created).toEqual(Array.from({ length: k }, (_, i) => i + 1));
      expect(await svc.listPullRequests(ref)).toHaveLength(k);
    });

    it(`P8 disjoint squash merges produce the union of all files [seed ${seed}]`, async () => {
      const r = rng(seed);
      const k = r.int(2, 4);
      const base = await head();
      const expected: string[] = [];
      const numbers: number[] = [];
      for (let i = 0; i < k; i++) {
        const path = `src/mod${i}.ts`;
        expected.push(path);
        await svc.createBranch(ref, `m${i}`, base);
        await svc.commit(ref, `m${i}`, `m${i}`, [{ path, content: `export const v${i} = ${i};` }], base);
        numbers.push((await svc.createPullRequest(ref, `m${i}`, "", `m${i}`, "main")).number);
      }
      for (const n of numbers) {
        const res = await svc.mergePullRequest(ref, n, { method: "squash" });
        expect(res.merged, `pr ${n}`).toBe(true);
      }
      const names = (await svc.listFiles(ref, "main", "src")).map((e) => e.path).sort();
      expect(names).toEqual([...expected].sort());
    });
  }
});
