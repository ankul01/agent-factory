import assert from "node:assert/strict";
import test from "node:test";
import { computeHmacSha256Hex } from "./crypto";
import {
  extractCursorTrackingUrl,
  isDeployWorkflow,
  matchFeatureBranch,
  matchPlanBranch,
  matchPlanReferenceInBody,
  nextRequirementStatus,
  parseReviewComment,
  SLUG_REGEX,
  slugifyTitle,
} from "./status";
import { verifyGitHubWebhookSignature } from "./webhook";

test("SLUG_REGEX enforces <=40 char kebab-case and slugifyTitle truncates cleanly", () => {
  assert.equal(SLUG_REGEX.test("api-version-endpoint"), true);
  assert.equal(SLUG_REGEX.test("a".repeat(40)), true);
  assert.equal(SLUG_REGEX.test("a".repeat(41)), false);
  assert.equal(SLUG_REGEX.test("-bad-slug"), false);
  assert.equal(SLUG_REGEX.test("Bad_Slug"), false);

  const longSlug = slugifyTitle("Add a very long feature title that exceeds forty characters easily");
  assert.ok(longSlug.length <= 40);
  assert.equal(SLUG_REGEX.test(longSlug), true);
});

test("anchored branch matching prevents substring collisions", () => {
  const exactPlan = matchPlanBranch("plan/20261125-170000-auth", "auth");
  assert.equal(exactPlan.matched, true);
  assert.equal(exactPlan.planId, "20261125-170000-auth");

  // Substring collision check: 'auth' must NOT match 'plan/20261125-170000-auth-v2'
  const collisionPlan = matchPlanBranch("plan/20261125-170000-auth-v2", "auth");
  assert.equal(collisionPlan.matched, false);
  assert.equal(collisionPlan.planId, null);

  assert.equal(matchFeatureBranch("feat/20261125-170000-auth", "auth", "20261125-170000-auth"), true);
  assert.equal(matchFeatureBranch("feat/20261125-170000-auth-v2", "auth"), false);
  assert.equal(
    matchFeatureBranch("cursor/implement-20261125-171459-api-ping-endpoint-ac3c", "api-ping-endpoint"),
    true,
  );
  assert.equal(
    matchFeatureBranch("cursor/20261125-171459-api-ping-endpoint", "api-ping-endpoint"),
    true,
  );
  assert.equal(
    matchFeatureBranch("cursor/implement-20261125-171459-auth-v2-ac3c", "auth"),
    false,
  );
  assert.equal(
    matchPlanReferenceInBody("Implements docs/plans/20261125-170000-auth.md", "auth", "20261125-170000-auth"),
    true,
  );
  assert.equal(
    matchPlanReferenceInBody("Implements docs/plans/20261125-170000-auth-v2.md", "auth"),
    false,
  );
});

test("isDeployWorkflow identifies deploy workflow paths and names accurately", () => {
  assert.equal(
    isDeployWorkflow(".github/workflows/deploy.yml", "Package, Smoke Test, and Deploy Staging"),
    true,
  );
  assert.equal(isDeployWorkflow(".github/workflows/deploy.yml@main", "CI"), true);
  assert.equal(isDeployWorkflow(".github/workflows/pr-review.yml", "PR Review"), false);
});

test("nextRequirementStatus enforces monotonic progression, failure propagation, and recovery", () => {
  assert.equal(nextRequirementStatus("PLANNING", "AWAITING_PLAN_APPROVAL"), "AWAITING_PLAN_APPROVAL");
  assert.equal(nextRequirementStatus("PLAN_APPROVED", "PLANNING"), "PLAN_APPROVED");
  assert.equal(nextRequirementStatus("DEPLOYED", "IN_REVIEW"), "DEPLOYED");
  assert.equal(nextRequirementStatus("DEPLOYED", "FAILED"), "DEPLOYED");
  assert.equal(nextRequirementStatus("IN_REVIEW", "FAILED"), "FAILED");
  assert.equal(nextRequirementStatus("FAILED", "DEPLOYING"), "DEPLOYING");
});

test("parseReviewComment and extractCursorTrackingUrl extract metadata accurately", () => {
  const review = parseReviewComment(`
## Automated Code Review Summary
- **Verdict:** \`CHANGES_REQUESTED\`
- [P0] Missing auth check
- [P1] Unbounded query
- **Model:** \`gemini-4-hydrogen\`
  `);
  assert.equal(review.isReviewComment, true);
  assert.equal(review.verdict, "CHANGES_REQUESTED");
  assert.equal(review.p0Count, 1);
  assert.equal(review.p1Count, 1);
  assert.equal(review.modelUsed, "gemini-4-hydrogen");

  const cursor = extractCursorTrackingUrl(
    "Cursor Cloud Agent started: https://cursor.com/agents/agent_abc123",
  );
  assert.equal(cursor.cursorTrackingUrl, "https://cursor.com/agents/agent_abc123");
  assert.equal(cursor.cursorAgentId, "agent_abc123");
});

test("verifyGitHubWebhookSignature validates HMAC-SHA256 and rejects malformed headers", () => {
  const secret = "webhook-secret-1234567890";
  const body = JSON.stringify({ action: "opened" });
  const sig = `sha256=${computeHmacSha256Hex(body, secret)}`;

  assert.equal(verifyGitHubWebhookSignature(body, sig, secret), true);
  assert.equal(verifyGitHubWebhookSignature(body, "sha256=deadbeef", secret), false);
  assert.equal(verifyGitHubWebhookSignature(body, "invalid-prefix", secret), false);
  assert.equal(verifyGitHubWebhookSignature(body, sig, ""), false);
  assert.equal(verifyGitHubWebhookSignature(body, undefined, secret), false);
});
