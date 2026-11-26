import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { codingTasks, deployments, projects, requirements } from "@/db/schema";
import { isRequirementStatus, nextRequirementStatus, type RequirementStatus } from "@/lib/status";
import { verifyGitHubWebhookSignature } from "@/lib/webhook";

const deployWebhookSchema = z.object({
  repo: z.string().min(1),
  commitSha: z.string().min(1),
  releaseTag: z.string().optional(),
  provider: z.string().min(1),
  environment: z.string().min(1).default("staging"),
  stagingUrl: z.string().nullable().optional(),
  status: z.enum(["deploying", "live", "failed"]),
  smokeTestStatus: z.enum(["passed", "failed", "skipped"]).optional(),
  smokeTestLatencyMs: z.number().int().nonnegative().nullable().optional(),
  imageUri: z.string().optional(),
  workflowRunUrl: z.string().min(1),
});

function mapSmokeTestStatus(
  smokeTestStatus: "passed" | "failed" | "skipped" | undefined,
  deployStatus: "deploying" | "live" | "failed",
): string {
  if (smokeTestStatus === "passed") return "PASSED";
  if (smokeTestStatus === "failed") return "FAILED";
  if (smokeTestStatus === "skipped") return "SKIPPED";
  if (deployStatus === "live") return "PASSED";
  if (deployStatus === "failed") return "FAILED";
  return "PENDING";
}

function extractRunIdFromUrl(url: string, commitSha: string): string {
  const match = /\/runs\/(\d+)/.exec(url);
  return match ? match[1] : `deploy-${commitSha.slice(0, 12)}`;
}

