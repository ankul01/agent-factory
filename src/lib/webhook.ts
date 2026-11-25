import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db";
import {
  codingTasks,
  deployments,
  planRuns,
  projects,
  requirements,
  reviewRuns,
  type CodingTaskRow,
  type PlanRunRow,
  type RequirementRow,
} from "@/db/schema";
import { computeHmacSha256Hex, safeEqual } from "./crypto";
import {
  extractCursorTrackingUrl,
  isRequirementStatus,
  matchFeatureBranch,
  matchPlanBranch,
  matchPlanReferenceInBody,
  nextRequirementStatus,
  parseReviewComment,
  type RequirementStatus,
} from "./status";

/**
 * Verifies GitHub's X-Hub-Signature-256 header in constant time.
 */
export function verifyGitHubWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (!secret || secret.trim() === "" || !signatureHeader) {
    return false;
  }

  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const providedHex = signatureHeader.slice("sha256=".length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(providedHex)) {
    return false;
  }

  const expectedHex = computeHmacSha256Hex(rawBody, secret);
  return safeEqual(providedHex, expectedHex);
}

const repoSchema = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
});

export const pullRequestWebhookSchema = z.object({
  action: z.string(),
  repository: repoSchema,
  pull_request: z.object({
    number: z.number().int(),
    html_url: z.string(),
    body: z.string().nullable().optional(),
    state: z.string(),
    merged: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    merge_commit_sha: z.string().nullable().optional(),
    head: z.object({
      ref: z.string(),
      sha: z.string(),
    }),
  }),
});

export const workflowRunWebhookSchema = z.object({
  action: z.string(),
  repository: repoSchema,
  workflow_run: z.object({
    id: z.union([z.number(), z.string()]),
    name: z.string().nullable().optional(),
    path: z.string().optional(),
    status: z.string().nullable().optional(),
    conclusion: z.string().nullable().optional(),
    html_url: z.string(),
    head_branch: z.string().nullable().optional(),
    head_sha: z.string(),
    pull_requests: z.array(z.object({ number: z.number().int() })).optional(),
  }),
});

export const issueCommentWebhookSchema = z.object({
  action: z.string(),
  repository: repoSchema,
  issue: z.object({
    number: z.number().int(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    id: z.union([z.number(), z.string()]),
    body: z.string(),
    html_url: z.string(),
  }),
});

export const releaseWebhookSchema = z.object({
  action: z.string(),
  repository: repoSchema,
  release: z.object({
    tag_name: z.string(),
    html_url: z.string(),
    target_commitish: z.string(),
    published_at: z.string().nullable().optional(),
  }),
});

async function findProject(db: AppDb, owner: string, repo: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.repoOwner, owner), eq(projects.repoName, repo)))
    .limit(1);
  return project ?? null;
}

async function getProjectRequirements(db: AppDb, projectId: number): Promise<RequirementRow[]> {
  return db
    .select()
    .from(requirements)
    .where(eq(requirements.projectId, projectId))
    .orderBy(desc(requirements.createdAt));
}

async function getLatestPlanRun(db: AppDb, requirementId: string): Promise<PlanRunRow | null> {
  const [plan] = await db
    .select()
    .from(planRuns)
    .where(eq(planRuns.requirementId, requirementId))
    .orderBy(desc(planRuns.version))
    .limit(1);
  return plan ?? null;
}

async function getPrimaryCodingTask(
  db: AppDb,
  requirementId: string,
): Promise<CodingTaskRow | null> {
  const [task] = await db
    .select()
    .from(codingTasks)
    .where(eq(codingTasks.requirementId, requirementId))
    .orderBy(desc(codingTasks.createdAt))
    .limit(1);
  return task ?? null;
}

async function updateRequirementStatus(
  db: AppDb,
  req: RequirementRow,
  candidate: RequirementStatus,
  failureReason?: string | null,
) {
  const current: RequirementStatus = isRequirementStatus(req.status) ? req.status : "RECEIVED";
  const nextStatus = nextRequirementStatus(current, candidate);
  await db
    .update(requirements)
    .set({
      status: nextStatus,
      ...(failureReason !== undefined ? { failureReason } : {}),
      updatedAt: new Date(),
    })
    .where(eq(requirements.id, req.id));
}

