const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";

function getGitHubHeaders(): Record<string, string> {
  const pat = process.env.GITHUB_PAT;
  if (!pat || pat.trim() === "") {
    throw new Error("GITHUB_PAT environment variable is not configured.");
  }

  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "agent-factory-orchestrator",
  };
}

async function githubFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = {
    ...getGitHubHeaders(),
    ...(init?.headers ?? {}),
  };

  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    const truncated = rawBody.slice(0, 400);
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${truncated}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export interface DispatchPlannerParams {
  owner: string;
  repo: string;
  workflowFile: string;
  ref: string;
  requirement: string;
  slug: string;
  model?: string;
}

export interface DispatchPlannerResult {
  ghRunId: string | null;
  ghRunUrl: string | null;
}

interface DispatchRunDetailsResponse {
  workflow_run_id?: number | string;
  run_url?: string;
  html_url?: string;
}

export async function dispatchPlannerWorkflow(
  params: DispatchPlannerParams,
): Promise<DispatchPlannerResult> {
  const { owner, repo, workflowFile, ref, requirement, slug, model } = params;
  const inputs: Record<string, string> = {
    requirement,
    slug,
    ...(model && model.trim() !== "" ? { model: model.trim() } : {}),
  };

  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
    {
      method: "POST",
      headers: {
        ...getGitHubHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref,
        inputs,
        return_run_details: true,
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    throw new Error(
      `GitHub dispatch failed (${response.status} ${response.statusText}): ${rawBody.slice(0, 400)}`,
    );
  }

  if (response.status === 204) {
    return { ghRunId: null, ghRunUrl: null };
  }

  const text = await response.text();
  if (!text.trim()) {
    return { ghRunId: null, ghRunUrl: null };
  }

  const data = JSON.parse(text) as DispatchRunDetailsResponse;
  const ghRunId =
    data.workflow_run_id !== undefined && data.workflow_run_id !== null
      ? String(data.workflow_run_id)
      : null;
  const ghRunUrl =
    data.html_url ??
    (ghRunId ? `https://github.com/${owner}/${repo}/actions/runs/${ghRunId}` : null);

  return { ghRunId, ghRunUrl };
}

export interface GitHubWorkflowRun {
  id: number;
  name: string | null;
  path?: string;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  head_branch: string | null;
  head_sha: string;
  event: string;
  created_at: string;
  updated_at: string;
  pull_requests?: Array<{ number: number }>;
}

export async function getWorkflowRun(
  owner: string,
  repo: string,
  runId: string,
): Promise<GitHubWorkflowRun> {
  return githubFetch<GitHubWorkflowRun>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}`,
  );
}

export async function listWorkflowRuns(
  owner: string,
  repo: string,
  perPage: number = 30,
): Promise<GitHubWorkflowRun[]> {
  const data = await githubFetch<{ workflow_runs: GitHubWorkflowRun[] }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?per_page=${perPage}`,
  );
  return data.workflow_runs ?? [];
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged_at: string | null;
  merge_commit_sha: string | null;
  html_url: string;
  head: {
    ref: string;
    sha: string;
  };
}

export async function listRecentPullRequests(
  owner: string,
  repo: string,
  perPage: number = 20,
): Promise<GitHubPullRequest[]> {
  return githubFetch<GitHubPullRequest[]>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&per_page=${perPage}&sort=updated&direction=desc`,
  );
}

export async function getPullRequest(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubPullRequest> {
  return githubFetch<GitHubPullRequest>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
  );
}

export async function searchPullRequestsBySlug(
  owner: string,
  repo: string,
  slug: string,
): Promise<GitHubPullRequest[]> {
  const q = encodeURIComponent(`repo:${owner}/${repo} is:pr ${slug}`);
  const searchData = await githubFetch<{ items: Array<{ number: number }> }>(
    `/search/issues?q=${q}&per_page=20`,
  );

  const numbers = (searchData.items ?? []).map((item) => item.number);
  const prs = await Promise.all(
    numbers.map((num) => getPullRequest(owner, repo, num).catch(() => null)),
  );

  return prs.filter((pr): pr is GitHubPullRequest => pr !== null);
}

export interface GitHubIssueComment {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export async function listIssueComments(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubIssueComment[]> {
  return githubFetch<GitHubIssueComment[]>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prNumber}/comments?per_page=50`,
  );
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  html_url: string;
  target_commitish: string;
  published_at: string | null;
  created_at: string;
}

export async function listReleases(
  owner: string,
  repo: string,
  perPage: number = 15,
): Promise<GitHubRelease[]> {
  return githubFetch<GitHubRelease[]>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${perPage}`,
  );
}
