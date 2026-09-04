import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, setDbForTest } from "../db/client.js";

/** Creates a fresh temp DB and wires it as the container's runtime store. */
export function freshDb(): { db: Db; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "codevia-test-"));
  const path = join(dir, "test.db");
  const db = new Db(path);
  setDbForTest(db);
  return {
    db,
    path,
    cleanup: () => {
      try {
        db.close();
      } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
