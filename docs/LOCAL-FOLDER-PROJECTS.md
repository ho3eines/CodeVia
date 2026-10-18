# Local Folder Projects (server filesystem)

Create CodeVia projects from the **server's filesystem** — no GitHub
repository, OAuth or token required. There are three local entry points:

| Source | Endpoint | What you get |
|---|---|---|
| A folder on the server | `POST /projects/from-local` | `sourceType: "local"` project + analysis; **no repository** unless `gitInit: true` |
| A `.zip` / `.rar` upload | `POST /projects/import` | local Git repository (`local/<slug>`, one initial commit) + project |
| Nothing yet | `POST /projects/new-local` | empty local Git repository with a `README.md` commit |

GitHub import (the default `POST /projects` flow) remains fully available;
nothing about it changed.

**Analysis-only projects.** A folder project created without `gitInit: true`
has no repository at all. Its analysis, files, tasks and settings are kept, but
any execution request is refused up front with `409` and
`{"repositoryRequired": true}` — this covers `POST /projects/:id/ask` in
`autonomous`, `agent` and `workflow` modes (including chat and Telegram
dispatch), because every one of them stages work in a repository.
`executionMode: "simulation"` still works because it only returns a plan, and
`POST /projects/scan` keeps returning the folder's analysis. To make the project implementable, re-create it with
`gitInit: true`, import a ZIP/RAR, or link a repository from the project's
Settings; the API message says the same thing.

This is a *server-side* feature: the platform process must run where it can see
the folders (normal server, VPS, Docker with a mounted volume). It is not
available on serverless platforms with an ephemeral filesystem.

## Configuration

```bash
# Directories the server may browse/scan. Comma-separated. SECURITY: unset
# means only the CodeVia install directory is allowed.
CODEVIA_ALLOWED_ROOTS=D:/Hermes/repos,/var/www

# Limits (defaults shown)
CODEVIA_FS_MAX_FILE_KB=1024        # max single-file read (KB)
CODEVIA_FS_MAX_ENTRIES=5000        # max entries per directory listing
CODEVIA_FS_MAX_DEPTH=32            # max symlink resolution depth
CODEVIA_FS_SCAN_MAX_FILES=20000    # max files collected per scan
CODEVIA_FS_SCAN_MAX_DEPTH=16       # max directory depth per scan

# ZIP/RAR import limits (defaults shown; all validated at boot)
PROJECT_IMPORT_MAX_UPLOAD_BYTES=26214400      # 25 MiB compressed upload
PROJECT_IMPORT_MAX_FILES=5000
PROJECT_IMPORT_MAX_FILE_BYTES=26214400        # 25 MiB per extracted file
PROJECT_IMPORT_MAX_TOTAL_BYTES=209715200      # 200 MiB expanded total
PROJECT_IMPORT_MAX_COMPRESSION_RATIO=500      # zip-bomb guard
# PROJECT_IMPORT_7Z_BIN=/usr/bin/7z            # only for .rar; unset = 7z/7zz on PATH

# Imported/new local projects become Git repositories under
# <LOCAL_REPOS_DIR>/<owner>/<repo>. Set it to a persistent volume.
LOCAL_REPOS_DIR=./repos
```

## Endpoints

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/fs/list?path=…&limit=…` | `project.write` | List a directory (no path → the allowed roots). Directories first, hidden/sensitive files flagged. |
| `GET` | `/fs/stat?path=…` | `project.write` | Typed metadata for one path (kind, size, mtime, readable, sensitive). |
| `POST` | `/projects/scan` | `project.write` | Body `{ path }` → full `ProjectAnalysis`. |
| `POST` | `/projects/from-local` | `project.write` | Body `{ path, gitInit?, overrides? }` → creates a `sourceType: "local"` project (201). `gitInit: true` copies the safe files into `LOCAL_REPOS_DIR` and registers the repository. |
| `POST` | `/projects/import` | `project.write` | `multipart/form-data` with exactly **one** `.zip` or `.rar` file; optional fields `name`, `description`, `slug` → local Git project (201). |
| `POST` | `/projects/new-local` | `project.write` | Body `{ name, description?, slug? }` → local Git repository with an initial `README.md` commit (201). |
| `GET` | `/projects/:id/analysis` | owner (`project.read`) | The stored analysis of a local project. |

All routes sit behind the global auth guard (session or `REQUIRE_AUTH=false`
demo owner) *and* an RBAC permission check, like the admin routes.

```bash
# scan a folder
curl -s localhost:8080/projects/scan -H 'content-type: application/json' \
  -d '{"path":"D:/Hermes/repos/shop3"}' | jq .analysis.suggestions

# create a project from it, with overrides
curl -s localhost:8080/projects/from-local -H 'content-type: application/json' \
  -d '{"path":"D:/Hermes/repos/shop3","overrides":{"name":"Shop 3"}}'

# link the folder as a real local Git repository (agents can commit to it)
curl -s localhost:8080/projects/from-local -H 'content-type: application/json' \
  -d '{"path":"D:/Hermes/repos/shop3","gitInit":true,"overrides":{"name":"Shop 3"}}'

# import an archive (creates local/<slug> with one initial commit)
curl -s localhost:8080/projects/import \
  -F name='Shop 3' -F file=@shop3.zip

