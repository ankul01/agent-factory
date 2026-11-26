export const REQUIREMENT_STATUSES = [
  "RECEIVED",
  "PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "PLAN_APPROVED",
  "CODING",
  "IN_REVIEW",
  "DEPLOYING",
  "DEPLOYED",
  "FAILED",
] as const;

export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const PLAN_RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "PR_OPEN",
  "APPROVED",
  "FAILED",
] as const;

export type PlanRunStatus = (typeof PLAN_RUN_STATUSES)[number];

export const CODING_TASK_STATUSES = [
  "QUEUED",
  "RUNNING",
  "PR_OPEN",
  "MERGED",
  "FAILED",
] as const;

export type CodingTaskStatus = (typeof CODING_TASK_STATUSES)[number];

export const TEST_STATUSES = ["PENDING", "PASSED", "FAILED"] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const REVIEW_VERDICTS = ["PENDING", "APPROVED", "CHANGES_REQUESTED"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const LIFECYCLE_RANK: Record<Exclude<RequirementStatus, "FAILED">, number> = {
  RECEIVED: 0,
  PLANNING: 1,
  AWAITING_PLAN_APPROVAL: 2,
  PLAN_APPROVED: 3,
  CODING: 4,
  IN_REVIEW: 5,
  DEPLOYING: 6,
  DEPLOYED: 7,
};

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalizes arbitrary text into a valid <=40 char kebab-case slug.
 */
export function slugifyTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * Anchored match for plan branches:
 * - plan/<YYYYMMDD-HHMMSS>-<slug>
 * - plan/<slug>
 */
export function matchPlanBranch(
  branchName: string | null | undefined,
  slug: string,
): { matched: boolean; planId: string | null } {
  if (!branchName || !SLUG_REGEX.test(slug)) {
    return { matched: false, planId: null };
  }

  const escaped = escapeRegExp(slug);
  const timestamped = new RegExp(`^plan/(\\d{8}-\\d{6}-${escaped})$`);
  const tsMatch = timestamped.exec(branchName);
  if (tsMatch) {
    return { matched: true, planId: tsMatch[1] };
  }

  const exact = new RegExp(`^plan/(${escaped})$`);
  const exactMatch = exact.exec(branchName);
  if (exactMatch) {
    return { matched: true, planId: exactMatch[1] };
  }

  return { matched: false, planId: null };
}

/**
 * Anchored match for coding feature branches:
 * - feat/<planId> (when planId is known)
 * - ^(?:cursor|feat|feature|fix)/(?:implement-)?(?:\d{8}-\d{6}-)?<slug>(?:-[a-f0-9]{4,8})?$
 */
export function matchFeatureBranch(
  branchName: string | null | undefined,
  slug: string,
  planId?: string | null,
): boolean {
  if (!branchName || !SLUG_REGEX.test(slug)) {
    return false;
  }

  if (planId && branchName === `feat/${planId}`) {
    return true;
  }

  const escaped = escapeRegExp(slug);
  const re = new RegExp(
    `^(?:cursor|feat|feature|fix)/(?:implement-)?(?:\\d{8}-\\d{6}-)?${escaped}(?:-[a-f0-9]{4,8})?$`,
  );
  return re.test(branchName);
}

/**
 * Identifies whether a GitHub Actions workflow run belongs to a deploy workflow.
 */
export function isDeployWorkflow(
  path?: string | null,
  name?: string | null,
): boolean {
  const normalizedPath = (path ?? "").toLowerCase().replace(/@.*$/, "");
  if (
    normalizedPath === "deploy.yml" ||
    normalizedPath === "deploy.yaml" ||
    normalizedPath.endsWith("/deploy.yml") ||
    normalizedPath.endsWith("/deploy.yaml")
  ) {
    return true;
  }

  return (name ?? "").toLowerCase().includes("deploy");
}

/**
 * Fallback match for PR bodies referencing an approved plan file:
 * docs/plans/<planId>.md or docs/plans/(<YYYYMMDD-HHMMSS>-)?<slug>.md
 */
export function matchPlanReferenceInBody(
  prBody: string | null | undefined,
  slug: string,
  planId?: string | null,
): boolean {
  if (!prBody || !SLUG_REGEX.test(slug)) {
    return false;
  }

  if (planId && prBody.includes(`docs/plans/${planId}.md`)) {
    return true;
  }

  const escaped = escapeRegExp(slug);
  const re = new RegExp(`docs/plans/(?:\\d{8}-\\d{6}-)?${escaped}\\.md`);
  return re.test(prBody);
}

/**
 * Monotonic state transition guard preventing out-of-order webhooks or sync
 * from regressing requirement status.
 */
export function nextRequirementStatus(
  current: RequirementStatus,
  candidate: RequirementStatus,
): RequirementStatus {
  if (current === "DEPLOYED") {
    return "DEPLOYED";
  }
  if (candidate === "FAILED") {
    return "FAILED";
  }
  if (current === "FAILED") {
    return candidate;
  }

  return LIFECYCLE_RANK[candidate] >= LIFECYCLE_RANK[current] ? candidate : current;
}

export function isRequirementStatus(value: string): value is RequirementStatus {
  return (REQUIREMENT_STATUSES as readonly string[]).includes(value);
}

export interface ParsedReviewComment {
  isReviewComment: boolean;
  verdict: ReviewVerdict;
  p0Count: number;
  p1Count: number;
  modelUsed: string | null;
}

/**
 * Parses automated PR review comments posted by GitHub Actions workflows.
 */
export function parseReviewComment(body: string | null | undefined): ParsedReviewComment {
  if (!body) {
    return {
      isReviewComment: false,
      verdict: "PENDING",
      p0Count: 0,
      p1Count: 0,
      modelUsed: null,
    };
  }

  const hasMarker =
    /Verdict:/i.test(body) ||
    /Automated Code Review/i.test(body) ||
    /AI Code Review/i.test(body) ||
    /\[P0\]|\[P1\]/i.test(body);

  if (!hasMarker) {
    return {
      isReviewComment: false,
      verdict: "PENDING",
      p0Count: 0,
      p1Count: 0,
      modelUsed: null,
    };
  }

  let verdict: ReviewVerdict = "PENDING";
  if (/\bCHANGES_REQUESTED\b/i.test(body)) {
    verdict = "CHANGES_REQUESTED";
  } else if (/\bAPPROVED\b/i.test(body)) {
    verdict = "APPROVED";
  }

  const p0Matches = body.match(/\[P0\]/gi);
  const p1Matches = body.match(/\[P1\]/gi);

  let modelUsed: string | null = null;
  const modelMatch = /\*?\*?Model:?\*?\*?\s*`([^`]+)`/i.exec(body);
  if (modelMatch) {
    modelUsed = modelMatch[1].trim();
  }

  return {
    isReviewComment: true,
    verdict,
    p0Count: p0Matches ? p0Matches.length : 0,
    p1Count: p1Matches ? p1Matches.length : 0,
    modelUsed,
  };
}

/**
 * Extracts Cursor Cloud Agent tracking URL and agent ID from PR comments.
 */
export function extractCursorTrackingUrl(body: string | null | undefined): {
  cursorTrackingUrl: string | null;
  cursorAgentId: string | null;
} {
  if (!body) {
    return { cursorTrackingUrl: null, cursorAgentId: null };
  }

  const urlMatch = /(https:\/\/cursor\.com\/agents[^\s)]+)/i.exec(body);
  const cursorTrackingUrl = urlMatch ? urlMatch[1] : null;

  let cursorAgentId: string | null = null;
  if (cursorTrackingUrl) {
    const idMatch = /\/agents\/([A-Za-z0-9_-]+)/.exec(cursorTrackingUrl);
    if (idMatch) {
      cursorAgentId = idMatch[1];
    }
  }

  return { cursorTrackingUrl, cursorAgentId };
}
