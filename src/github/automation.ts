import type { AgentType, Project } from "../domain/entities.js";
import type { ProjectRepository } from "../domain/repos.js";
import type { AgentRepository } from "../agents/agent-repo.js";
import type { AgentManager } from "../agents/manager.js";
import type { JobQueue } from "../db/queue.js";
import type { KvStore } from "../db/kv.js";
import type { AuditRepository } from "../observability/repos.js";
import { eventBus, type DomainEvent, type DomainEventName } from "../events/bus.js";
import { hydrateProject } from "../domain/project-options.js";
import { logger } from "../logger.js";

/**
 * GitHub Event Automation.
 *
 *   push                 → QA Agent            (regression on the new commits)
 *   pull_request opened  → Code Reviewer Agent
 *   pull_request sync    → QA Agent
 *   issues opened        → Research Agent      (triage / diagnosis)
 *   release published    → Release Agent
 *   workflow_run failed  → Debugging Agent
 *
 * The webhook route validates the signature and publishes a domain event; this
 * module maps the event to every project that links the repository and enqueues
 * a task for the responsible agent. Delivery ids are remembered so a redelivered
 * webhook never fans out twice.
 */
export interface GithubAutomationDeps {
  projectRepo: ProjectRepository;
  agentRepo: AgentRepository;
  agentManager: AgentManager;
  queue: JobQueue;
  kv: KvStore;
  auditRepo: AuditRepository;
}

export interface AutomationRule {
  event: DomainEventName;
  /** GitHub `action` field to match (undefined = any). */
  actions?: string[];
  agentType: AgentType;
  title: (ctx: EventContext) => string;
  /** Extra guard, e.g. only failed workflow runs. */
  when?: (ctx: EventContext) => boolean;
}

export interface EventContext {
  event: string;
  action?: string;
  repo?: string;
  branch?: string;
  body: Record<string, unknown>;
}

export const DEFAULT_RULES: AutomationRule[] = [
  {
    event: "github.push",
    agentType: "qa-test",
    title: (c) => `QA: verify push to ${c.branch ?? c.repo ?? "repository"}`,
  },
  {
    event: "github.pull_request",
    actions: ["opened", "reopened", "ready_for_review"],
    agentType: "code-reviewer",
    title: (c) => `Review PR #${num(c.body)}: ${prTitle(c.body)}`,
  },
  {
    event: "github.pull_request",
    actions: ["synchronize"],
    agentType: "qa-test",
    title: (c) => `QA: re-test PR #${num(c.body)} after update`,
  },
  {
    event: "github.issue",
    actions: ["opened", "reopened"],
    agentType: "research",
    title: (c) => `Triage issue #${num(c.body)}: ${issueTitle(c.body)}`,
  },
  {
    event: "github.release",
    actions: ["published", "created"],
    agentType: "release",
    title: (c) => `Release ${tag(c.body)}: prepare notes & post-release checks`,
  },
  {
    event: "github.workflow_completed",
    agentType: "debugging",
    when: (c) => /fail|cancel|timed_out/i.test(String((c.body.workflow_run as { conclusion?: string } | undefined)?.conclusion ?? "")),
    title: (c) => `Diagnose failed CI run: ${String((c.body.workflow_run as { name?: string } | undefined)?.name ?? "workflow")}`,
  },
];

const SEEN_KEY = "github.automation.seenDeliveries";
const SEEN_LIMIT = 500;

/** The event bus is process-global; only one automation may be live at a time. */
let active: GithubAutomation | undefined;

