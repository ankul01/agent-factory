import { asc, desc, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { DashboardClient } from "@/components/DashboardClient";
import type { ProjectOption } from "@/components/NewRequirementModal";
import type { RequirementListItem } from "@/components/RequirementsTable";
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

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await requireAdminSession();
  if (!session) {
    redirect("/login");
  }

  const db = getDb();
  let projectRows = await db.select().from(projects).orderBy(asc(projects.id));
  if (projectRows.length === 0) {
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
    projectRows = await db.select().from(projects).orderBy(asc(projects.id));
  }

  const reqRows = await db
    .select()
    .from(requirements)
    .orderBy(desc(requirements.createdAt))
    .limit(50);

  const reqIds = reqRows.map((r) => r.id);
  const [planRows, taskRows, deploymentRows] =
    reqIds.length > 0
      ? await Promise.all([
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
        ])
      : [[], [], []];

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

  const initialProjects: ProjectOption[] = projectRows.map((p) => ({
    id: p.id,
    name: p.name,
    repoOwner: p.repoOwner,
    repoName: p.repoName,
  }));

  const initialRequirements: RequirementListItem[] = reqRows.map((req) => {
    const proj = projectMap.get(req.projectId) ?? null;
    const plan = latestPlanMap.get(req.id) ?? null;
    const tasks = tasksByReq.get(req.id) ?? [];
    const primaryTask = tasks[0];
    const review = primaryTask ? latestReviewByTask.get(primaryTask.id) ?? null : null;
    const deploy = latestDeployMap.get(req.id) ?? null;

    return {
      id: req.id,
      projectId: req.projectId,
      title: req.title,
      slug: req.slug,
      status: req.status,
      failureReason: req.failureReason,
      createdAt: req.createdAt.toISOString(),
      project: proj
        ? {
            id: proj.id,
            name: proj.name,
            repoOwner: proj.repoOwner,
            repoName: proj.repoName,
          }
        : null,
      latestPlanRun: plan
        ? {
            id: plan.id,
            status: plan.status,
            prNumber: plan.prNumber,
            prUrl: plan.prUrl,
            ghRunUrl: plan.ghRunUrl,
            openQuestionsCount: plan.openQuestionsCount,
            modelUsed: plan.modelUsed,
          }
        : null,
      codingTasks: tasks.map((t) => ({
        id: t.id,
        status: t.status,
        cursorTrackingUrl: t.cursorTrackingUrl,
        prNumber: t.prNumber,
        prUrl: t.prUrl,
      })),
      latestReviewRun: review
        ? {
            id: review.id,
            testStatus: review.testStatus,
            verdict: review.verdict,
            p0Count: review.p0Count,
            p1Count: review.p1Count,
            commentUrl: review.commentUrl,
          }
        : null,
      latestDeployment: deploy
        ? {
            id: deploy.id,
            releaseTag: deploy.releaseTag,
            releaseUrl: deploy.releaseUrl,
            commitSha: deploy.commitSha,
            deployProvider: deploy.deployProvider,
            deployEnvironment: deploy.deployEnvironment,
            stagingUrl: deploy.stagingUrl,
            deployStatus: deploy.deployStatus,
            smokeTestStatus: deploy.smokeTestStatus,
            smokeTestLatencyMs: deploy.smokeTestLatencyMs,
            deployRunUrl: deploy.deployRunUrl ?? deploy.ghRunUrl,
          }
        : null,
    };
  });

  return (
    <DashboardClient
      initialProjects={initialProjects}
      initialRequirements={initialRequirements}
    />
  );
}
