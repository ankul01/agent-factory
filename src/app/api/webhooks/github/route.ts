import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  handleIssueCommentWebhook,
  handlePullRequestWebhook,
  handleReleaseWebhook,
  handleWorkflowRunWebhook,
  verifyGitHubWebhookSignature,
} from "@/lib/webhook";

export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || secret.trim() === "") {
    return NextResponse.json(
      { error: "GITHUB_WEBHOOK_SECRET is not configured" },
      { status: 500 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyGitHubWebhookSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const event = request.headers.get("x-github-event") ?? "";
  const db = getDb();

  let result = `ignored: unsupported event ${event}`;
  switch (event) {
    case "pull_request":
      result = await handlePullRequestWebhook(db, payload);
      break;
    case "workflow_run":
      result = await handleWorkflowRunWebhook(db, payload);
      break;
    case "issue_comment":
      result = await handleIssueCommentWebhook(db, payload);
      break;
    case "release":
      result = await handleReleaseWebhook(db, payload);
      break;
    case "ping":
      result = "pong";
      break;
    default:
      break;
  }

  return NextResponse.json({ ok: true, event, result });
}
