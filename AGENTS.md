# AGENTS.md — `ankul01/agent-factory`

Control plane, centralized Python execution engine, reusable GitHub Actions workflows, and versioned skill contracts for the **Agent Factory** software factory.

## Repository Architecture & Boundaries

| Path | Stack & Responsibility | Deployment / Runtime |
|---|---|---|
| `src/` | Next.js 16 App Router, TypeScript, Drizzle ORM, Neon Postgres (`sin1`), Tailwind v4. Dashboard UI, requirement dispatch, and webhook/callback ingestion. | Vercel Hobby (`sin1`, **$0 free tier**) |
| `engine/` | Python 3.12 (`uv`, `httpx`, `pydantic`, `pyyaml`, `pytest`, `respx`, `ruff`). All CI business logic: LLM routing, GitHub API wrappers, config/prompt loading, and stage runners (`factory-engine <plan\|revise\|trigger-coder\|review>`). | Executed via sibling sparse-checkout in GitHub Actions |
| `.github/workflows/` | Thin centralized `workflow_call` workflows invoked by target repositories (e.g., `ankul01/task-manager`) plus `engine-ci.yml`. | GitHub Actions Free |
| `skills/` | Versioned archetype skill contracts (e.g., `skills/backend-java.md`, `skills/fullstack-next.md` (planned)). | Read by coding agents & `engine/` |
| `.agent-factory/prompts/` (planned) | Versioned stage prompt contracts (`enhancer`, `planner`, `coder`, `reviewer`). | Read by Next.js API & `engine/` |

### Hard Architectural Rules for Coding Agents
1. **Factory-First & Repo-Agnostic Core:** Never hardcode target-repo assumptions (Java/Maven, `task-manager`, specific health paths) into `engine/factory_engine/config.py` defaults or reusable workflow logic. Target-specific settings belong in each target repo's `.agent-factory.yml` or caller workflow inputs.
2. **Thin YAML, Rich Python:** Keep `.github/workflows/reusable-*.yml` strictly to CI plumbing (checkouts, runtime setup, env wiring, invoking `factory-engine`). Do not add new inline Python scripts inside YAML files.
3. **$0 Permanent Free-Tier Constraint:** Do not introduce paid SaaS dependencies, long-running servers, or unbounded LLM/API loops. All serverless routes and engine calls must enforce explicit timeouts and bounded retries.
4. **Strict Workspace Isolation:** Inside `engine/`, all git and file mutations must target `--target-dir` only. Treat `--factory-dir` (`engine/`, `skills/`, and `.agent-factory/prompts/` when present) as strictly read-only.

## Verification Commands (Mechanical Checks — Run Before Opening PRs)

Style, formatting, imports, and types are enforced by tooling rather than code review comments. Run the commands matching the directories you touched:

```bash
# Control plane (src/, next.config.*, package.json)
npx tsc --noEmit
npm run lint
npm run build

# Python engine (engine/**)
cd engine && uv run ruff check . && uv run pytest -v

# GitHub Actions workflows (.github/workflows/**)
python3 -c 'import glob, yaml; [yaml.safe_load(open(f)) for f in glob.glob(".github/workflows/*.yml")]'
# If actionlint is installed locally:
actionlint .github/workflows/*.yml
```

---

## Code Review Rules

Focus exclusively on high-signal `[P0]` blockers and `[P1]` correctness, security, and reliability bugs. Skip formatting, naming nitpicks, and lint issues already covered by `ruff`, `eslint`, and `tsc`.

### Webhook Security, Auth & Secret Handling

- **[P0] Constant-Time Signature Verification on Public Webhooks**
  - **Invariant:** Every route in `src/proxy.ts` `PUBLIC_EXACT_PATHS` that ingests external webhooks (`/api/webhooks/github`, `/api/webhooks/deploy`) must verify its HMAC-SHA256 signature against the **raw request body** using `crypto.timingSafeEqual` (via `verifyGitHubWebhookSignature` or equivalent) before parsing JSON or touching the database. Callback routes (`/api/callbacks/workflow`) must verify `ORCHESTRATOR_CALLBACK_SECRET` with constant-time comparison.
  - **Why:** Public routes bypass session auth; missing or non-constant-time verification allows spoofed deployment/PR state transitions in Neon Postgres.
  - **Safe path:** Only `/api/health`, `/api/auth/logout`, `/favicon.ico`, and intentionally public auth entrypoints may be in `PUBLIC_EXACT_PATHS` without HMAC/Bearer validation.