export async function POST(request: Request) {
  const secret = process.env.FACTORY_WEBHOOK_SECRET;
  const rawBody = await request.text();
  const signature = request.headers.get("x-factory-signature-256");

  if (!verifyGitHubWebhookSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = deployWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const db = getDb();
  const normalizedSmokeStatus = mapSmokeTestStatus(data.smokeTestStatus, data.status);
  const ghRunId = extractRunIdFromUrl(data.workflowRunUrl, data.commitSha);
  const deployedAt = data.status === "live" ? new Date() : null;

  // 1. Match existing deployment by commitSha first
  const [existingBySha] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.commitSha, data.commitSha))
    .orderBy(desc(deployments.createdAt))
    .limit(1);

  if (existingBySha) {
    const [updated] = await db
      .update(deployments)
      .set({
        ...(data.releaseTag !== undefined ? { releaseTag: data.releaseTag } : {}),
        deployProvider: data.provider,
        deployEnvironment: data.environment,
        stagingUrl: data.stagingUrl ?? existingBySha.stagingUrl,
        deployStatus: data.status,
        smokeTestStatus: normalizedSmokeStatus,
        smokeTestLatencyMs: data.smokeTestLatencyMs ?? existingBySha.smokeTestLatencyMs,
        deployedImageUri: data.imageUri ?? existingBySha.deployedImageUri,
        deployRunUrl: data.workflowRunUrl,
        ghRunUrl: data.workflowRunUrl,
        ...(deployedAt ? { deployedAt } : {}),
      })
      .where(eq(deployments.id, existingBySha.id))
      .returning();

    const [parentReq] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.id, existingBySha.requirementId))
      .limit(1);

    if (parentReq) {
      const cur: RequirementStatus = isRequirementStatus(parentReq.status)
        ? parentReq.status
        : "RECEIVED";
      const candidate: RequirementStatus =
        data.status === "live"
          ? "DEPLOYED"
          : data.status === "failed"
            ? "FAILED"
            : "DEPLOYING";
      await db
        .update(requirements)
        .set({
          status: nextRequirementStatus(cur, candidate),
          ...(data.status === "live"
            ? { failureReason: null }
            : data.status === "failed"
              ? { failureReason: "Staging deployment failed" }
              : {}),
          updatedAt: new Date(),
        })
        .where(eq(requirements.id, parentReq.id));
    }

    return NextResponse.json({ ok: true, id: updated.id, status: data.status });
  }

  // 2. Otherwise locate project & latest requirement for repo
  const [ownerPart, namePart] = data.repo.includes("/")
    ? data.repo.split("/", 2)
    : [null, data.repo];

  const [project] = ownerPart
    ? await db
        .select()
        .from(projects)
        .where(and(eq(projects.repoOwner, ownerPart), eq(projects.repoName, namePart)))
        .limit(1)
    : await db
        .select()
        .from(projects)
        .where(eq(projects.repoName, namePart))
        .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Unknown repository" }, { status: 404 });
  }

  const projectReqs = await db
    .select()
    .from(requirements)
    .where(eq(requirements.projectId, project.id))
    .orderBy(desc(requirements.updatedAt), desc(requirements.createdAt));

  if (projectReqs.length === 0) {
    return NextResponse.json({ error: "No requirements found for repository" }, { status: 404 });
  }

  // Prefer matching coding_task.mergeCommitSha, else latest DEPLOYING/DEPLOYED/most recent req
  let targetReq = projectReqs[0];
  let targetTaskId: string | null = null;

  for (const r of projectReqs) {
    const [task] = await db
      .select()
      .from(codingTasks)
      .where(eq(codingTasks.requirementId, r.id))
      .orderBy(desc(codingTasks.createdAt))
      .limit(1);
    if (task?.mergeCommitSha === data.commitSha) {
      targetReq = r;
      targetTaskId = task.id;
      break;
    }
  }

  if (!targetTaskId) {
    const preferred =
      projectReqs.find((r) => r.status === "DEPLOYING") ??
      projectReqs.find((r) => r.status === "DEPLOYED") ??
      projectReqs[0];
    targetReq = preferred;
    const [task] = await db
      .select()
      .from(codingTasks)
      .where(eq(codingTasks.requirementId, preferred.id))
      .orderBy(desc(codingTasks.createdAt))
      .limit(1);
    targetTaskId = task?.id ?? null;
  }

  const [upserted] = await db
    .insert(deployments)
    .values({
      requirementId: targetReq.id,
      codingTaskId: targetTaskId,
      releaseTag: data.releaseTag ?? null,
      commitSha: data.commitSha,
      ghRunId,
      ghRunUrl: data.workflowRunUrl,
      deployProvider: data.provider,
      deployEnvironment: data.environment,
      stagingUrl: data.stagingUrl ?? null,
      deployStatus: data.status,
      smokeTestStatus: normalizedSmokeStatus,
      smokeTestLatencyMs: data.smokeTestLatencyMs ?? null,
      deployedImageUri: data.imageUri ?? null,
      deployRunUrl: data.workflowRunUrl,
      deployedAt,
    })
    .onConflictDoUpdate({
      target: [deployments.requirementId, deployments.ghRunId],
      set: {
        ...(data.releaseTag !== undefined ? { releaseTag: data.releaseTag } : {}),
        commitSha: data.commitSha,
        ghRunUrl: data.workflowRunUrl,
        deployProvider: data.provider,
        deployEnvironment: data.environment,
        stagingUrl: data.stagingUrl ?? existingBySha.stagingUrl,
        deployStatus: data.status,
        smokeTestStatus: normalizedSmokeStatus,
        smokeTestLatencyMs: data.smokeTestLatencyMs ?? null,
        deployedImageUri: data.imageUri ?? null,
        deployRunUrl: data.workflowRunUrl,
        ...(deployedAt ? { deployedAt } : {}),
      },
    })
    .returning();

  const cur: RequirementStatus = isRequirementStatus(targetReq.status)
    ? targetReq.status
    : "RECEIVED";
  const candidate: RequirementStatus =
    data.status === "live"
      ? "DEPLOYED"
      : data.status === "failed"
        ? "FAILED"
        : "DEPLOYING";

  await db
    .update(requirements)
    .set({
      status: nextRequirementStatus(cur, candidate),
      ...(data.status === "live"
        ? { failureReason: null }
        : data.status === "failed"
          ? { failureReason: "Staging deployment failed" }
          : {}),
      updatedAt: new Date(),
    })
    .where(eq(requirements.id, targetReq.id));

  return NextResponse.json({ ok: true, id: upserted.id, status: data.status });
}
