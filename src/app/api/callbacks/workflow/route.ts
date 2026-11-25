import { and, desc, eq } from "drizzle-orm";
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
} from "@/db/schema";
import { safeEqual } from "@/lib/crypto";
import {
  isRequirementStatus,
  nextRequirementStatus,
  type RequirementStatus,
} from "@/lib/status";

const callbackSchema = z.object({
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  slug: z.string().min(1),
  requirementId: z.string().uuid().optional(),
  stage: z.enum(["plan", "coding", "review", "deploy"]),
  status: z.string().min(1),
  ghRunId: z.string().optional(),
  ghRunUrl: z.string().optional(),
  planPath: z.string().optional(),
  branchName: z.string().optional(),
  prNumber: z.number().int().optional(),
  prUrl: z.string().optional(),
  mergeCommitSha: z.string().optional(),
  openQuestionsCount: z.number().int().min(0).optional(),
  modelUsed: z.string().optional(),
  cursorAgentId: z.string().optional(),
  cursorRunId: z.string().optional(),
  cursorTrackingUrl: z.string().optional(),
  testStatus: z.enum(["PENDING", "PASSED", "FAILED"]).optional(),
  verdict: z.enum(["PENDING", "APPROVED", "CHANGES_REQUESTED"]).optional(),
  p0Count: z.number().int().min(0).optional(),
  p1Count: z.number().int().min(0).optional(),
  commentUrl: z.string().optional(),
  releaseTag: z.string().optional(),
  releaseUrl: z.string().optional(),
  commitSha: z.string().optional(),
  smokeTestStatus: z.enum(["PENDING", "PASSED", "FAILED"]).optional(),
  failureReason: z.string().optional(),
});

