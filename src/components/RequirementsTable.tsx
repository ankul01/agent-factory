"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "./StatusBadge";

export function SyncRequirementButton({ requirementId }: { requirementId: string }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch(`/api/requirements/${requirementId}/sync`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Sync failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-rose-600">{error}</span>}
      <button
        type="button"
        disabled={syncing}
        onClick={handleSync}
        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {syncing ? "Syncing..." : "Sync Now"}
      </button>
    </div>
  );
}

export interface RequirementListItem {
  id: string;
  projectId: number;
  title: string;
  slug: string;
  status: string;
  failureReason: string | null;
  createdAt: string;
  project: {
    id: number;
    name: string;
    repoOwner: string;
    repoName: string;
  } | null;
  latestPlanRun: {
    id: string;
    status: string;
    prNumber: number | null;
    prUrl: string | null;
    ghRunUrl: string | null;
    openQuestionsCount: number;
    modelUsed: string | null;
  } | null;
  codingTasks: Array<{
    id: string;
    status: string;
    cursorTrackingUrl: string | null;
    prNumber: number | null;
    prUrl: string | null;
  }>;
  latestReviewRun: {
    id: string;
    testStatus: string;
    verdict: string;
    p0Count: number;
    p1Count: number;
    commentUrl: string | null;
  } | null;
  latestDeployment: {
    id: string;
    releaseTag: string | null;
    releaseUrl: string | null;
    commitSha: string | null;
    deployProvider: string | null;
    deployEnvironment: string | null;
    stagingUrl: string | null;
    deployStatus: string | null;
    smokeTestStatus: string;
    smokeTestLatencyMs: number | null;
    deployRunUrl: string | null;
  } | null;
}

interface RequirementsTableProps {
  requirements: RequirementListItem[];
  syncingId: string | null;
  onSync: (id: string) => void;
}

