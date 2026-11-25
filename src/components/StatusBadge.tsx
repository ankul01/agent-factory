interface StatusBadgeProps {
  status: string;
  size?: "sm" | "md";
}

const STATUS_STYLES: Record<string, string> = {
  RECEIVED: "bg-slate-100 text-slate-700 ring-slate-300",
  QUEUED: "bg-slate-100 text-slate-700 ring-slate-300",
  PENDING: "bg-slate-100 text-slate-700 ring-slate-300",
  PLANNING: "bg-sky-100 text-sky-800 ring-sky-300",
  RUNNING: "bg-sky-100 text-sky-800 ring-sky-300",
  AWAITING_PLAN_APPROVAL: "bg-amber-100 text-amber-800 ring-amber-300",
  PR_OPEN: "bg-amber-100 text-amber-800 ring-amber-300",
  PLAN_APPROVED: "bg-indigo-100 text-indigo-800 ring-indigo-300",
  APPROVED: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  CODING: "bg-violet-100 text-violet-800 ring-violet-300",
  IN_REVIEW: "bg-cyan-100 text-cyan-800 ring-cyan-300",
  MERGED: "bg-indigo-100 text-indigo-800 ring-indigo-300",
  DEPLOYING: "bg-blue-100 text-blue-800 ring-blue-300",
  DEPLOYED: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  PASSED: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  CHANGES_REQUESTED: "bg-orange-100 text-orange-800 ring-orange-300",
  FAILED: "bg-rose-100 text-rose-800 ring-rose-300",
};

export function StatusBadge({ status, size = "sm" }: StatusBadgeProps) {
  const style = STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700 ring-slate-300";
  const padding = size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs";

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ring-1 ring-inset whitespace-nowrap ${padding} ${style}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