export async function handlePullRequestWebhook(db: AppDb, payload: unknown): Promise<string> {
  const parsed = pullRequestWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    return "ignored: invalid pull_request payload";
  }

  const { action, repository, pull_request: pr } = parsed.data;
  if (!["opened", "reopened", "synchronize", "closed"].includes(action)) {
    return `ignored: pull_request action ${action}`;
  }

  const project = await findProject(db, repository.owner.login, repository.name);
  if (!project) {
    return "ignored: unknown repository";
  }

  const reqs = await getProjectRequirements(db, project.id);
  const headRef = pr.head.ref;
  const isMerged = Boolean(pr.merged || pr.merged_at);

  // 1. Plan PR match
  if (headRef.startsWith("plan/")) {
    for (const req of reqs) {
      const matched = matchPlanBranch(headRef, req.slug);
      if (!matched.matched) continue;

      const latestPlan = await getLatestPlanRun(db, req.id);
      const version = latestPlan?.version ?? 1;
      const planId = matched.planId ?? latestPlan?.planId ?? null;
      const planPath = planId ? `docs/plans/${planId}.md` : latestPlan?.planPath ?? null;

      const [upsertedPlan] = await db
        .insert(planRuns)
        .values({
          requirementId: req.id,
          version,
          planId,
          planPath,
          branchName: headRef,
          prNumber: pr.number,
          prUrl: pr.html_url,
          mergeCommitSha: isMerged ? pr.merge_commit_sha ?? null : null,
          status: isMerged ? "APPROVED" : pr.state === "open" ? "PR_OPEN" : "FAILED",
          failureReason: !isMerged && action === "closed" ? "Plan PR closed without merging" : null,
        })
        .onConflictDoUpdate({
          target: [planRuns.requirementId, planRuns.version],
          set: {
            planId,
            planPath,
            branchName: headRef,
            prNumber: pr.number,
            prUrl: pr.html_url,
            ...(isMerged && pr.merge_commit_sha ? { mergeCommitSha: pr.merge_commit_sha } : {}),
            status: isMerged ? "APPROVED" : pr.state === "open" ? "PR_OPEN" : "FAILED",
            failureReason:
              !isMerged && action === "closed" ? "Plan PR closed without merging" : null,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (isMerged) {
        await db
          .insert(codingTasks)
          .values({
            requirementId: req.id,
            planRunId: upsertedPlan.id,
            featureSlug: req.slug,
            status: "QUEUED",
          })
          .onConflictDoNothing({
            target: [codingTasks.requirementId, codingTasks.featureSlug],
          });

        await updateRequirementStatus(db, req, "PLAN_APPROVED", null);
      } else if (pr.state === "open") {
        await updateRequirementStatus(db, req, "AWAITING_PLAN_APPROVAL", null);
      } else if (action === "closed") {
        await updateRequirementStatus(db, req, "FAILED", "Plan PR closed without merging");
      }

      return `processed plan PR #${pr.number} for ${req.slug}`;
    }
    return `ignored: no matching requirement for plan PR ${headRef}`;
  }

  // 2. Coding PR match (branch or PR body reference)
  for (const req of reqs) {
    const latestPlan = await getLatestPlanRun(db, req.id);
    const branchMatched = matchFeatureBranch(headRef, req.slug, latestPlan?.planId);
    const bodyMatched = matchPlanReferenceInBody(pr.body, req.slug, latestPlan?.planId);

    if (!branchMatched && !bodyMatched) continue;

    await db
      .insert(codingTasks)
      .values({
        requirementId: req.id,
        planRunId: latestPlan?.id ?? null,
        featureSlug: req.slug,
        branchName: headRef,
        prNumber: pr.number,
        prUrl: pr.html_url,
        mergeCommitSha: isMerged ? pr.merge_commit_sha ?? null : null,
        status: isMerged ? "MERGED" : pr.state === "open" ? "PR_OPEN" : "FAILED",
        failureReason: !isMerged && action === "closed" ? "Code PR closed without merging" : null,
      })
      .onConflictDoUpdate({
        target: [codingTasks.requirementId, codingTasks.featureSlug],
        set: {
          branchName: headRef,
          prNumber: pr.number,
          prUrl: pr.html_url,
          ...(isMerged && pr.merge_commit_sha ? { mergeCommitSha: pr.merge_commit_sha } : {}),
          status: isMerged ? "MERGED" : pr.state === "open" ? "PR_OPEN" : "FAILED",
          failureReason:
            !isMerged && action === "closed" ? "Code PR closed without merging" : null,
          updatedAt: new Date(),
        },
      });

    if (isMerged) {
      await updateRequirementStatus(db, req, "DEPLOYING", null);
    } else if (pr.state === "open") {
      await updateRequirementStatus(db, req, "IN_REVIEW", null);
    } else if (action === "closed") {
      await updateRequirementStatus(db, req, "FAILED", "Code PR closed without merging");
    }

    return `processed coding PR #${pr.number} for ${req.slug}`;
  }

  return `ignored: no matching requirement for PR #${pr.number}`;
}

export async function handleWorkflowRunWebhook(db: AppDb, payload: unknown): Promise<string> {
  const parsed = workflowRunWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    return "ignored: invalid workflow_run payload";
  }

  const { action, repository, workflow_run: run } = parsed.data;
  if (!["requested", "in_progress", "completed"].includes(action)) {
    return `ignored: workflow_run action ${action}`;
  }

  const project = await findProject(db, repository.owner.login, repository.name);
  if (!project) {
    return "ignored: unknown repository";
  }

  const ghRunId = String(run.id);
  const conclusion = run.conclusion ?? null;
  const isFailure =
    action === "completed" &&
    conclusion !== null &&
    ["failure", "timed_out", "cancelled", "startup_failure"].includes(conclusion);
  const workflowPath = (run.path ?? run.name ?? "").toLowerCase();
  const failureMsg = isFailure ? `Workflow ${run.name ?? ghRunId} ${conclusion}` : null;

  // Tier 1: Direct ghRunId match across plan_runs
  const [directPlan] = await db
    .select()
    .from(planRuns)
    .where(eq(planRuns.ghRunId, ghRunId))
    .limit(1);

  if (directPlan) {
    const [req] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.id, directPlan.requirementId))
      .limit(1);

    if (isFailure && req) {
      await db
        .update(planRuns)
        .set({ status: "FAILED", failureReason: failureMsg, updatedAt: new Date() })
        .where(eq(planRuns.id, directPlan.id));
      await updateRequirementStatus(db, req, "FAILED", failureMsg);
      return `marked plan_run ${ghRunId} FAILED`;
    }

    if (action === "in_progress") {
      await db
        .update(planRuns)
        .set({ status: "RUNNING", ghRunUrl: run.html_url, updatedAt: new Date() })
        .where(eq(planRuns.id, directPlan.id));
    }
    return `updated plan_run ${ghRunId}`;
  }

  const reqs = await getProjectRequirements(db, project.id);
  const prNumbers = new Set((run.pull_requests ?? []).map((p) => p.number));

  // Tier 2 & 3: Branch, PR number, or mergeCommitSha correlation
  for (const req of reqs) {
    const latestPlan = await getLatestPlanRun(db, req.id);
    const primaryTask = await getPrimaryCodingTask(db, req.id);

    const isPlanBranch = matchPlanBranch(run.head_branch, req.slug).matched;
    const isPlanPr = latestPlan?.prNumber ? prNumbers.has(latestPlan.prNumber) : false;

    if (isPlanBranch || isPlanPr) {
      if (isFailure && latestPlan) {
        await db
          .update(planRuns)
          .set({
            ghRunId,
            ghRunUrl: run.html_url,
            status: "FAILED",
            failureReason: failureMsg,
            updatedAt: new Date(),
          })
          .where(eq(planRuns.id, latestPlan.id));
        await updateRequirementStatus(db, req, "FAILED", failureMsg);
        return `marked plan_run FAILED via branch/PR for ${req.slug}`;
      }
      continue;
    }

    // trigger-coder.yml correlation via mergeCommitSha on plan_runs
    if (
      latestPlan?.mergeCommitSha &&
      latestPlan.mergeCommitSha === run.head_sha &&
      workflowPath.includes("coder")
    ) {
      await db
        .insert(codingTasks)
        .values({
          requirementId: req.id,
          planRunId: latestPlan.id,
          featureSlug: req.slug,
          ghRunId,
          ghRunUrl: run.html_url,
          status: isFailure ? "FAILED" : "RUNNING",
          failureReason: failureMsg,
        })
        .onConflictDoUpdate({
          target: [codingTasks.requirementId, codingTasks.featureSlug],
          set: {
            ghRunId,
            ghRunUrl: run.html_url,
            status: isFailure ? "FAILED" : "RUNNING",
            failureReason: failureMsg,
            updatedAt: new Date(),
          },
        });

      await updateRequirementStatus(
        db,
        req,
        isFailure ? "FAILED" : "CODING",
        isFailure ? failureMsg : undefined,
      );
      return `correlated trigger-coder run ${ghRunId} for ${req.slug}`;
    }

    // pr-review.yml correlation via feature branch or PR number
    const isFeatureBranch = matchFeatureBranch(run.head_branch, req.slug, latestPlan?.planId);
    const isCodingPr = primaryTask?.prNumber ? prNumbers.has(primaryTask.prNumber) : false;

    if ((isFeatureBranch || isCodingPr) && primaryTask) {
      if (workflowPath.includes("review")) {
        const testStatus =
          action === "completed" ? (conclusion === "success" ? "PASSED" : "FAILED") : "PENDING";
        await db
          .insert(reviewRuns)
          .values({
            codingTaskId: primaryTask.id,
            ghRunId,
            ghRunUrl: run.html_url,
            testStatus,
          })
          .onConflictDoUpdate({
            target: [reviewRuns.codingTaskId, reviewRuns.ghRunId],
            set: {
              ghRunUrl: run.html_url,
              testStatus,
              updatedAt: new Date(),
            },
          });

        if (isFailure) {
          await updateRequirementStatus(db, req, "FAILED", failureMsg);
        } else {
          await updateRequirementStatus(db, req, "IN_REVIEW");
        }
        return `correlated pr-review run ${ghRunId} for ${req.slug}`;
      }
    }

    // deploy.yml correlation via codingTasks.mergeCommitSha
    if (
      primaryTask?.mergeCommitSha &&
      primaryTask.mergeCommitSha === run.head_sha &&
      workflowPath.includes("deploy")
    ) {
      const smokeTestStatus =
        action === "completed" ? (conclusion === "success" ? "PASSED" : "FAILED") : "PENDING";
      await db
        .insert(deployments)
        .values({
          requirementId: req.id,
          codingTaskId: primaryTask.id,
          commitSha: run.head_sha,
          ghRunId,
          ghRunUrl: run.html_url,
          smokeTestStatus,
          deployedAt: smokeTestStatus === "PASSED" ? new Date() : null,
        })
        .onConflictDoUpdate({
          target: [deployments.requirementId, deployments.ghRunId],
          set: {
            ghRunUrl: run.html_url,
            smokeTestStatus,
            ...(smokeTestStatus === "PASSED" ? { deployedAt: new Date() } : {}),
          },
        });

      if (isFailure) {
        await updateRequirementStatus(db, req, "FAILED", failureMsg);
      } else if (smokeTestStatus === "PASSED") {
        await updateRequirementStatus(db, req, "DEPLOYED", null);
      } else {
        await updateRequirementStatus(db, req, "DEPLOYING");
      }
      return `correlated deploy run ${ghRunId} for ${req.slug}`;
    }
  }

  return `ignored: uncorrelated workflow_run ${ghRunId}`;
}