export function RequirementsTable({
  requirements,
  syncingId,
  onSync,
}: RequirementsTableProps) {
  if (requirements.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
        <p className="text-sm font-medium text-slate-700">No requirements submitted yet.</p>
        <p className="mt-1 text-xs text-slate-500">
          Click &ldquo;+ New Requirement&rdquo; to dispatch a planner workflow.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-600">
          <tr>
            <th className="px-4 py-3">Requirement</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Plan</th>
            <th className="px-4 py-3">Coding (Cursor)</th>
            <th className="px-4 py-3">Review</th>
            <th className="px-4 py-3">Deploy</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 bg-white">
          {requirements.map((req) => {
            const primaryTask = req.codingTasks[0] ?? null;
            const isSyncing = syncingId === req.id;

            return (
              <tr key={req.id} className="hover:bg-slate-50/70">
                <td className="px-4 py-3 align-top">
                  <Link
                    href={`/requirements/${req.id}`}
                    className="font-semibold text-slate-900 hover:text-sky-700 hover:underline"
                  >
                    {req.title}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">
                      {req.slug}
                    </span>
                    {req.project && (
                      <span>
                        {req.project.repoOwner}/{req.project.repoName}
                      </span>
                    )}
                    <span>{new Date(req.createdAt).toLocaleString()}</span>
                  </div>
                </td>

                <td className="px-4 py-3 align-top">
                  <StatusBadge status={req.status} />
                  {req.status === "FAILED" && req.failureReason && (
                    <p
                      className="mt-1 max-w-[200px] truncate text-xs text-rose-700"
                      title={req.failureReason}
                    >
                      {req.failureReason}
                    </p>
                  )}
                </td>

                <td className="px-4 py-3 align-top">
                  {req.latestPlanRun ? (
                    <div className="space-y-1">
                      <StatusBadge status={req.latestPlanRun.status} />
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        {req.latestPlanRun.prUrl && (
                          <a
                            href={req.latestPlanRun.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-sky-700 hover:underline"
                          >
                            Plan PR #{req.latestPlanRun.prNumber}
                          </a>
                        )}
                        {req.latestPlanRun.ghRunUrl && (
                          <a
                            href={req.latestPlanRun.ghRunUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-slate-600 hover:underline"
                          >
                            Run
                          </a>
                        )}
                        {req.latestPlanRun.openQuestionsCount > 0 && (
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">
                            {req.latestPlanRun.openQuestionsCount} Qs
                          </span>
                        )}
                        {req.latestPlanRun.modelUsed && (
                          <span className="font-mono text-slate-500">
                            {req.latestPlanRun.modelUsed}
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>

                <td className="px-4 py-3 align-top">
                  {primaryTask ? (
                    <div className="space-y-1">
                      <StatusBadge status={primaryTask.status} />
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        {primaryTask.cursorTrackingUrl && (
                          <a
                            href={primaryTask.cursorTrackingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-violet-700 hover:underline"
                          >
                            Cursor Agent
                          </a>
                        )}
                        {primaryTask.prUrl && (
                          <a
                            href={primaryTask.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-sky-700 hover:underline"
                          >
                            Code PR #{primaryTask.prNumber}
                          </a>
                        )}
                      </div>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>

                <td className="px-4 py-3 align-top">
                  {req.latestReviewRun ? (
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-1">
                        <StatusBadge status={req.latestReviewRun.testStatus} />
                        <StatusBadge status={req.latestReviewRun.verdict} />
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-600">
                        <span>P0:{req.latestReviewRun.p0Count}</span>
                        <span>P1:{req.latestReviewRun.p1Count}</span>
                        {req.latestReviewRun.commentUrl && (
                          <a
                            href={req.latestReviewRun.commentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-sky-700 hover:underline"
                          >
                            Comment
                          </a>
                        )}
                      </div>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>

                <td className="px-4 py-3 align-top">
                  {req.latestDeployment ? (
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {req.latestDeployment.deployStatus ? (
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                              req.latestDeployment.deployStatus === "live"
                                ? "bg-emerald-100 text-emerald-800 ring-emerald-300"
                                : req.latestDeployment.deployStatus === "deploying"
                                  ? "animate-pulse bg-amber-100 text-amber-800 ring-amber-300"
                                  : "bg-rose-100 text-rose-800 ring-rose-300"
                            }`}
                          >
                            {req.latestDeployment.deployStatus}
                          </span>
                        ) : (
                          <StatusBadge status={req.latestDeployment.smokeTestStatus} />
                        )}

                        {req.latestDeployment.deployProvider && (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700">
                            {req.latestDeployment.deployProvider === "render"
                              ? "Render Free · GHCR"
                              : req.latestDeployment.deployProvider}
                          </span>
                        )}
                      </div>

                      {req.latestDeployment.stagingUrl && (
                        <div>
                          <a
                            href={req.latestDeployment.stagingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline"
                          >
                            <span>Live Staging</span>
                            <svg
                              className="h-3 w-3"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                              />
                            </svg>
                          </a>
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        {req.latestDeployment.smokeTestStatus === "PASSED" && (
                          <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-mono text-[11px] text-emerald-800">
                            {req.latestDeployment.smokeTestLatencyMs !== null
                              ? `200 OK · ${req.latestDeployment.smokeTestLatencyMs}ms`
                              : "200 OK"}
                          </span>
                        )}
                        {req.latestDeployment.smokeTestStatus === "FAILED" && (
                          <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-800">
                            Smoke Failed
                          </span>
                        )}
                        {req.latestDeployment.commitSha && (
                          <span className="font-mono text-[11px] text-slate-500">
                            {req.latestDeployment.commitSha.slice(0, 7)}
                          </span>
                        )}
                        {req.latestDeployment.deployRunUrl && (
                          <a
                            href={req.latestDeployment.deployRunUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-slate-600 hover:underline"
                          >
                            Run
                          </a>
                        )}
                        {req.latestDeployment.releaseTag && req.latestDeployment.releaseUrl && (
                          <a
                            href={req.latestDeployment.releaseUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono font-medium text-emerald-700 hover:underline"
                          >
                            {req.latestDeployment.releaseTag}
                          </a>
                        )}
                      </div>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>

                <td className="px-4 py-3 text-right align-top">
                  <div className="inline-flex items-center gap-2">
                    <button
                      type="button"
                      disabled={isSyncing}
                      onClick={() => onSync(req.id)}
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {isSyncing ? "Syncing..." : "Sync"}
                    </button>
                    <Link
                      href={`/requirements/${req.id}`}
                      className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800"
                    >
                      Details
                    </Link>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
