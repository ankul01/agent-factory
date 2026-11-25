import { and, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  codingTasks,
  deployments,
  planRuns,
  projects,
  requirements,
  reviewRuns,
  type CodingTaskRow,
  type DeploymentRow,
  type PlanRunRow,
  type ProjectRow,
  type ReviewRunRow,
} from "@/db/schema";
import { requireAdminSession } from "@/lib/auth";
import { dispatchPlannerWorkflow } from "@/lib/github";
import { SLUG_REGEX } from "@/lib/status";

const createRequirementSchema = z.object({
  projectId: z.number().int().positive(),
  title: z.string().trim().min(1).max(160),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(40, "Slug must be 40 characters or fewer")
    .regex(SLUG_REGEX, "Slug must be lowercase kebab-case (a-z, 0-9, -)"),
  promptText: z.string().trim().min(1).max(20000),
  model: z.string().trim().max(100).optional(),
});

export async function GET(request: Request) {
  const session = await requireAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const projectIdParam = url.searchParams.get("projectId");
  const limitParam = url.searchParams.get("limit");

  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 100)
    : 50;

  const db = getDb();
  const parsedProjectId = projectIdParam ? Number.parseInt(projectIdParam, 10) : null;

  const reqRows =
    parsedProjectId && Number.isFinite(parsedProjectId)
      ? await db
          .select()
          .from(requirements)
          .where(eq(requirements.projectId, parsedProjectId))
          .orderBy(desc(requirements.createdAt))
          .limit(limit)
      : await db
          .select()
          .from(requirements)
          .orderBy(desc(requirements.createdAt))
          .limit(limit);

  if (reqRows.length === 0) {
    return NextResponse.json({ requirements: [] });
  }

  const reqIds = reqRows.map((r) => r.id);
  const projectIds = Array.from(new Set(reqRows.map((r) => r.projectId)));

  const [projectRows, planRows, taskRows, deploymentRows] = await Promise.all([
    db.select().from(projects).where(inArray(projects.id, projectIds)),
    db
      .select()
      .from(planRuns)
      .where(inArray(planRuns.requirementId, reqIds))
      .orderBy(desc(planRuns.version)),
    db
      .select()
      .from(codingTasks)
      .where(inArray(codingTasks.requirementId, reqIds))
      .orderBy(desc(codingTasks.createdAt)),
    db
      .select()
      .from(deployments)
      .where(inArray(deployments.requirementId, reqIds))
      .orderBy(desc(deployments.createdAt)),
  ]);

  const taskIds = taskRows.map((t) => t.id);
  const reviewRows =
    taskIds.length > 0
      ? await db
          .select()
          .from(reviewRuns)
          .where(inArray(reviewRuns.codingTaskId, taskIds))
          .orderBy(desc(reviewRuns.createdAt))
      : [];

  const projectMap = new Map<number, ProjectRow>(projectRows.map((p) => [p.id, p]));
  const latestPlanMap = new Map<string, PlanRunRow>();
  for (const plan of planRows) {
    if (!latestPlanMap.has(plan.requirementId)) {
      latestPlanMap.set(plan.requirementId, plan);
    }
  }

  const tasksByReq = new Map<string, CodingTaskRow[]>();
  for (const task of taskRows) {
    const arr = tasksByReq.get(task.requirementId) ?? [];
    arr.push(task);
    tasksByReq.set(task.requirementId, arr);
  }

  const latestReviewByTask = new Map<string, ReviewRunRow>();
  for (const review of reviewRows) {
    if (!latestReviewByTask.has(review.codingTaskId)) {
      latestReviewByTask.set(review.codingTaskId, review);
    }
  }

  const latestDeployMap = new Map<string, DeploymentRow>();
  for (const dep of deploymentRows) {
    if (!latestDeployMap.has(dep.requirementId)) {
      latestDeployMap.set(dep.requirementId, dep);
    }
  }

  const enriched = reqRows.map((req) => {
    const reqTasks = tasksByReq.get(req.id) ?? [];
    const primaryTask = reqTasks[0];
    return {
      ...req,
      project: projectMap.get(req.projectId) ?? null,
      latestPlanRun: latestPlanMap.get(req.id) ?? null,
      codingTasks: reqTasks,
      latestReviewRun: primaryTask ? latestReviewByTask.get(primaryTask.id) ?? null : null,
      latestDeployment: latestDeployMap.get(req.id) ?? null,
    };
  });

  return NextResponse.json({ requirements: enriched });
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

  const parsed = createRequirementSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { projectId, title, slug, promptText, model } = parsed.data;
  const db = getDb();

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const [existing] = await db
    .select({ id: requirements.id })
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), eq(requirements.slug, slug)))
    .limit(1);

  if (existing) {
    return NextResponse.json(
      { error: `A requirement with slug "${slug}" already exists in this project.` },
      { status: 409 },
    );
  }

  const [createdReq] = await db
    .insert(requirements)
    .values({
      projectId,
      title,
      slug,
      promptText,
      status: "PLANNING",
    })
    .returning();

  const [createdPlan] = await db
    .insert(planRuns)
    .values({
      requirementId: createdReq.id,
      version: 1,
      status: "QUEUED",
      modelUsed: model && model.trim() !== "" ? model.trim() : null,
    })
    .returning();

  try {
    const dispatchResult = await dispatchPlannerWorkflow({
      owner: project.repoOwner,
      repo: project.repoName,
      workflowFile: project.plannerWorkflow,
      ref: project.defaultBranch,
      requirement: promptText,
      slug,
      model,
    });

    const [updatedPlan] = await db
      .update(planRuns)
      .set({
        ghRunId: dispatchResult.ghRunId,
        ghRunUrl: dispatchResult.ghRunUrl,
        status: "RUNNING",
        updatedAt: new Date(),
      })
      .where(eq(planRuns.id, createdPlan.id))
      .returning();

    return NextResponse.json(
      {
        requirement: {
          ...createdReq,
          project,
          latestPlanRun: updatedPlan,
          codingTasks: [],
          latestReviewRun: null,
          latestDeployment: null,
        },
      },
      { status: 201 },
    );
  } catch (err: unknown) {
    const failureReason =
      err instanceof Error ? err.message : "Failed to dispatch planner workflow";

    await db
      .update(planRuns)
      .set({
        status: "FAILED",
        failureReason,
        updatedAt: new Date(),
      })
      .where(eq(planRuns.id, createdPlan.id));

    await db
      .update(requirements)
      .set({
        status: "FAILED",
        failureReason,
        updatedAt: new Date(),
      })
      .where(eq(requirements.id, createdReq.id));

    return NextResponse.json(
      {
        error: "Failed to dispatch GitHub Actions planner workflow",
        failureReason,
        requirementId: createdReq.id,
      },
      { status: 502 },
    );
  }
}