- **[P0] Never Expose Authenticated Control-Plane Endpoints or Secrets**
  - **Invariant:** Requirement creation, prompt enhancement, project management, and dispatch endpoints must never be added to `PUBLIC_EXACT_PATHS` in `src/proxy.ts`. API keys (`GEMINI_API_KEY`, `NVIDIA_API_KEY`, `FACTORY_WEBHOOK_SECRET`, `ORCHESTRATOR_CALLBACK_SECRET`, `RENDER_DEPLOY_HOOK_URL`, `GH_TOKEN`) must never be logged, interpolated into error responses, or exposed via `NEXT_PUBLIC_*`.
  - **Why:** Unauthenticated access drains free-tier LLM/GitHub quotas and allows arbitrary workflow dispatch; leaked secrets compromise target repositories and staging hooks.
  - **Safe path:** Server-side error logs may include HTTP status codes, provider/model names, and truncated non-secret response bodies (<=300 chars) after stripping auth headers.

### Database Schema, Idempotency & State Machine Invariants

- **[P0] Strictly Additive Drizzle Schema Changes**
  - **Invariant:** Changes to `src/db/schema.ts` must only add nullable columns, defaulted columns, or new tables/indexes. Never drop, rename, or tighten nullability on existing live columns in a single PR without a documented multi-step backfill plan.
  - **Why:** `agent-factory` syncs Neon Postgres via `drizzle-kit push` against a live Vercel deployment; destructive alters cause immediate runtime errors or data loss during rollout.
  - **Safe path:** Adding nullable columns (`text("...")`, `integer("...")`), columns with `.default(...)`, or brand-new tables is safe.

- **[P0] Idempotent Webhook Upserts & Unique Index Alignment**
  - **Invariant:** Webhook and callback handlers writing to `deployments`, `plan_runs`, `coding_tasks`, or `review_runs` must handle duplicate and out-of-order deliveries cleanly using `.onConflictDoUpdate` (or an atomic match-and-update) aligned with the table's unique indexes (e.g., `deployments_req_gh_run_idx`, `coding_tasks_req_feature_idx`, `review_runs_task_gh_run_idx`) and must always populate `NOT NULL` columns such as `ghRunId` and `requirementId`.
  - **Why:** GitHub retries webhooks and parallel jobs (`release` + `deploy-staging`) share the same `gh_run_id`; plain `.insert()` calls throw Postgres `23505` unique-constraint or `23502` not-null failures.
  - **Safe path:** Upserts keyed on the table's exact unique index or transactional lookup-then-update paths with explicit `NOT NULL` defaults.

- **[P1] Monotonic Requirement Status & Casing Contracts**
  - **Invariant:** Updates to `requirements.status` must pass through `nextRequirementStatus(...)` rather than overwriting status directly. Status field casing must match UI and schema contracts (`smokeTestStatus` uppercase: `PENDING` / `PASSED` / `FAILED` / `SKIPPED`; `deployStatus` lowercase: `deploying` / `live` / `failed`).
  - **Why:** Out-of-order webhooks can regress a `DEPLOYED` requirement back to `DEPLOYING`, and casing mismatches silently break dashboard badges.
  - **Safe path:** Explicit user-triggered admin resets that intentionally bypass monotonicity and are documented in code comments.

### Python Engine (`engine/`) & LLM Resilience

- **[P0] Offline Deterministic Tests & Strict I/O Separation**
  - **Invariant:** Every test in `engine/tests/` must run 100% offline with mocked HTTP/subprocess calls (`respx` or `monkeypatch`). Stage modules in `engine/factory_engine/stages/` must accept explicit `target_dir` and `factory_dir` paths and must never mutate files outside `target_dir`.
  - **Why:** Live network calls make `engine-ci.yml` flaky and leak secrets; unguarded path writes can corrupt the sibling `factory/` checkout or commit factory files into target repos.
  - **Safe path:** Tests using `tmp_path`, `respx.mock`, and mocked `GitHubClient`/`LLMClient` instances.

- **[P1] Reasoning-Model Parsing, Timeouts & Failover Semantics**
  - **Invariant:** Every LLM adapter in `engine/factory_engine/llm/` and `src/lib/` must enforce explicit per-request and overall timeouts, strip reasoning blocks (`part.get("thought")` for Gemini and `<think>...</think>` + markdown fences before JSON parsing), fail over immediately on fatal HTTP codes (`400`, `401`, `403`, `404`, `410`) or empty content, and retry only bounded transient failures (`429`, `5xx`, timeouts).
  - **Why:** Free-tier hosted models (e.g., Gemini thinking models, NVIDIA NIM GLM/MiniMax) emit reasoning tokens or stall intermittently; missing timeouts hang GitHub Actions runners or Vercel Hobby functions.
  - **Safe path:** Configured `RouteConfig` timeouts bounded by `global_timeout_sec` (Python) or `AbortController` timeouts cleaned up in `finally` (Next.js).

