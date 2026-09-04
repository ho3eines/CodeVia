import { DocumentRepository } from "../db/repository.js";
import { getDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import type { User } from "../domain/entities.js";
import type { GitHubProfile } from "./github-oauth.js";
import { randomUUID } from "node:crypto";

/**
 * Persistent user store. Users are created on first GitHub OAuth login;
 * the very first user becomes `owner`, subsequent users default to
 * `developer` (an owner can change roles later). Existing roles are never
 * overwritten on re-login.
 */
export class UserRepository extends DocumentRepository<User> {
  constructor(db: Db = getDb()) {
    super("user", db);
  }

  findByExternalId(externalId: string): User | undefined {
    return this.findMany({ key: externalId }).map((r) => r.data)[0];
  }

  upsertGitHubUser(profile: GitHubProfile): { user: User; created: boolean } {
    const externalId = `github:${profile.id}`;
    const existing = this.findByExternalId(externalId);
    const now = new Date().toISOString();
    if (existing) {
      const updated: User = {
        ...existing,
        email: profile.email || existing.email,
        name: profile.name || existing.name,
        avatarUrl: profile.avatarUrl ?? existing.avatarUrl,
        updatedAt: now,
      };
      this.upsert(updated, { key: externalId });
      return { user: updated, created: false };
    }
    const isFirstUser = this.count() === 0;
    const user: User = {
      id: randomUUID(),
      externalId,
      email: profile.email,
      name: profile.name,
      role: isFirstUser ? "owner" : "developer",
      avatarUrl: profile.avatarUrl,
      createdAt: now,
      updatedAt: now,
    };
    this.upsert(user, { key: externalId });
    return { user, created: isFirstUser };
  }
}

export function getUserRepo(): UserRepository {
  return new UserRepository();
}
