import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Container } from "../app/container.js";
import { MockGitHubService } from "../github/mock-service.js";
import { getEnvFresh } from "../config/env.js";
import { STATE_COMMIT_SKIP_CI_MARKER, withStateCommitCiMarker } from "../github/project-state.js";
import type { Project } from "../domain/entities.js";
import { freshDb } from "./test-helpers.js";

/* ------------------------------------------------------------------ *
 * State commits must not start a project's CI.
 *
 * CodeVia saves every project update (task/run status, memory, agents,
 * conversations…) as a commit that only touches `CodeVia/**`. Before this
 * rule, a red project gate produced one failing run — and one "all jobs
 * have failed" mail — per state save, and the run was pure noise: the
 * commit changed no code. GitHub skips push/pull_request runs whose head
 * commit message carries a skip marker (`[skip ci]`), so state commits
 * carry one and real code commits stay unmarked.
 * ------------------------------------------------------------------ */

let fx: ReturnType<typeof freshDb>;
let c: Container;
let gh: MockGitHubService;

const ref = (p: Project) => {
  const [owner, name] = p.configRepo.split("/");
  return { owner, name };
};
const messages = async (p: Project) => (await gh.listCommits(ref(p))).map((commit) => commit.message);

beforeEach(async () => {
  fx = freshDb();
  c = new Container();
  await c.ensureSeed();
  gh = c.github as MockGitHubService;
});

afterEach(() => {
  vi.unstubAllEnvs();
  getEnvFresh();
  c.githubAutomation.stop();
  fx.cleanup();
});

describe("state commits carry the CI-skip marker", () => {
  it("marks a state message once and never rewrites a marked one", () => {
    expect(withStateCommitCiMarker("[CodeVia] save conversation", true)).toBe(
      `[CodeVia] save conversation ${STATE_COMMIT_SKIP_CI_MARKER}`,
    );
    const marked = `[CodeVia] save conversation ${STATE_COMMIT_SKIP_CI_MARKER}`;
    expect(withStateCommitCiMarker(marked, true)).toBe(marked);
    expect(withStateCommitCiMarker("[CodeVia] ci skip via another marker [no ci]", true)).toBe(
      "[CodeVia] ci skip via another marker [no ci]",
    );
    expect(withStateCommitCiMarker("[CodeVia] save conversation", false)).toBe("[CodeVia] save conversation");
  });

  it("writes every CodeVia state commit with the marker while leaving Agent.md unmarked", async () => {
    const p = await c.agentManager.createProject({
      name: "Marker",
      description: "State commits should not run CI",
      configRepo: "acme/marker",
      capabilities: { languages: ["typescript"] },
    });
    await c.agentManager.saveProject({ ...p, description: "edited from the UI" });

    const all = await messages(p);
    const state = all.filter((m) => m.startsWith("[CodeVia] "));
    expect(state.length).toBeGreaterThan(0);
    for (const message of state) expect(message.endsWith(STATE_COMMIT_SKIP_CI_MARKER)).toBe(true);
    // A generated brief is repository content, not state: it keeps running CI.
    const agentMd = all.filter((m) => m.startsWith("docs: ensure Agent.md"));
    for (const message of agentMd) expect(message.includes(STATE_COMMIT_SKIP_CI_MARKER)).toBe(false);
  });

  it("honors STATE_COMMIT_SKIP_CI=false so operators can run CI on state commits", async () => {
    vi.stubEnv("STATE_COMMIT_SKIP_CI", "false");
    getEnvFresh();
    const p = await c.agentManager.createProject({
      name: "No marker",
      description: "Opt-out keeps legacy behavior",
      configRepo: "acme/no-marker",
      capabilities: { languages: ["typescript"] },
    });
    const state = (await messages(p)).filter((m) => m.startsWith("[CodeVia] "));
    expect(state.length).toBeGreaterThan(0);
    for (const message of state) expect(message.includes(STATE_COMMIT_SKIP_CI_MARKER)).toBe(false);
  });
});