export class GithubAutomation {
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: GithubAutomationDeps, private readonly rules: AutomationRule[] = DEFAULT_RULES) {}

  /** Subscribe to the event bus. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.unsubscribe.length > 0) return;
    if (active && active !== this) active.stop();
    active = this;
    const names = [...new Set(this.rules.map((r) => r.event))];
    for (const name of names) {
      this.unsubscribe.push(eventBus.on(name, async (e) => { await this.handle(e); }));
    }
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    if (active === this) active = undefined;
  }

  /** Process one domain event. Returns the tasks that were created (for tests/diagnostics). */
  async handle(e: DomainEvent): Promise<Array<{ projectId: string; taskId: string; agentType: AgentType }>> {
    const payload = e.payload as { event?: string; body?: Record<string, unknown>; deliveryId?: string };
    const body = payload.body ?? {};
    const deliveryId = payload.deliveryId;
    if (deliveryId && this.alreadySeen(deliveryId)) {
      logger.info("github automation: duplicate delivery ignored", { deliveryId });
      return [];
    }
    const ctx: EventContext = {
      event: payload.event ?? e.name,
      action: typeof body.action === "string" ? body.action : undefined,
      repo: (body.repository as { full_name?: string } | undefined)?.full_name?.toLowerCase(),
      branch: branchOf(body),
      body,
    };
    const matching = this.rules.filter(
      (r) => r.event === e.name && (!r.actions || (ctx.action !== undefined && r.actions.includes(ctx.action))) && (!r.when || r.when(ctx)),
    );
    if (matching.length === 0) return [];

    const projects = this.projectsFor(ctx.repo);
    const created: Array<{ projectId: string; taskId: string; agentType: AgentType }> = [];
    for (const project of projects) {
      for (const rule of matching) {
        // Skip automations the project has no agent for (e.g. a docs-only project without a release agent).
        const agent = this.deps.agentRepo.byType(project.id, rule.agentType);
        if (!agent || !agent.enabled) continue;
        const task = this.deps.agentManager.createTask({
          projectId: project.id,
          title: rule.title(ctx),
          description: describe(ctx),
          agentType: rule.agentType,
          input: { source: "github", event: ctx.event, action: ctx.action, repo: ctx.repo, branch: ctx.branch, deliveryId },
        });
        this.deps.queue.enqueue("agent.run", { taskId: task.id }, { correlationId: task.correlationId });
        this.deps.auditRepo.record({
          action: "github.event.routed",
          projectId: project.id,
          agentId: agent.id,
          result: "success",
          source: "github",
          correlationId: e.correlationId,
          metadata: { event: ctx.event, action: ctx.action, repo: ctx.repo, taskId: task.id, agentType: rule.agentType, deliveryId },
        });
        created.push({ projectId: project.id, taskId: task.id, agentType: rule.agentType });
      }
    }
    if (deliveryId) this.remember(deliveryId);
    if (created.length > 0) logger.info("github automation routed event", { event: ctx.event, action: ctx.action, repo: ctx.repo, tasks: created.length });
    return created;
  }

  /** Every active project that links `repo` (config repo or any linked repository). */
  private projectsFor(repo: string | undefined): Project[] {
    if (!repo) return [];
    return this.deps.projectRepo
      .findMany()
      .map((r) => hydrateProject(r.data))
      .filter((p) => p.active)
      .filter((p) => p.configRepo.toLowerCase() === repo || p.repositories.some((l) => l.repo.toLowerCase() === repo));
  }

  private alreadySeen(id: string): boolean {
    return (this.deps.kv.get<string[]>(SEEN_KEY) ?? []).includes(id);
  }

  private remember(id: string): void {
    const seen = this.deps.kv.get<string[]>(SEEN_KEY) ?? [];
    seen.push(id);
    this.deps.kv.set(SEEN_KEY, seen.slice(-SEEN_LIMIT));
  }
}

function num(body: Record<string, unknown>): string {
  const pr = body.pull_request as { number?: number } | undefined;
  const issue = body.issue as { number?: number } | undefined;
  return String(pr?.number ?? issue?.number ?? body.number ?? "?");
}
function prTitle(body: Record<string, unknown>): string {
  return String((body.pull_request as { title?: string } | undefined)?.title ?? "").slice(0, 80);
}
function issueTitle(body: Record<string, unknown>): string {
  return String((body.issue as { title?: string } | undefined)?.title ?? "").slice(0, 80);
}
function tag(body: Record<string, unknown>): string {
  return String((body.release as { tag_name?: string } | undefined)?.tag_name ?? "");
}
function branchOf(body: Record<string, unknown>): string | undefined {
  const ref = typeof body.ref === "string" ? body.ref : undefined;
  if (ref) return ref.replace(/^refs\/heads\//, "");
  const pr = body.pull_request as { head?: { ref?: string } } | undefined;
  return pr?.head?.ref;
}
function describe(c: EventContext): string {
  const parts = [`GitHub ${c.event}${c.action ? ` (${c.action})` : ""} on ${c.repo ?? "repository"}`];
  if (c.branch) parts.push(`branch: ${c.branch}`);
  const commits = c.body.commits as Array<{ message?: string; id?: string }> | undefined;
  if (Array.isArray(commits) && commits.length) {
    parts.push("commits:\n" + commits.slice(0, 10).map((k) => `- ${(k.id ?? "").slice(0, 7)} ${(k.message ?? "").split("\n")[0]}`).join("\n"));
  }
  const pr = c.body.pull_request as { title?: string; body?: string; html_url?: string } | undefined;
  if (pr) parts.push(`PR: ${pr.title ?? ""}\n${pr.html_url ?? ""}\n${(pr.body ?? "").slice(0, 1000)}`);
  const issue = c.body.issue as { title?: string; body?: string; html_url?: string } | undefined;
  if (issue) parts.push(`Issue: ${issue.title ?? ""}\n${issue.html_url ?? ""}\n${(issue.body ?? "").slice(0, 1000)}`);
  return parts.join("\n\n");
}