# start from nothing
curl -s localhost:8080/projects/new-local -H 'content-type: application/json' \
  -d '{"name":"Shop 3"}'
```

### What the archive import guarantees

- **Only `.zip` and `.rar`** (by extension). Anything else → `400`.
- **No path is written before validation.** Absolute paths, `..`, backslashes,
  empty/`.` segments, Windows reserved names (`con`, `nul`, …), duplicate or
  case-colliding entries and paths longer than 240 chars are rejected.
- **No links or special files** (ZIP Unix mode `120000`, RAR link attributes) —
  a project import never creates a symlink.
- **Bounded expansion**: upload size, entry count, per-file size, total expanded
  size and compression ratio are enforced (zip-bomb guard). Encrypted ZIPs,
  multi-disk/ZIP64 archives and unsupported methods are refused.
- **CRC32 is verified** for every extracted entry.
- **Secrets never land in Git**: `.env*`, `*.pem`, `*.key`, `id_rsa*`,
  `credentials*`, `.npmrc`, `.ssh/`, `.aws/`, … are dropped (and reported in
  `analysis.warnings`), as are `.git/`, `.hg/`, `.svn/`.
- **One atomic initial commit** in a fresh `local/<slug>` repository; the
  project gets the detected stack, editable `commands` and a folder analysis.
- A single GitHub-style wrapper directory (`repo-main/`) is stripped only when it
  contains a recognizable project-root manifest, so monorepos survive intact.

`.rar` support needs `7z`/`7zz` on the server (`PROJECT_IMPORT_7Z_BIN` when it is
not on `PATH`); without it the endpoint answers `503` instead of guessing.

## What the scan detects

Project name (manifest → folder name), description (manifest → README),
languages (extension histogram), frameworks/libraries (dependencies + marker
files), package manager (lockfiles), monorepo/workspaces, scripts, entry
points, config files, license, Docker/CI presence, test frameworks, git facts
(branch, **redacted** remote, last commit) and environment file *names* —
never values. The full shape is the `ProjectAnalysis` type in
`src/domain/entities.ts` (stored verbatim on the project document).

## Safety model

- **Allowed roots only.** Paths are resolved (and symlinks realpath'd) before
  every operation; anything that escapes the roots is refused with
  `FS_PATH_OUTSIDE_ROOTS` (403). Default root: the CodeVia install directory.
  Containment is case-insensitive on Windows/macOS (NTFS/APFS), so `d:/repos`
  matches a `D:/Repos` root.
- **Sensitive files are never opened.** `.env*`, `id_rsa*`, `*.pem`, `*.key`,
  `credentials*`, `.npmrc`, `.ssh/`, `.aws/`, … are described by metadata only;
  `readFile` refuses them with `FS_SENSITIVE_BLOCKED` (403). Scans list their
  names (so the UI can show a locked badge) but never their contents.
- **Bounded work.** File-size, listing, scan-file, scan-depth and concurrency
  limits; the walk never follows symlinks and skips heavy folders
  (`node_modules`, `dist`, `build`, `.git`, …).
- **Stable error contract.** 11 `FS_*` codes with `statusCode`/`status`/
  `retryable`/`detail` (`src/filesystem/filesystem-error.ts`), mirroring
  `LocalGitError`.
- **No content leaves the process** — analysis JSON contains names and parsed
  manifest facts only, and git remote URLs are credential-redacted.

## Local projects in the platform

A project created by **folder scan without `gitInit`** carries no repository:
`configRepo` stays empty and `repositories` is `[]` until one is linked
explicitly. Repo-backed features (state sync, memory writes, agents' repository
context, sandbox execution) degrade gracefully — `repo-status` reports *why* the
repository cannot be read — instead of failing project creation or reads.
`GET /projects/:id` and the list endpoint work normally. The auto-bootstrap hook
skips these projects (their state lives in the folder analysis, not in a
`CodeVia/` folder).

Projects created with **`gitInit: true`, archive import, or `/projects/new-local`**
*do* have a repository: `sourceType` stays `local`, `configRepo` is
`local/<slug>` and the working copy lives under `LOCAL_REPOS_DIR`. They are
handled by the local Git backend (`src/github/local-git-service.ts`), so
agents can branch, commit and open Draft PRs without any GitHub connection. To
give one of them real CI later, link a GitHub repository with the existing
project repository endpoints.

To later connect a repository (GitHub or local-git mode), use the existing
project update/repository endpoints — the project then behaves like any
repository-backed project while keeping its `analysis`.

## Conflicts

- Same folder linked again → `409` "This folder is already linked to project …"
- Duplicate slug → `409` "A project with slug … already exists"

## Tests

```bash
npx vitest run src/tests/filesystem-service.test.ts src/tests/project-analyzer.test.ts \
  src/tests/local-project-routes.test.ts src/tests/project-import-routes.test.ts \
  src/tests/project-archive.test.ts src/tests/rar-archive.test.ts
```

covers: path traversal/symlink-escape prevention, sensitive-file blocking,
listing/stat limits, language/framework/package-manager/script detection,
git metadata redaction (canary secrets never appear in the analysis JSON),
project creation without GitHub, conflict handling, unauthorized-path
rejection, auth gating and legacy-project compatibility — plus ZIP/RAR
traversal, links, CRC corruption, zip bombs, the multipart import route,
wrapper-directory stripping, secret exclusion and the initial local commit.