- **[P1] Language-Agnostic Engine Defaults & Protected-Path Enforcement**
  - **Invariant:** `FactoryConfig` defaults in `engine/factory_engine/config.py` must remain language-agnostic (`archetype="general"`, optional `deploy_lane`/`health_path`/`test_command`) and protect `.github/workflows/**` by default.
  - **Why:** Target repositories span Java, Next.js, and Python; Java-specific defaults break non-Java repos and self-hosting of `ankul01/agent-factory`.
  - **Safe path:** Target-specific overrides declared inside each target repo's `.agent-factory.yml` or passed via workflow inputs.

### Reusable GitHub Actions Workflows (`.github/workflows/`)

- **[P0] Prevent Shell Injection & Secret Leakage in Workflow `run:` Steps**
  - **Invariant:** Never interpolate untrusted GitHub contexts (`github.event.comment.body`, `github.event.pull_request.title`, `github.head_ref`, `inputs.*`) directly inside `run:` shell scripts. Bind them through step `env:` variables and double-quote `"$VAR"` in bash. Never print secrets or pass secret URLs in ways that expose credentials on failure.
  - **Why:** Direct `${{ ... }}` interpolation in bash enables arbitrary command execution from PR titles or issue comments on public repos.
  - **Safe path:** Mapping `${{ inputs.* }}` or `${{ github.event.* }}` into `env:` and passing them as quoted arguments or `jq --arg` values.

- **[P0] Sibling Dual-Checkout Hygiene & Reusable Workflow Contracts**
  - **Invariant:** Centralized `reusable-*.yml` workflows invoking `engine/` must check out the caller repo to `path: target` and sparse-checkout `ankul01/agent-factory` (`engine`, `skills`, and `.agent-factory/prompts` when present) to `path: factory`, executing `uv run --project ../factory/engine` with `working-directory: target`. Do not break existing `workflow_call` input/secret names or make Day-1 bootstrap inputs (`staging_url`, `RENDER_DEPLOY_HOOK_URL`) strictly `required: true`.
  - **Why:** Checking out factory files inside `target/` risks committing engine files into target repos; breaking `workflow_call` signatures or bootstrap optionality breaks all downstream target callers simultaneously.
  - **Safe path:** Adding new optional `workflow_call` inputs with safe defaults while preserving existing input names and explicit least-privilege `permissions:`.

- **[P1] Valid URL Construction, Early-Fail Metadata & `uv` Cache Globs**
  - **Invariant:** Workflow steps that construct URLs from inputs must strip trailing/leading slashes before concatenation (preventing `//` 400s in Spring Boot). Metadata steps needed by `if: always()` notification steps must execute before fail-fast guards. `astral-sh/setup-uv` in this repo must set `cache-dependency-glob` pointing into `engine/` (e.g., `"engine/pyproject.toml"` or `"engine/uv.lock"`).
  - **Why:** `defaults.run.working-directory` does not apply to `uses:` actions, and uninitialized step outputs break `if: always()` webhook payloads.
  - **Safe path:** Normalizing paths with `${BASE%/}/${PATH#/}` in bash and computing run/image metadata as the first step after checkout.

### Next.js Control Plane & $0 Free-Tier Constraints

- **[P1] Vercel Serverless File Tracing & Safe UI Rendering**
  - **Invariant:** Any Next.js route reading repository files from disk (e.g., `skills/**`, or `.agent-factory/prompts/**` when present) must declare them in `next.config.*` `outputFileTracingIncludes` and resolve paths via `process.cwd()`. UI components rendering agent-generated text, PR comments, or staging URLs must avoid `dangerouslySetInnerHTML`, validate URL schemes (`http:`/`https:`), and gracefully handle `null` Phase 2 fields on legacy v1.1 database rows.
  - **Why:** Vercel's serverless bundler strips untraced Markdown files at runtime, causing production `ENOENT` crashes; unvalidated markdown/URLs introduce XSS and break older dashboard records.
  - **Safe path:** Plain React text rendering or sanitized markdown components, `rel="noopener noreferrer"` on external links, and nullish fallbacks (`?? "—"`) for optional deployment fields.
