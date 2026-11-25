import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { SyncRequirementButton } from "@/components/RequirementsTable";
import { StatusBadge } from "@/components/StatusBadge";
import { getRequirementDetail } from "@/db";
import { requireAdminSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const uuidSchema = z.string().uuid();

export default async function RequirementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAdminSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) {
    notFound();
  }

  const detail = await getRequirementDetail(id);
  if (!detail) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-800 bg-slate-950 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              &larr; Dashboard
            </Link>
            <h1 className="text-base font-semibold">{detail.title}</h1>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={detail.status} size="md" />
            <SyncRequirementButton requirementId={detail.id} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
        {detail.failureReason && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-900">
            <p className="font-semibold">Failure Reason</p>
            <p className="mt-1 font-mono text-xs">{detail.failureReason}</p>
          </div>
        )}

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-slate-800">
              {detail.slug}
            </span>
            {detail.project && (
              <span>
                {detail.project.repoOwner}/{detail.project.repoName}
              </span>
            )}
            <span>Created {detail.createdAt.toLocaleString()}</span>
          </div>
          <h2 className="mt-4 text-sm font-semibold text-slate-900">Requirement Prompt</h2>
          <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm text-slate-800">
            {detail.promptText}
          </pre>
        </section>

        {/* Plan Runs */}
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Plan Runs</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 font-semibold uppercase text-slate-600">
                <tr>
                  <th className="px-4 py-2.5">Ver</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Branch / Plan Path</th>
                  <th className="px-4 py-2.5">PR / Run</th>
                  <th className="px-4 py-2.5">Model / Qs</th>
                  <th className="px-4 py-2.5">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {detail.planRuns.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-4 text-center text-slate-400">
                      No plan runs recorded.
                    </td>
                  </tr>
                ) : (
                  detail.planRuns.map((plan) => (
                    <tr key={plan.id}>
                      <td className="px-4 py-3 font-mono">v{plan.version}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={plan.status} />
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-700">
                        <div>{plan.branchName ?? "—"}</div>
                        {plan.planPath && (
                          <div className="text-slate-500">{plan.planPath}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 space-x-2">
                        {plan.prUrl && (
                          <a
                            href={plan.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-sky-700 hover:underline"
                          >
                            PR #{plan.prNumber}
                          </a>
                        )}
                        {plan.ghRunUrl && (
                          <a
                            href={plan.ghRunUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-slate-600 hover:underline"
                          >
                            Actions Run
                          </a>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span>{plan.modelUsed ?? "waterfall"}</span>
                        {plan.openQuestionsCount > 0 && (
                          <span className="ml-2 text-amber-700">
                            {plan.openQuestionsCount} Qs
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {plan.updatedAt.toLocaleString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Coding Tasks */}
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Coding Tasks</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 font-semibold uppercase text-slate-600">
                <tr>
                  <th className="px-4 py-2.5">Feature Slug</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Branch</th>
                  <th className="px-4 py-2.5">Cursor / PR / Run</th>
                  <th className="px-4 py-2.5">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {detail.codingTasks.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-4 text-center text-slate-400">
                      No coding tasks started yet.
                    </td>
                  </tr>
                ) : (
                  detail.codingTasks.map((task) => (
                    <tr key={task.id}>
                      <td className="px-4 py-3 font-mono text-slate-800">
                        {task.featureSlug}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={task.status} />
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-600">
                        {task.branchName ?? "—"}
                      </td>
                      <td className="px-4 py-3 space-x-3">
                        {task.cursorTrackingUrl && (
                          <a
                            href={task.cursorTrackingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-violet-700 hover:underline"
                          >
                            Cursor Agent
                          </a>
                        )}
                        {task.prUrl && (
                          <a
                            href={task.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-sky-700 hover:underline"
                          >
                            PR #{task.prNumber}
                          </a>
                        )}
                        {task.ghRunUrl && (
                          <a
                            href={task.ghRunUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-slate-600 hover:underline"
                          >
                            Actions Run
                          </a>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {task.updatedAt.toLocaleString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Review Runs */}
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Review Runs</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 font-semibold uppercase text-slate-600">
                <tr>
                  <th className="px-4 py-2.5">Tests</th>
                  <th className="px-4 py-2.5">Verdict</th>
                  <th className="px-4 py-2.5">Findings</th>
                  <th className="px-4 py-2.5">Links</th>
                  <th className="px-4 py-2.5">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {detail.reviewRuns.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-4 text-center text-slate-400">
                      No review runs recorded.
                    </td>
                  </tr>
                ) : (
                  detail.reviewRuns.map((rev) => (
                    <tr key={rev.id}>
                      <td className="px-4 py-3">
                        <StatusBadge status={rev.testStatus} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={rev.verdict} />
                      </td>
                      <td className="px-4 py-3">
                        P0: {rev.p0Count} · P1: {rev.p1Count}
                        {rev.modelUsed ? ` · ${rev.modelUsed}` : ""}
                      </td>
                      <td className="px-4 py-3 space-x-3">
                        {rev.commentUrl && (
                          <a
                            href={rev.commentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-sky-700 hover:underline"
                          >
                            Review Comment
                          </a>
                        )}
                        {rev.ghRunUrl && (
                          <a
                            href={rev.ghRunUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-slate-600 hover:underline"
                          >
                            Actions Run
                          </a>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {rev.updatedAt.toLocaleString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Deployments */}
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Deployments</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 font-semibold uppercase text-slate-600">
                <tr>
                  <th className="px-4 py-2.5">Smoke Test</th>
                  <th className="px-4 py-2.5">Release</th>
                  <th className="px-4 py-2.5">Commit</th>
                  <th className="px-4 py-2.5">Actions Run</th>
                  <th className="px-4 py-2.5">Deployed At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {detail.deployments.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-4 text-center text-slate-400">
                      No deployments recorded.
                    </td>
                  </tr>
                ) : (
                  detail.deployments.map((dep) => (
                    <tr key={dep.id}>
                      <td className="px-4 py-3">
                        <StatusBadge status={dep.smokeTestStatus} />
                      </td>
                      <td className="px-4 py-3">
                        {dep.releaseTag && dep.releaseUrl ? (
                          <a
                            href={dep.releaseUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono font-medium text-emerald-700 hover:underline"
                          >
                            {dep.releaseTag}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-600">
                        {dep.commitSha ? dep.commitSha.slice(0, 7) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        {dep.ghRunUrl ? (
                          <a
                            href={dep.ghRunUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-slate-600 hover:underline"
                          >
                            Actions Run
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {dep.deployedAt ? dep.deployedAt.toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
