import { neon } from "@neondatabase/serverless";
import { desc, eq, inArray } from "drizzle-orm";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type AppDb = NeonHttpDatabase<typeof schema>;

let cachedDb: AppDb | null = null;

/**
 * Lazily initializes and caches the Neon HTTP Drizzle client so build-time
 * imports do not fail when DATABASE_URL is absent.
 */
export function getDb(): AppDb {
  if (cachedDb) {
    return cachedDb;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL environment variable is not configured.");
  }

  const sql = neon(databaseUrl);
  cachedDb = drizzle(sql, { schema });
  return cachedDb;
}

export async function getRequirementDetail(id: string) {
  const db = getDb();
  const [req] = await db
    .select()
    .from(schema.requirements)
    .where(eq(schema.requirements.id, id))
    .limit(1);

  if (!req) {
    return null;
  }

  const [projectRows, planRows, taskRows, deploymentRows] = await Promise.all([
    db.select().from(schema.projects).where(eq(schema.projects.id, req.projectId)).limit(1),
    db
      .select()
      .from(schema.planRuns)
      .where(eq(schema.planRuns.requirementId, req.id))
      .orderBy(desc(schema.planRuns.version)),
    db
      .select()
      .from(schema.codingTasks)
      .where(eq(schema.codingTasks.requirementId, req.id))
      .orderBy(desc(schema.codingTasks.createdAt)),
    db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.requirementId, req.id))
      .orderBy(desc(schema.deployments.createdAt)),
  ]);

  const taskIds = taskRows.map((t) => t.id);
  const reviewRows =
    taskIds.length > 0
      ? await db
          .select()
          .from(schema.reviewRuns)
          .where(inArray(schema.reviewRuns.codingTaskId, taskIds))
          .orderBy(desc(schema.reviewRuns.createdAt))
      : [];

  return {
    ...req,
    project: projectRows[0] ?? null,
    planRuns: planRows,
    codingTasks: taskRows,
    reviewRuns: reviewRows,
    deployments: deploymentRows,
  };
}

