import { promises as fsp } from "node:fs";
import * as path from "node:path";

export interface GitFolderFacts {
  branch?: string;
  remote?: string;
  lastCommit?: string;
}

function safeBranchName(value: string): boolean {
  if (
    !value ||
    value.length > 250 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
  )
    return false;
  return (
    !value
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.startsWith(".") || part.endsWith(".")) &&
    !/[\s~^:?*[\\\x00-\x20\x7f]/.test(value)
  );
}

async function readGitFile(gitRoot: string, parts: string[]): Promise<string | undefined> {
  let current = gitRoot;
  try {
    const rootEntry = await fsp.lstat(gitRoot);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return undefined;
    const rootReal = await fsp.realpath(gitRoot);
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const st = await fsp.lstat(current);
      if (st.isSymbolicLink()) return undefined;
      if (i < parts.length - 1 && !st.isDirectory()) return undefined;
      if (i === parts.length - 1 && !st.isFile()) return undefined;
    }
    if ((await fsp.realpath(gitRoot)) !== rootReal) return undefined;
    const fileReal = await fsp.realpath(current);
    const rel = path.relative(rootReal, fileReal);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
    return await fsp.readFile(current, "utf8");
  } catch {
    return undefined;
  }
}

function redactGitUrl(url: string): string {
  return url
    .replace(/^(https?:\/\/)[^/@:]+(?::[^/@]*)?@/i, "$1")
    .replace(/^(ssh:\/\/)[^/@:]+(?::[^/@]*)?@/i, "$1")
    .replace(/([?&](?:access_token|token|password|auth)=)[^&\s]+/gi, "$1***");
}

/** Read only regular, non-symlink .git metadata files; never follow .git or child symlinks. */
export async function readGitFolderFacts(root: string): Promise<GitFolderFacts | undefined> {
  const gitDir = path.join(root, ".git");
  try {
    const st = await fsp.lstat(gitDir);
    // Worktree `.git` files and symlinked git directories are intentionally not followed.
    if (!st.isDirectory() || st.isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  const out: GitFolderFacts = {};
  const head = (await readGitFile(gitDir, ["HEAD"]))?.trim();
  const branchMatch = head?.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (branchMatch && safeBranchName(branchMatch[1])) out.branch = branchMatch[1];
  else if (head && /^[0-9a-f]{7,64}$/i.test(head)) out.branch = head.slice(0, 12);

  const config = await readGitFile(gitDir, ["config"]);
  if (config) {
    const remoteMatch =
      config.match(/\[remote\s+"origin"\][^[]*?url\s*=\s*(\S+)/s) ??
      config.match(/\[remote\s+"[^"]+"\][^[]*?url\s*=\s*(\S+)/s);
    if (remoteMatch) out.remote = redactGitUrl(remoteMatch[1]);
  }

  let sha: string | undefined;
  if (out.branch) {
    const branchParts = out.branch.split("/");
    const ref = await readGitFile(gitDir, ["refs", "heads", ...branchParts]);
    if (ref && /^[0-9a-f]{40,64}$/i.test(ref.trim())) sha = ref.trim();
    if (!sha) {
      const packed = await readGitFile(gitDir, ["packed-refs"]);
      const escaped = out.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = packed?.match(new RegExp(`^([0-9a-f]{40,64}) refs/heads/${escaped}$`, "m"));
      sha = match?.[1];
    }
  }
  const log = await readGitFile(gitDir, ["logs", "HEAD"]);
  let subject: string | undefined;
  if (log) {
    const lines = log.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = lines[i].match(/\tcommit[^:]*:\s*(.+)$/);
      if (match) {
        subject = match[1].trim();
        break;
      }
    }
  }
  if (sha || subject) out.lastCommit = [sha?.slice(0, 7), subject].filter(Boolean).join(" ") || undefined;
  return out;
}
