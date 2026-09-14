import type { Container } from "../app/container.js";
import type { Project } from "../domain/entities.js";
import { assembleRepoBrief, buildRepoBriefDetailed, repoUnreadableNote } from "./context.js";
import { resolveGitHubTokenForProject } from "../github/registry.js";
import type { RepoReadFailure } from "../github/repo-read.js";

/**
 * Repository evidence for the project chat.
 *
 * Clone-first: when the project talks to real GitHub, the platform keeps a
 * local workspace (shallow clone) of the repository and the chat reads the
 * tree/README/manifests from disk — instant, complete and independent of API
 * rate limits. The workspace refreshes in the background; while a first clone
 * is still running (huge repositories) or the clone fails, the evidence falls
 * back to the (single-request trees API) GitHub path.
 *
 * Either way the result is HONEST: when the repository cannot be read the
 * brief carries the exact observed cause and fix instead of being silently
 * empty (an empty brief is what used to make the model invent a "404").
 */

export interface ChatEvidence {
  /** Evidence text for the model prompt ("" only when no repo is configured). */
  brief: string;
  /** Where the evidence came from. */
  source: "workspace" | "github-api" | "none";
  ok: boolean;
  failure?: RepoReadFailure;
}

/** How long a chat message waits for an in-flight workspace refresh. */
const WORKSPACE_WAIT_MS = 3000;

function delay(ms: number): Promise<undefined> {
  return new Promise((r) => setTimeout(() => r(undefined), ms));
}

export async function projectChatEvidence(
  container: Container,
  project: Project,
  requestUserId?: string,
  opts: { workspaceWaitMs?: number } = {},
): Promise<ChatEvidence> {
  const configRepo = (project.configRepo ?? "").trim();
  const [owner, ...rest] = configRepo.split("/");
  const ref = { owner, name: rest.join("/") };
  if (!owner || !ref.name) return { brief: "", source: "none", ok: false };
  const branch = project.branch || "main";

  // 1. Resolve the effective GitHub credential — the same one project actions
  // use. A throwing resolution (e.g. OAuth configured but no stored token)
  // must degrade to an honest note, never a 500 on send.
  let github;
  try {
    github = container.githubForProject(project, requestUserId);
  } catch (err) {
    return {
      brief: repoUnreadableNote({
        repo: configRepo,
        branch,
        failure: "auth",
        detail: err instanceof Error ? err.message : String(err),
      }),
      source: "none",
      ok: false,
      failure: "auth",
    };
  }

  // 2. Clone-first: local workspace for real repositories.
  if (github.kind === "real") {
    try {
      const token = resolveGitHubTokenForProject({ project, kv: container.kv, requestUserId });
      // A fresh clone on disk answers immediately; otherwise start/await a
      // refresh, but never longer than the chat's patience — the first clone
      // of a large repo keeps running in the background and serves the next
      // message.
      let handle = container.workspaces.peek(ref, branch);
      if (!handle) {
        const refresh = container.workspaces.ensure({
          repo: ref,
          branch,
          github,
          token,
        });
        refresh.catch(() => undefined); // failure is handled by the fallback below
        handle = await Promise.race([refresh, delay(opts.workspaceWaitMs ?? WORKSPACE_WAIT_MS)]);
      }
      if (handle) {
        const brief = await assembleRepoBrief({
          paths: handle.listFiles(),
          branch: handle.meta.branch,
          readFile: (p) => handle!.readFile(p),
          note:
            handle.meta.branch !== branch
              ? `Note: branch "${branch}" was not found; the repository's default branch "${handle.meta.branch}" was read instead.`
              : undefined,
        });
        if (brief.trim()) return { brief, source: "workspace", ok: true };
      }
    } catch (err) {
      // Workspace layer is advisory — fall through to the API path.
      void err;
    }
  }

  // 3. API path (also used for mock/demo repositories).
  const detailed = await buildRepoBriefDetailed({ github, project, branch }).catch(
    (err): { brief: string; ok: boolean; failure?: RepoReadFailure } => ({
      brief: repoUnreadableNote({
        repo: configRepo,
        branch,
        failure: "error",
        detail: err instanceof Error ? err.message : String(err),
      }),
      ok: false,
      failure: "error",
    }),
  );
  return {
    brief: detailed.brief,
    source: detailed.brief ? "github-api" : "none",
    ok: detailed.ok,
    failure: detailed.failure,
  };
}
