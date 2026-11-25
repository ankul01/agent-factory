import dotenv from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

async function main() {
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DIRECT_DATABASE_URL or DATABASE_URL is required to run seed.");
  }

  const sql = neon(url);
  const db = drizzle(sql, { schema });

  await db
    .insert(schema.projects)
    .values({
      name: "Task Manager",
      repoOwner: "ankul01",
      repoName: "task-manager",
      defaultBranch: "main",
      plannerWorkflow: "planner.yml",
    })
    .onConflictDoNothing({
      target: [schema.projects.repoOwner, schema.projects.repoName],
    });

  console.log("Seeded default project ankul01/task-manager (if not already present).");
}

main().catch((err: unknown) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
