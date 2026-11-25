import { asc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { requireAdminSession } from "@/lib/auth";

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  repoOwner: z.string().trim().min(1).max(100),
  repoName: z.string().trim().min(1).max(100),
  defaultBranch: z.string().trim().min(1).max(100).optional(),
  plannerWorkflow: z.string().trim().min(1).max(120).optional(),
});

export async function GET() {
  const session = await requireAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  let rows = await db.select().from(projects).orderBy(asc(projects.id));

  if (rows.length === 0) {
    await db
      .insert(projects)
      .values({
        name: "Task Manager",
        repoOwner: "ankul01",
        repoName: "task-manager",
        defaultBranch: "main",
        plannerWorkflow: "planner.yml",
      })
      .onConflictDoNothing({
        target: [projects.repoOwner, projects.repoName],
      });
    rows = await db.select().from(projects).orderBy(asc(projects.id));
  }

  return NextResponse.json({ projects: rows });
}

export async function POST(request: Request) {
  const session = await requireAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid project payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = getDb();
  const [created] = await db
    .insert(projects)
    .values({
      name: parsed.data.name,
      repoOwner: parsed.data.repoOwner,
      repoName: parsed.data.repoName,
      defaultBranch: parsed.data.defaultBranch ?? "main",
      plannerWorkflow: parsed.data.plannerWorkflow ?? "planner.yml",
    })
    .onConflictDoNothing({
      target: [projects.repoOwner, projects.repoName],
    })
    .returning();

  if (!created) {
    return NextResponse.json(
      { error: "Project repository already exists" },
      { status: 409 },
    );
  }

  return NextResponse.json({ project: created }, { status: 201 });
}
