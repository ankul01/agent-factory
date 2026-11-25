"use client";

import { useState, type FormEvent } from "react";
import { slugifyTitle } from "@/lib/status";

export interface ProjectOption {
  id: number;
  name: string;
  repoOwner: string;
  repoName: string;
}

interface NewRequirementModalProps {
  isOpen: boolean;
  projects: ProjectOption[];
  defaultProjectId: number | null;
  onClose: () => void;
  onCreated: () => void;
}

export function NewRequirementModal({
  isOpen,
  projects,
  defaultProjectId,
  onClose,
  onCreated,
}: NewRequirementModalProps) {
  const [projectId, setProjectId] = useState<number>(
    defaultProjectId ?? projects[0]?.id ?? 1,
  );
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [model, setModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) {
    return null;
  }

  const handleTitleChange = (value: string) => {
    setTitle(value);
    if (!slugEdited) {
      setSlug(slugifyTitle(value));
    }
  };

  const handleSlugChange = (value: string) => {
    setSlugEdited(true);
    const cleaned = value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/--+/g, "-")
      .slice(0, 40);
    setSlug(cleaned);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const response = await fetch("/api/requirements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          title: title.trim(),
          slug: slug.trim(),
          promptText: promptText.trim(),
          ...(model.trim() ? { model: model.trim() } : {}),
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        failureReason?: string;
      };

      if (!response.ok) {
        setError(data.failureReason || data.error || `Request failed (${response.status})`);
        return;
      }

      setTitle("");
      setSlug("");
      setSlugEdited(false);
      setPromptText("");
      setModel("");
      onCreated();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Network error submitting requirement");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">New Requirement</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            Close
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700">Target Project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(Number(e.target.value))}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.repoOwner}/{p.repoName})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Title</label>
            <input
              type="text"
              required
              maxLength={160}
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="Add /api/version endpoint"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-slate-700">
                Slug (kebab-case)
              </label>
              <span className="text-xs text-slate-500">{slug.length}/40</span>
            </div>
            <input
              type="text"
              required
              maxLength={40}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="api-version-endpoint"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-slate-700">
                Requirement Prompt
              </label>
              <span className="text-xs text-slate-500">{promptText.length}/20000</span>
            </div>
            <textarea
              required
              rows={5}
              maxLength={20000}
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="Describe the requirement, acceptance criteria, and constraints..."
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">
              Model Override <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              type="text"
              maxLength={100}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Leave blank for default LLM waterfall"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
            />
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {submitting ? "Dispatching..." : "Dispatch Planner"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
