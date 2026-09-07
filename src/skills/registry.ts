import { DocumentRepository } from "../db/repository.js";
import { getDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import type { Skill } from "../domain/entities.js";
import { BUILTIN_SKILLS } from "./catalog.js";
import { randomUUID } from "node:crypto";
import type { Project } from "../domain/entities.js";
import { availableSkills, compileAssignedSkills, resolveSkillDependencies, selectTaskSkills, type SkillAgent, type SkillTask } from "./assignment.js";

export class SkillRepository extends DocumentRepository<Skill> {
  constructor(db: Db = getDb()) {
    super("skill", db);
  }

  create(data: Omit<Skill, "id" | "createdAt" | "updatedAt">): Skill {
    if (this.findBySlug(data.slug, data.projectId)) throw Object.assign(new Error(`Skill slug ${data.slug} already exists`), { statusCode: 409 });
    const now = new Date().toISOString();
    const skill: Skill = { ...data, id: randomUUID(), createdAt: now, updatedAt: now };
    this.upsert(skill, { key: skill.slug, projectId: skill.projectId });
    return skill;
  }

  /** Marketplace templates and each project's definitions have separate namespaces. */
  globalCatalog(): Skill[] { return this.findMany().map((r) => r.data).filter((s) => !s.projectId); }
  byProject(projectId: string): Skill[] { return this.findMany({ projectId }).map((r) => r.data); }
  findBySlug(slug: string, projectId?: string): Skill | undefined {
    return (projectId ? this.byProject(projectId) : this.globalCatalog()).find((s) => s.slug === slug);
  }

  /** Seed built-in skills exactly once (idempotent by slug). */
  seedBuiltIns(): number {
    let seeded = 0;
    for (const skill of BUILTIN_SKILLS) {
      const existing = this.findBySlug(skill.slug);
      if (!existing) {
        this.upsert(skill, { key: skill.slug });
        seeded++;
      } else if (existing.builtIn && existing.version !== skill.version) {
        // Refresh built-in skill content while preserving id + creation date.
        this.upsert({ ...skill, id: existing.id, enabled: existing.enabled, createdAt: existing.createdAt }, { key: skill.slug });
      }
    }
    return seeded;
  }
}

export class SkillRegistry {
  constructor(private repo: SkillRepository) {}

  resolve(slug: string): Skill | undefined {
    return this.repo.findBySlug(slug);
  }

  resolveMany(slugs: string[]): Skill[] {
    return slugs.map((s) => this.resolve(s)).filter((s): s is Skill => !!s);
  }

  catalog(project?: Project): Skill[] {
    return project?.repositoryState ? this.repo.byProject(project.id) : this.repo.globalCatalog();
  }

  availableFor(project: Project, agent: SkillAgent): Skill[] {
    return availableSkills(this.catalog(project), project, agent);
  }

  forTask(project: Project, agent: SkillAgent, task?: SkillTask) {
    return selectTaskSkills(this.catalog(project), project, agent, task);
  }

  /** Human-readable instructions including transitive prerequisites. */
  compile(slugs: string[]): string {
    const catalog = this.catalog();
    const enabled = slugs.filter((slug) => catalog.some((s) => s.slug === slug && s.enabled));
    return compileAssignedSkills(resolveSkillDependencies(catalog, enabled).map((s) => ({
      slug: s.slug, name: s.name, version: s.version, instructions: s.instructions, guidance: "", source: "agent",
    })));
  }

}

export function getSkillRepo(): SkillRepository {
  return new SkillRepository();
}
