import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DocumentRepository } from "../db/repository.js";
import { freshDb } from "./test-helpers.js";

interface Doc { id: string; name: string; value: number }

describe("DocumentRepository", () => {
  let fx: ReturnType<typeof freshDb>;
  let repo: DocumentRepository<Doc>;
  beforeEach(() => {
    fx = freshDb();
    repo = new DocumentRepository<Doc>("doc");
  });
  afterEach(() => fx.cleanup());

  it("inserts and reads back a document", () => {
    const rec = repo.insert({ id: "d1", name: "alpha", value: 1 });
    expect(repo.findById("d1")?.data.name).toBe("alpha");
    expect(rec.createdAt).toBeTruthy();
  });

  it("upsert preserves createdAt and updates content", async () => {
    const first = repo.upsert({ id: "d1", name: "alpha", value: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const second = repo.upsert({ id: "d1", name: "beta", value: 2 });
    expect(second.createdAt).toBe(first.createdAt);
    expect(repo.findById("d1")?.data.name).toBe("beta");
  });

  it("filters by project and key", () => {
    repo.upsert({ id: "d1", name: "a", value: 1 }, { projectId: "p1", key: "k1" });
    repo.upsert({ id: "d2", name: "b", value: 2 }, { projectId: "p2", key: "k2" });
    expect(repo.findMany({ projectId: "p1" }).length).toBe(1);
    expect(repo.findMany({ key: "k2" })[0].data.name).toBe("b");
  });

  it("deletes by id", () => {
    repo.upsert({ id: "d1", name: "a", value: 1 });
    repo.deleteById("d1");
    expect(repo.findById("d1")).toBeUndefined();
  });
});