export async function handleIssueCommentWebhook(db: AppDb, payload: unknown): Promise<string> {
  const parsed = issueCommentWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    return "ignored: invalid issue_comment payload";
  }

  const { action, repository, issue, comment } = parsed.data;
  if (!issue.pull_request || !["created", "edited"].includes(action)) {
    return "ignored: non-PR or irrelevant comment action";
  }

  const project = await findProject(db, repository.owner.login, repository.name);
  if (!project) {
    return "ignored: unknown repository";
  }

  const prNumber = issue.number;

  // Check if comment is on a coding PR (AI Review comment)
  const [task] = await db
    .select()
    .from(codingTasks)
    .where(eq(codingTasks.prNumber, prNumber))
    .orderBy(desc(codingTasks.createdAt))
    .limit(1);

  if (task) {
    const parsedReview = parseReviewComment(comment.body);
    if (parsedReview.isReviewComment) {
      await db
        .insert(reviewRuns)
        .values({
          codingTaskId: task.id,
          ghRunId: `pr-comment-${comment.id}`,
          verdict: parsedReview.verdict,
          p0Count: parsedReview.p0Count,
          p1Count: parsedReview.p1Count,
          commentUrl: comment.html_url,
          modelUsed: parsedReview.modelUsed,
        })
        .onConflictDoUpdate({
          target: [reviewRuns.codingTaskId, reviewRuns.ghRunId],
          set: {
            verdict: parsedReview.verdict,
            p0Count: parsedReview.p0Count,
            p1Count: parsedReview.p1Count,
            commentUrl: comment.html_url,
            modelUsed: parsedReview.modelUsed,
            updatedAt: new Date(),
          },
        });
      return `recorded AI review comment on PR #${prNumber}`;
    }
  }

  // Check if comment is on a plan PR (Cursor tracking URL)
  const [plan] = await db
    .select()
    .from(planRuns)
    .where(eq(planRuns.prNumber, prNumber))
    .orderBy(desc(planRuns.version))
    .limit(1);

  if (plan) {
    const cursor = extractCursorTrackingUrl(comment.body);
    if (cursor.cursorTrackingUrl) {
      const [req] = await db
        .select()
        .from(requirements)
        .where(eq(requirements.id, plan.requirementId))
        .limit(1);

      if (req) {
        await db
          .insert(codingTasks)
          .values({
            requirementId: req.id,
            planRunId: plan.id,
            featureSlug: req.slug,
            cursorTrackingUrl: cursor.cursorTrackingUrl,
            cursorAgentId: cursor.cursorAgentId,
            status: "RUNNING",
          })
          .onConflictDoUpdate({
            target: [codingTasks.requirementId, codingTasks.featureSlug],
            set: {
              cursorTrackingUrl: cursor.cursorTrackingUrl,
              cursorAgentId: cursor.cursorAgentId,
              status: "RUNNING",
              updatedAt: new Date(),
            },
          });

        await updateRequirementStatus(db, req, "CODING");
        return `recorded Cursor tracking URL on plan PR #${prNumber}`;
      }
    }
  }

  return `ignored: comment on PR #${prNumber} did not match review or cursor markers`;
}

