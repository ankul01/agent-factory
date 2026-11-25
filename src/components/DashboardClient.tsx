"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { NewRequirementModal, type ProjectOption } from "./NewRequirementModal";
import { RequirementsTable, type RequirementListItem } from "./RequirementsTable";

interface DashboardClientProps {
  initialProjects: ProjectOption[];
  initialRequirements: RequirementListItem[];
}

export function DashboardClient({
  initialProjects,
  initialRequirements,
}: DashboardClientProps) {
  const router = useRouter();
  const [projects] = useState<ProjectOption[]>(initialProjects);
  const [requirements, setRequirements] =
    useState<RequirementListItem[]>(initialRequirements);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const fetchRequirements = useCallback(async (projectFilter: string) => {
    setRefreshing(true);
    setBannerError(null);
    try {
      const qs =
        projectFilter !== "all" ? `?projectId=${encodeURIComponent(projectFilter)}` : "";
      const res = await fetch(`/api/requirements${qs}`, { cache: "no-store" });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) {
        throw new Error(`Failed to fetch requirements (${res.status})`);
      }
      const data = (await res.json()) as { requirements: RequirementListItem[] };
      setRequirements(data.requirements);
    } catch (err: unknown) {
      setBannerError(err instanceof Error ? err.message : "Failed to refresh requirements");
    } finally {
      setRefreshing(false);
    }
  }, [router]);

  const handleProjectChange = (value: string) => {
    setSelectedProjectId(value);
    void fetchRequirements(value);
  };

  const handleSync = async (id: string) => {
    setSyncingId(id);
    setBannerError(null);
    try {
      const res = await fetch(`/api/requirements/${id}/sync`, { method: "POST" });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || `Sync failed (${res.status})`);
      }
      await fetchRequirements(selectedProjectId);
    } catch (err: unknown) {
      setBannerError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncingId(null);
    }
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  const kpis = useMemo(() => {
    const total = requirements.length;
    const awaitingPlan = requirements.filter(
      (r) => r.status === "AWAITING_PLAN_APPROVAL",
    ).length;
    const deployed = requirements.filter((r) => r.status === "DEPLOYED").length;
    const failed = requirements.filter((r) => r.status === "FAILED").length;
    const inProgress = requirements.filter(
      (r) =>
        r.status !== "DEPLOYED" &&
        r.status !== "FAILED" &&
        r.status !== "AWAITING_PLAN_APPROVAL",
    ).length;
    return { total, inProgress, awaitingPlan, deployed, failed };
  }, [requirements]);

  const defaultProjectId =
    selectedProjectId !== "all"
      ? Number(selectedProjectId)
      : (projects[0]?.id ?? null);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-800 bg-slate-950 text-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500 font-mono text-sm font-bold text-slate-950">
              AF
            </span>
            <div>
              <h1 className="text-base font-semibold tracking-tight">Agent Factory</h1>
              <p className="text-xs text-slate-400">Software Factory Orchestrator</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <select
              value={selectedProjectId}
              onChange={(e) => handleProjectChange(e.target.value)}
              aria-label="Filter by project"
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-sky-400 focus:outline-none"
            >
              <option value="all">All Projects</option>
              {projects.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.repoOwner}/{p.repoName}
                </option>
              ))}
            </select>

            <button
              type="button"
              disabled={refreshing}
              onClick={() => fetchRequirements(selectedProjectId)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>

            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="rounded-lg bg-sky-500 px-3.5 py-1.5 text-sm font-semibold text-slate-950 hover:bg-sky-400"
            >
              + New Requirement
            </button>

            <button
              type="button"
              onClick={handleLogout}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        {bannerError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {bannerError}
          </div>
        )}

        <section className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Total</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{kpis.total}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
              In Progress
            </p>
            <p className="mt-1 text-2xl font-bold text-sky-700">{kpis.inProgress}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Awaiting Plan Approval
            </p>
            <p className="mt-1 text-2xl font-bold text-amber-700">{kpis.awaitingPlan}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Deployed
            </p>
            <p className="mt-1 text-2xl font-bold text-emerald-700">{kpis.deployed}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Failed
            </p>
            <p className="mt-1 text-2xl font-bold text-rose-700">{kpis.failed}</p>
          </div>
        </section>

        <RequirementsTable
          requirements={requirements}
          syncingId={syncingId}
          onSync={handleSync}
        />
      </main>

      <NewRequirementModal
        isOpen={modalOpen}
        projects={projects}
        defaultProjectId={defaultProjectId}
        onClose={() => setModalOpen(false)}
        onCreated={() => void fetchRequirements(selectedProjectId)}
      />
    </div>
  );
}