export async function POST(request: Request) {
  const expectedSecret = process.env.ORCHESTRATOR_CALLBACK_SECRET;
  if (!expectedSecret || expectedSecret.trim() === "") {
    return NextResponse.json(
      { error: "ORCHESTRATOR_CALLBACK_SECRET is not configured" },
      { status: 500 },
    );
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (!safeEqual(token, expectedSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = callbackSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const db = getDb();

  let req = null;
  if (data.requirementId) {
    const [byId] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.id, data.requirementId))
      .limit(1);
    req = byId ?? null;
  } else {
    const [project] = await db
      .select()
      .from(projects)
      .where(
        and(eq(projects.repoOwner, data.repoOwner), eq(projects.repoName, data.repoName)),
      )
      .limit(1);
    if (project) {
      const [bySlug] = await db
        .select()
        .from(requirements)
        .where(and(eq(requirements.projectId, project.id), eq(requirements.slug, data.slug)))
        .orderBy(desc(requirements.createdAt))
        .limit(1);
      req = bySlug ?? null;
    }
  }

  if (!req) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }

  const currentReqStatus: RequirementStatus = isRequirementStatus(req.status)
    ? req.status
    : "RECEIVED";
  let candidateStatus: RequirementStatus = currentReqStatus;
  let failureReason: string | null | undefined = undefined;

  if (data.stage === "plan") {
    await db
      .insert(planRuns)
      .values({
        requirementId: req.id,
        version: 1,
        planPath: data.planPath ?? null,
        branchName: data.branchName ?? null,
        ghRunId: data.ghRunId ?? null,
        ghRunUrl: data.ghRunUrl ?? null,
        prNumber: data.prNumber ?? null,
        prUrl: data.prUrl ?? null,
        mergeCommitSha: data.mergeCommitSha ?? null,
        openQuestionsCount: data.openQuestionsCount ?? 0,
        modelUsed: data.modelUsed ?? null,
        status: data.status,
        failureReason: data.failureReason ?? null,
      })
      .onConflictDoUpdate({
        target: [planRuns.requirementId, planRuns.version],
        set: {
          ...(data.planPath !== undefined ? { planPath: data.planPath } : {}),
          ...(data.branchName !== undefined ? { branchName: data.branchName } : {}),
          ...(data.ghRunId !== undefined ? { ghRunId: data.ghRunId } : {}),
          ...(data.ghRunUrl !== undefined ? { ghRunUrl: data.ghRunUrl } : {}),
          ...(data.prNumber !== undefined ? { prNumber: data.prNumber } : {}),
          ...(data.prUrl !== undefined ? { prUrl: data.prUrl } : {}),
          ...(data.mergeCommitSha !== undefined ? { mergeCommitSha: data.mergeCommitSha } : {}),
          ...(data.openQuestionsCount !== undefined
            ? { openQuestionsCount: data.openQuestionsCount }
            : {}),
          ...(data.modelUsed !== undefined ? { modelUsed: data.modelUsed } : {}),
          status: data.status,
          ...(data.failureReason !== undefined ? { failureReason: data.failureReason } : {}),
          updatedAt: new Date(),
        },
      });

    if (data.status === "FAILED") {
      candidateStatus = "FAILED";
      failureReason = data.failureReason ?? "Planning failed";
    } else if (data.status === "APPROVED") {
      candidateStatus = "PLAN_APPROVED";
    } else if (data.status === "PR_OPEN") {
      candidateStatus = "AWAITING_PLAN_APPROVAL";
    } else {
      candidateStatus = "PLANNING";
    }
  } else if (data.stage === "coding") {
    await db
      .insert(codingTasks)
      .values({
        requirementId: req.id,
        featureSlug: data.slug,
        branchName: data.branchName ?? null,
        ghRunId: data.ghRunId ?? null,
        ghRunUrl: data.ghRunUrl ?? null,
        cursorAgentId: data.cursorAgentId ?? null,
        cursorRunId: data.cursorRunId ?? null,
        cursorTrackingUrl: data.cursorTrackingUrl ?? null,
        prNumber: data.prNumber ?? null,
        prUrl: data.prUrl ?? null,
        mergeCommitSha: data.mergeCommitSha ?? null,
        status: data.status,
        failureReason: data.failureReason ?? null,
      })
      .onConflictDoUpdate({
        target: [codingTasks.requirementId, codingTasks.featureSlug],
        set: {
          ...(data.branchName !== undefined ? { branchName: data.branchName } : {}),
          ...(data.ghRunId !== undefined ? { ghRunId: data.ghRunId } : {}),
          ...(data.ghRunUrl !== undefined ? { ghRunUrl: data.ghRunUrl } : {}),
          ...(data.cursorAgentId !== undefined ? { cursorAgentId: data.cursorAgentId } : {}),
          ...(data.cursorRunId !== undefined ? { cursorRunId: data.cursorRunId } : {}),
          ...(data.cursorTrackingUrl !== undefined
            ? { cursorTrackingUrl: data.cursorTrackingUrl }
            : {}),
          ...(data.prNumber !== undefined ? { prNumber: data.prNumber } : {}),
          ...(data.prUrl !== undefined ? { prUrl: data.prUrl } : {}),
          ...(data.mergeCommitSha !== undefined ? { mergeCommitSha: data.mergeCommitSha } : {}),
          status: data.status,
          ...(data.failureReason !== undefined ? { failureReason: data.failureReason } : {}),
          updatedAt: new Date(),
        },
      });

    if (data.status === "FAILED") {
      candidateStatus = "FAILED";
      failureReason = data.failureReason ?? "Coding task failed";
    } else if (data.status === "MERGED") {
      candidateStatus = "DEPLOYING";
    } else if (data.status === "PR_OPEN") {
      candidateStatus = "IN_REVIEW";
    } else {
      candidateStatus = "CODING";
    }
  } else if (data.stage === "review") {
    const [task] = await db
      .insert(codingTasks)
      .values({
        requirementId: req.id,
        featureSlug: data.slug,
        status: "PR_OPEN",
      })
      .onConflictDoUpdate({
        target: [codingTasks.requirementId, codingTasks.featureSlug],
        set: { updatedAt: new Date() },
      })
      .returning();

    const ghRunId = data.ghRunId ?? `callback-review-${Date.now()}`;
    await db
      .insert(reviewRuns)
      .values({
        codingTaskId: task.id,
        ghRunId,
        ghRunUrl: data.ghRunUrl ?? null,
        testStatus: data.testStatus ?? "PENDING",
        verdict: data.verdict ?? "PENDING",
        p0Count: data.p0Count ?? 0,
        p1Count: data.p1Count ?? 0,
        commentUrl: data.commentUrl ?? null,
        modelUsed: data.modelUsed ?? null,
      })
      .onConflictDoUpdate({
        target: [reviewRuns.codingTaskId, reviewRuns.ghRunId],
        set: {
          ...(data.ghRunUrl !== undefined ? { ghRunUrl: data.ghRunUrl } : {}),
          ...(data.testStatus !== undefined ? { testStatus: data.testStatus } : {}),
          ...(data.verdict !== undefined ? { verdict: data.verdict } : {}),
          ...(data.p0Count !== undefined ? { p0Count: data.p0Count } : {}),
          ...(data.p1Count !== undefined ? { p1Count: data.p1Count } : {}),
          ...(data.commentUrl !== undefined ? { commentUrl: data.commentUrl } : {}),
          ...(data.modelUsed !== undefined ? { modelUsed: data.modelUsed } : {}),
          updatedAt: new Date(),
        },
      });

    if (data.status === "FAILED" || data.testStatus === "FAILED") {
      candidateStatus = "FAILED";
      failureReason = data.failureReason ?? "PR review tests failed";
    } else {
      candidateStatus = "IN_REVIEW";
    }
  } else if (data.stage === "deploy") {
    const ghRunId = data.ghRunId ?? (data.releaseTag ? `release-${data.releaseTag}` : `callback-deploy-${Date.now()}`);
    await db
      .insert(deployments)
      .values({
        requirementId: req.id,
        releaseTag: data.releaseTag ?? null,
        releaseUrl: data.releaseUrl ?? null,
        commitSha: data.commitSha ?? null,
        ghRunId,
        ghRunUrl: data.ghRunUrl ?? null,
        smokeTestStatus: data.smokeTestStatus ?? "PENDING",
        deployedAt: data.smokeTestStatus === "PASSED" ? new Date() : null,
      })
      .onConflictDoUpdate({
        target: [deployments.requirementId, deployments.ghRunId],
        set: {
          ...(data.releaseTag !== undefined ? { releaseTag: data.releaseTag } : {}),
          ...(data.releaseUrl !== undefined ? { releaseUrl: data.releaseUrl } : {}),
          ...(data.commitSha !== undefined ? { commitSha: data.commitSha } : {}),
          ...(data.ghRunUrl !== undefined ? { ghRunUrl: data.ghRunUrl } : {}),
          ...(data.smokeTestStatus !== undefined
            ? { smokeTestStatus: data.smokeTestStatus }
            : {}),
          ...(data.smokeTestStatus === "PASSED" ? { deployedAt: new Date() } : {}),
        },
      });

    if (data.status === "FAILED" || data.smokeTestStatus === "FAILED") {
      candidateStatus = "FAILED";
      failureReason = data.failureReason ?? "Deployment smoke test failed";
    } else if (data.smokeTestStatus === "PASSED" || data.status === "DEPLOYED") {
      candidateStatus = "DEPLOYED";
      failureReason = null;
    } else {
      candidateStatus = "DEPLOYING";
    }
  }

  const nextStatus = nextRequirementStatus(currentReqStatus, candidateStatus);
  await db
    .update(requirements)
    .set({
      status: nextStatus,
      ...(failureReason !== undefined ? { failureReason } : {}),
      updatedAt: new Date(),
    })
    .where(eq(requirements.id, req.id));

  return NextResponse.json({ ok: true, requirementId: req.id, status: nextStatus });
}
