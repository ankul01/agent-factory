import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, getRequirementDetail } from "@/db";
import {
  codingTasks,
  deployments,
  planRuns,
  projects,
  requirements,
  reviewRuns,
} from "@/db/schema";
import { requireAdminSession } from "@/lib/auth";
import {
  listIssueComments,
  listRecentPullRequests,
  listReleases,
  listWorkflowRuns,
  searchPullRequestsBySlug,
  type GitHubPullRequest,
} from "@/lib/github";
import {
  extractCursorTrackingUrl,
  isRequirementStatus,
  matchFeatureBranch,
  matchPlanBranch,
  matchPlanReferenceInBody,
  nextRequirementStatus,
  parseReviewComment,
  type RequirementStatus,
} from "@/lib/status";

const uuidSchema = z.string().uuid();

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await requireAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid requirement ID" }, { status: 400 });
  }

  const db = getDb();
  const [req] = await db
    .select()
    .from(requirements)
    .where(eq(requirements.id, id))
    .limit(1);

  if (!req) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, req.projectId))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const owner = project.repoOwner;
  const repo = project.repoName;
  let currentStatus: RequirementStatus = isRequirementStatus(req.status)
    ? req.status
    : "RECEIVED";
  let failureReason: string | null = req.failureReason;

  const advance = (candidate: RequirementStatus, reason?: string | null) => {
    currentStatus = nextRequirementStatus(currentStatus, candidate);
    if (reason !== undefined) {
      failureReason = reason;
    }
  };

  // Fetch PRs (search + recent fallback), workflow runs, and releases in parallel
  const [searchedPrs, recentPrs, workflowRuns, releases] = await Promise.all([
    searchPullRequestsBySlug(owner, repo, req.slug).catch(() => []),
    listRecentPullRequests(owner, repo, 20).catch(() => []),
    listWorkflowRuns(owner, repo, 30).catch(() => []),
    listReleases(owner, repo, 15).catch(() => []),
  ]);

  const prMap = new Map<number, GitHubPullRequest>();
  for (const pr of [...searchedPrs, ...recentPrs]) {
    prMap.set(pr.number, pr);
  }
  const candidatePrs = Array.from(prMap.values());

  const detailBefore = await getRequirementDetail(req.id);
  let latestPlan = detailBefore?.planRuns[0] ?? null;
  let primaryTask = detailBefore?.codingTasks[0] ?? null;

  // 1. Reconcile Plan PR
  for (const pr of candidatePrs) {
    const planMatch = matchPlanBranch(pr.head.ref, req.slug);
    if (!planMatch.matched) continue;

    const isMerged = Boolean(pr.merged_at);
    const version = latestPlan?.version ?? 1;
    const planId = planMatch.planId ?? latestPlan?.planId ?? null;
    const planPath = planId ? `docs/plans/${planId}.md` : latestPlan?.planPath ?? null;

    const [upsertedPlan] = await db
      .insert(planRuns)
      .values({
        requirementId: req.id,
        version,
        planId,
        planPath,
        branchName: pr.head.ref,
        prNumber: pr.number,
        prUrl: pr.html_url,
        mergeCommitSha: isMerged ? pr.merge_commit_sha ?? null : null,
        status: isMerged ? "APPROVED" : pr.state === "open" ? "PR_OPEN" : "FAILED",
        failureReason: !isMerged && pr.state === "closed" ? "Plan PR closed without merging" : null,
      })
      .onConflictDoUpdate({
        target: [planRuns.requirementId, planRuns.version],
        set: {
          planId,
          planPath,
          branchName: pr.head.ref,
          prNumber: pr.number,
          prUrl: pr.html_url,
          ...(isMerged && pr.merge_commit_sha ? { mergeCommitSha: pr.merge_commit_sha } : {}),
          status: isMerged ? "APPROVED" : pr.state === "open" ? "PR_OPEN" : "FAILED",
          failureReason:
            !isMerged && pr.state === "closed" ? "Plan PR closed without merging" : null,
          updatedAt: new Date(),
        },
      })
      .returning();

    latestPlan = upsertedPlan;

    if (isMerged) {
      const [upsertedTask] = await db
        .insert(codingTasks)
        .values({
          requirementId: req.id,
          planRunId: upsertedPlan.id,
          featureSlug: req.slug,
          status: "QUEUED",
        })
        .onConflictDoUpdate({
          target: [codingTasks.requirementId, codingTasks.featureSlug],
          set: {
            planRunId: upsertedPlan.id,
            updatedAt: new Date(),
          },
        })
        .returning();
      primaryTask = upsertedTask;
      advance("PLAN_APPROVED", null);
    } else if (pr.state === "open") {
      advance("AWAITING_PLAN_APPROVAL", null);
    } else {
      advance("FAILED", "Plan PR closed without merging");
    }

    // Inspect Plan PR comments for Cursor tracking URL
    const planComments = await listIssueComments(owner, repo, pr.number).catch(() => []);
    for (const comment of planComments) {
      const cursor = extractCursorTrackingUrl(comment.body);
      if (cursor.cursorTrackingUrl) {
        const [updatedTask] = await db
          .insert(codingTasks)
          .values({
            requirementId: req.id,
            planRunId: upsertedPlan.id,
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
              status: primaryTask?.status === "MERGED" || primaryTask?.status === "PR_OPEN" ? primaryTask.status : "RUNNING",
              updatedAt: new Date(),
            },
          })
          .returning();
        primaryTask = updatedTask;
        advance("CODING");
      }
    }
    break;
  }

  // 2. Reconcile Coding PR
  for (const pr of candidatePrs) {
    if (pr.head.ref.startsWith("plan/")) continue;
    const branchMatched = matchFeatureBranch(pr.head.ref, req.slug, latestPlan?.planId);
    const bodyMatched = matchPlanReferenceInBody(pr.body, req.slug, latestPlan?.planId);
    if (!branchMatched && !bodyMatched) continue;

    const isMerged = Boolean(pr.merged_at);
    const [upsertedTask] = await db
      .insert(codingTasks)
      .values({
        requirementId: req.id,
        planRunId: latestPlan?.id ?? null,
        featureSlug: req.slug,
        branchName: pr.head.ref,
        prNumber: pr.number,
        prUrl: pr.html_url,
        mergeCommitSha: isMerged ? pr.merge_commit_sha ?? null : null,
        status: isMerged ? "MERGED" : pr.state === "open" ? "PR_OPEN" : "FAILED",
        failureReason: !isMerged && pr.state === "closed" ? "Code PR closed without merging" : null,
      })
      .onConflictDoUpdate({
        target: [codingTasks.requirementId, codingTasks.featureSlug],
        set: {
          branchName: pr.head.ref,
          prNumber: pr.number,
          prUrl: pr.html_url,
          ...(isMerged && pr.merge_commit_sha ? { mergeCommitSha: pr.merge_commit_sha } : {}),
          status: isMerged ? "MERGED" : pr.state === "open" ? "PR_OPEN" : "FAILED",
          failureReason:
            !isMerged && pr.state === "closed" ? "Code PR closed without merging" : null,
          updatedAt: new Date(),
        },
      })
      .returning();

    primaryTask = upsertedTask;

    if (isMerged) {
      advance("DEPLOYING", null);
    } else if (pr.state === "open") {
      advance("IN_REVIEW", null);
    } else {
      advance("FAILED", "Code PR closed without merging");
    }

    // Inspect Code PR comments for AI review verdict
    const codeComments = await listIssueComments(owner, repo, pr.number).catch(() => []);
    for (const comment of codeComments) {
      const parsedReview = parseReviewComment(comment.body);
      if (!parsedReview.isReviewComment) continue;

      await db
        .insert(reviewRuns)
        .values({
          codingTaskId: upsertedTask.id,
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
    }
    break;
  }

  // 3. Reconcile Workflow Runs (planner, trigger-coder, pr-review, deploy)
  for (const run of workflowRuns) {
    const ghRunId = String(run.id);
    const conclusion = run.conclusion ?? null;
    const isFailure =
      run.status === "completed" &&
      conclusion !== null &&
      ["failure", "timed_out", "cancelled", "startup_failure"].includes(conclusion);
    const workflowPath = (run.path ?? run.name ?? "").toLowerCase();
    const failureMsg = isFailure ? `Workflow ${run.name ?? ghRunId} ${conclusion}` : null;

    if (latestPlan?.ghRunId === ghRunId || matchPlanBranch(run.head_branch, req.slug).matched) {
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
        advance("FAILED", failureMsg);
      }
      continue;
    }

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
            ...(isFailure
              ? { status: "FAILED", failureReason: failureMsg }
              : primaryTask?.status === "QUEUED"
                ? { status: "RUNNING" }
                : {}),
            updatedAt: new Date(),
          },
        });
      advance(isFailure ? "FAILED" : "CODING", isFailure ? failureMsg : undefined);
      continue;
    }

    const prNumbers = new Set((run.pull_requests ?? []).map((p) => p.number));
    if (
      primaryTask &&
      (matchFeatureBranch(run.head_branch, req.slug, latestPlan?.planId) ||
        (primaryTask.prNumber !== null && prNumbers.has(primaryTask.prNumber))) &&
      workflowPath.includes("review")
    ) {
      const testStatus =
        run.status === "completed" ? (conclusion === "success" ? "PASSED" : "FAILED") : "PENDING";
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
        advance("FAILED", failureMsg);
      } else {
        advance("IN_REVIEW");
      }
      continue;
    }

    if (
      primaryTask?.mergeCommitSha &&
      primaryTask.mergeCommitSha === run.head_sha &&
      workflowPath.includes("deploy")
    ) {
      const smokeTestStatus =
        run.status === "completed" ? (conclusion === "success" ? "PASSED" : "FAILED") : "PENDING";
      await db
        .insert(deployments)
        .values({
          requirementId: req.id,
          codingTaskId: primaryTask.id,
          commitSha: run.head_sha,
          ghRunId,
          ghRunUrl: run.html_url,
          smokeTestStatus,
          deployedAt: smokeTestStatus === "PASSED" ? new Date(run.updated_at) : null,
        })
        .onConflictDoUpdate({
          target: [deployments.requirementId, deployments.ghRunId],
          set: {
            ghRunUrl: run.html_url,
            smokeTestStatus,
            ...(smokeTestStatus === "PASSED"
              ? { deployedAt: new Date(run.updated_at) }
              : {}),
          },
        });

      if (isFailure) {
        advance("FAILED", failureMsg);
      } else if (smokeTestStatus === "PASSED") {
        advance("DEPLOYED", null);
      } else {
        advance("DEPLOYING");
      }
    }
  }

  // 4. Reconcile Releases
  if (primaryTask?.mergeCommitSha) {
    const matchingRelease = releases.find(
      (rel) => rel.target_commitish === primaryTask?.mergeCommitSha,
    );
    if (matchingRelease) {
      await db
        .insert(deployments)
        .values({
          requirementId: req.id,
          codingTaskId: primaryTask.id,
          releaseTag: matchingRelease.tag_name,
          releaseUrl: matchingRelease.html_url,
          commitSha: matchingRelease.target_commitish,
          ghRunId: `release-${matchingRelease.tag_name}`,
          smokeTestStatus: "PASSED",
          deployedAt: matchingRelease.published_at
            ? new Date(matchingRelease.published_at)
            : new Date(matchingRelease.created_at),
        })
        .onConflictDoUpdate({
          target: [deployments.requirementId, deployments.ghRunId],
          set: {
            releaseTag: matchingRelease.tag_name,
            releaseUrl: matchingRelease.html_url,
            commitSha: matchingRelease.target_commitish,
            smokeTestStatus: "PASSED",
            deployedAt: matchingRelease.published_at
              ? new Date(matchingRelease.published_at)
              : new Date(matchingRelease.created_at),
          },
        });
      advance("DEPLOYED", null);
    }
  }

  await db
    .update(requirements)
    .set({
      status: currentStatus,
      failureReason,
      updatedAt: new Date(),
    })
    .where(eq(requirements.id, req.id));

  const updatedDetail = await getRequirementDetail(req.id);
  return NextResponse.json({ requirement: updatedDetail });
}
