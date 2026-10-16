# Local Git CLI Mode (100% offline)

Local Git mode makes CodeVia run entirely on one machine: no GitHub API, no
OAuth, no `GITHUB_TOKEN`. Every read and write goes through the **git binary
installed on that machine**, and the platform runs directly on your local
repositories.

```
LOCAL_GIT_MODE=true
LOCAL_REPOS_DIR=./repos        # your repositories live here
```

## What it does

| Concern | Behaviour in local mode |
| --- | --- |
| Repository discovery | `<dir>/<owner>/<repo>`, `<dir>/<owner>/<repo>.git` (bare) and flat `<dir>/<repo>` (owner `local`) |
| Reads | `git ls-tree` / `git cat-file` — millisecond reads straight from disk |
| Commits | `git hash-object` + `read-tree`/`update-index` in a **private temp index**, then `commit-tree` and a compare-and-swap `update-ref` |
| Developer's working copy | Never touched: only the paths the agent changed are synced, and only when they carry no uncommitted local changes. Your staged files, unstaged edits and open IDE state are left exactly as they are |
| Branches | Real branches (`agent-task-*`), created with `git branch` |
| Pull requests | Git-platform concepts — stored in `<repo>/.git/codevia-local-meta.json`, never inside the working tree |
| Merges | Real git: `git merge-tree --write-tree` + `commit-tree` (+ `-p` twice for merge commits) + CAS `update-ref`. **No `git worktree` is ever created** |
| Push | Optional `LOCAL_GIT_AUTO_PUSH=true` pushes with **your** git (Credential Manager / SSH keys). A failed push is a warning; commits always stay local |
| CI / merge gate | `local-git-integrity` (commit exists in the object DB) + optional **real** `local-verify` check running `LOCAL_GIT_VERIFY_CMD` (e.g. `dotnet test`) |

## Safety properties (all covered by tests)

- **Compare-and-swap commits** — a write built against a stale `parentSha` is
  refused with `LOCAL_STALE_PARENT` instead of overwriting newer work.
- **Concurrent state saves** — writes are serialized per repository; five
  concurrent `CodeVia/*` saves all land (exact `rev-list --count` verified).
- **Your data wins** — a file with uncommitted local changes is never
  overwritten by an agent commit; the branch advances and the file is skipped
  with a warning.
- **No silent half-applied commits** — if the branch moved but the working-tree
  sync failed (e.g. `index.lock` held by the IDE), the error carries
  `committed: true` and the new `sha`. The residue heals automatically on the
  next commit to the same path.
- **Corrupt metadata never destroys data** — a broken `codevia-local-meta.json`
  raises `LOCAL_META_CORRUPT`; it is never silently reset, and every rewrite
  keeps a `.bak`.
- **Stale lock recovery** — a ref/index lock older than
  `LOCAL_GIT_STALE_LOCK_MS` (default 10 min) is removed and the operation
  retried once; a *fresh* lock fails fast with retryable `LOCAL_LOCKED`.
- **Metadata writes are serialized per repository** — a concurrent merge and
  PR creation can never erase each other's `codevia-local-meta.json` update.
- **Large commits are batched** — hundreds of files never overflow the Windows
  argv limit (hash-object / update-index / restore / status run in chunks).

## Error contract

All failures are `LocalGitError` (`src/github/local-git-error.ts`) with a
stable `code`, HTTP `status`/`statusCode`, `retryable`, and `committed`:

`LOCAL_GIT_UNAVAILABLE` 503 · `LOCAL_REPO_NOT_FOUND` 404 ·
`LOCAL_REF_NOT_FOUND` 404 · `LOCAL_PATH_NOT_FOUND` 404 ·
`LOCAL_INVALID_INPUT` 400 · `LOCAL_STALE_PARENT` 409 · `LOCAL_LOCKED` 423 ·
`LOCAL_MERGE_CONFLICT` 409 · `LOCAL_HEAD_MOVED` 409 ·
`LOCAL_META_CORRUPT` 500 · `LOCAL_GIT_FAILED` 502

## Requirements

- git **2.38+** on PATH (or `LOCAL_GIT_BIN` pointing at it) — for
  `merge-tree --write-tree`. Older git falls back to a throwaway worktree that
  is always cleaned up.
- A real AI model provider (Ollama, OpenRouter, OpenAI, ...) or Mock AI for
  simulation. Local repositories are real repositories (`kind: "real"`), so
  simulated agent code is never committed to them without a real model.

## Running

```bash
npm install
LOCAL_GIT_MODE=true LOCAL_REPOS_DIR=./repos npm run dev
# or: npm run build && LOCAL_GIT_MODE=true npm start
```

Put your projects under `LOCAL_REPOS_DIR` (e.g. `repos/my-owner/my-project`)
and they appear in the repository picker. The repo mirror is disabled
automatically in local mode (the repositories are already local — cloning them
again from a URL template would be pure overhead).

## Tests

```bash
npx vitest run src/tests/local-git-error.test.ts \
               src/tests/local-git-service.compat.test.ts \
               src/tests/local-git-service.property.test.ts \
               src/tests/local-git-service.failure.test.ts
```

- `local-git-error.test.ts` — the error contract (13 tests)
- `local-git-service.compat.test.ts` — 31 end-to-end scenarios against real git
  repositories (discovery, CodeVia/* state, CAS, working-copy safety, PRs,
  merge gate)
- `local-git-service.property.test.ts` — seeded property tests (byte-identical
  round-trips, model-based write/delete equivalence, concurrency, merge
  unions) across 5 seeds each
- `local-git-service.failure.test.ts` — crash/lock/corruption/offline-push
  recovery scenarios A–J (including the metadata race and a 200-file batch)

## Bootstrapping a repository

A repository that already carries a valid `CodeVia/` state folder is onboarded
with no model at all — reads and writes go straight through local git. A
repository *without* state needs a real AI model to author the initial
definitions (this is deliberate: simulated state is never written to a real
repository, local or not). Configure Ollama/OpenRouter/any provider first, or
import an existing state archive — see below.

### Self-bootstrap of new/empty repositories

Three situations that used to fail with `branch main is unavailable` are now
handled automatically:

1. **A project on a folder that does not exist (or was never `git init`-ed):**
   the first CodeVia *write* initializes the repository at
   `LOCAL_REPOS_DIR/<owner>/<name>`. Reads never create repositories.
2. **A fresh `git init` with zero commits (unborn HEAD):** the first write
   becomes the root commit (a `README.md` seed), so state bootstrap can run.
3. **A repository whose default branch is `master` (or anything ≠ `main`):**
   the project adopts the repository's actual default branch once, instead of
   failing every read. Adoption only happens when the configured branch does
   not exist in the repository.

### Model-free state import — `POST /projects/:id/state-import`

Without a model, POST the base64 zip of an existing `CodeVia/` folder (archive
root or one wrapping folder — a GitHub "Download ZIP" works) and the platform
commits it to the repository and loads the definitions:

```bash
curl -X POST http://localhost:3000/projects/<ID>/state-import \
  -H 'content-type: application/json' \
  --data "{\"archive\": \"$(base64 -w0 codevia-state.zip)\"}"
```

Only `CodeVia/**` paths are imported (8 MB/file, 32 MB total, 200 files caps —
same as state commits); encrypted entries and path traversal are rejected;
existing repository files are never deleted. The full model-less flow works:
project creation reports the model guard (422) but the project row and the
seeded repository survive — import the archive and everything loads.
