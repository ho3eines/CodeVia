import { getContainer } from "../app/container.js";
import { logger } from "../logger.js";

/**
 * CLI seed: boots the container, creates a demo project, and runs a QA task so
 * the platform can be explored immediately. Run with `npm run seed`.
 */
async function main() {
  const container = getContainer();
  await container.ensureSeed();

  const existing = container.projectRepo.findMany();
  if (existing.length > 0) {
    logger.info("Database already seeded; skipping demo project.");
    container.db.close();
    return;
  }

  const project = await container.agentManager.createProject({
    name: "Accounting System",
    description: "A .NET + SQL Server accounting system with invoicing and general ledger.",
    configRepo: "acme/accounting",
    branch: "main",
    framework: ".NET",
    database: "SQL Server",
  });
  logger.info(`Seeded demo project ${project.id} (${project.slug})`);

  const task = container.agentManager.createTask({
    projectId: project.id,
    title: "Run QA on the login module",
    description: "Run QA on the authentication module and report test failures.",
    agentType: "qa-test",
  });
  logger.info(`Seeded demo task ${task.id}`);
  await container.agentManager.runTask(task.id);
  logger.info("Seed complete: project, agents, skills, and a completed QA run are ready.");

  container.db.close();
}

main().catch((err) => {
  logger.error("seed failed", { err: String(err) });
  process.exit(1);
});
