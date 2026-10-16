# Local Folder Projects (server filesystem)

Create CodeVia projects from folders on the **server's filesystem** — no GitHub
repository, OAuth or token required. A folder is scanned, structured metadata is
extracted, and a project is created with `sourceType: "local"`. GitHub import
(the default `POST /projects` flow) remains fully available; nothing about it
changed.

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
```

## Endpoints

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/fs/list?path=…&limit=…` | `project.write` | List a directory (no path → the allowed roots). Directories first, hidden/sensitive files flagged. |
| `GET` | `/fs/stat?path=…` | `project.write` | Typed metadata for one path (kind, size, mtime, readable, sensitive). |
| `POST` | `/projects/scan` | `project.write` | Body `{ path }` → full `ProjectAnalysis`. |
| `POST` | `/projects/from-local` | `project.write` | Body `{ path, overrides? }` → creates a `sourceType: "local"` project (201). |
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
```

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

A local project carries **no repository**: `configRepo` stays empty and
`repositories` is `[]` until one is linked explicitly. Repo-backed features
(state sync, memory writes, agents' repository context) degrade gracefully —
`repo-status` reports *why* the repository cannot be read — instead of failing
project creation or reads. `GET /projects/:id` and the list endpoint work
normally. The auto-bootstrap hook skips local projects (their state lives in
the folder analysis, not in a `CodeVia/` folder).

To later connect a repository (GitHub or local-git mode), use the existing
project update/repository endpoints — the project then behaves like any
repository-backed project while keeping its `analysis`.

## Conflicts

- Same folder linked again → `409` "This folder is already linked to project …"
- Duplicate slug → `409` "A project with slug … already exists"

## Tests

```bash
npx vitest run src/tests/filesystem-service.test.ts \
  src/tests/project-analyzer.test.ts src/tests/local-project-routes.test.ts
```

covers: path traversal/symlink-escape prevention, sensitive-file blocking,
listing/stat limits, language/framework/package-manager/script detection,
git metadata redaction (canary secrets never appear in the analysis JSON),
project creation without GitHub, conflict handling, unauthorized-path
rejection, auth gating and legacy-project compatibility.
