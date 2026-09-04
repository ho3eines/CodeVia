import { DocumentRepository } from "../db/repository.js";
import { getDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import type { Skill } from "../domain/entities.js";
import { BUILTIN_SKILLS } from "./catalog.js";
import { randomUUID } from "node:crypto";

export class SkillRepository extends DocumentRepository<Skill> {
  constructor(db: Db = getDb()) {
    super("skill", db);
  }

  create(data: Omit<Skill, "id" | "createdAt" | "updatedAt">): Skill {
    const now = new Date().toISOString();
    const skill: Skill = { ...data, id: randomUUID(), createdAt: now, updatedAt: now };
    this.upsert(skill);
    return skill;
  }

  findBySlug(slug: string): Skill | undefined {
    return this.findMany({ key: slug }).map((r) => r.data)[0];
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
        this.upsert({ ...skill, id: existing.id, createdAt: existing.createdAt }, { key: skill.slug });
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

  /** Human-readable instruction block compiled from skills for agent context. */
  compile(slugs: string[]): string {
    const skills = this.resolveMany(slugs).filter((s) => s.enabled);
    if (skills.length === 0) return "";
    return skills
      .map((s) => `[Skill: ${s.name}]\n${s.instructions}`)
      .join("\n\n");
  }
}

export function getSkillRepo(): SkillRepository {
  return new SkillRepository();
}