export async function handleReleaseWebhook(db: AppDb, payload: unknown): Promise<string> {
  const parsed = releaseWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    return "ignored: invalid release payload";
  }

  const { action, repository, release } = parsed.data;
  if (!["published", "created", "released"].includes(action)) {
    return `ignored: release action ${action}`;
  }

  const project = await findProject(db, repository.owner.login, repository.name);
  if (!project) {
    return "ignored: unknown repository";
  }

  const reqs = await getProjectRequirements(db, project.id);
  let targetReq: RequirementRow | null = null;
  let targetTask: CodingTaskRow | null = null;

  for (const req of reqs) {
    const task = await getPrimaryCodingTask(db, req.id);
    if (task?.mergeCommitSha && task.mergeCommitSha === release.target_commitish) {
      targetReq = req;
      targetTask = task;
      break;
    }
  }

  if (!targetReq) {
    targetReq = reqs.find((r) => r.status === "DEPLOYING") ?? null;
    if (targetReq) {
      targetTask = await getPrimaryCodingTask(db, targetReq.id);
    }
  }

  if (!targetReq) {
    return `ignored: no matching requirement for release ${release.tag_name}`;
  }

  await db
    .insert(deployments)
    .values({
      requirementId: targetReq.id,
      codingTaskId: targetTask?.id ?? null,
      releaseTag: release.tag_name,
      releaseUrl: release.html_url,
      commitSha: release.target_commitish,
      ghRunId: `release-${release.tag_name}`,
      smokeTestStatus: "PASSED",
      deployedAt: release.published_at ? new Date(release.published_at) : new Date(),
    })
    .onConflictDoUpdate({
      target: [deployments.requirementId, deployments.ghRunId],
      set: {
        releaseTag: release.tag_name,
        releaseUrl: release.html_url,
        commitSha: release.target_commitish,
        smokeTestStatus: "PASSED",
        deployedAt: release.published_at ? new Date(release.published_at) : new Date(),
      },
    });

  await updateRequirementStatus(db, targetReq, "DEPLOYED", null);
  return `recorded release ${release.tag_name} for ${targetReq.slug}`;
}
