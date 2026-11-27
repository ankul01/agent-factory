"""Draft plan generation stage (`factory-engine plan`)."""

from __future__ import annotations

import datetime
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from factory_engine.config import FactoryConfig, load_config
from factory_engine.github.api import GitHubClient
from factory_engine.github.callback import CallbackPayload, post_workflow_callback
from factory_engine.llm.client import LLMClient, strip_code_fences
from factory_engine.prompts.loader import load_prompts

_BOT_NAME = "github-actions[bot]"
_BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"

_DEFAULT_PLANNER_SYSTEM_PROMPT = """You are a software planning assistant.

Produce a concise plan for the requirement below. Include:
1. Clarifying questions and assumptions
2. Scope and non-goals
3. Testable acceptance criteria
4. Proposed implementation steps
5. Test cases, risks, and a rollback approach

Do not claim to have inspected a repository.
Do not write or execute code."""

_DEDICATED_QUESTIONS_HEADING_RE = re.compile(
    r"^(#{1,6})\s*(?:\d+\.\s*)?(?:Clarifying Questions|Open Questions)"
    r"(?!\s+and\s+Assumptions)\b.*$",
    re.IGNORECASE | re.MULTILINE,
)
_COMBINED_QUESTIONS_HEADING_RE = re.compile(
    r"^(#{1,6})\s*(?:\d+\.\s*)?Clarifying Questions\s+and\s+Assumptions\b.*$",
    re.IGNORECASE | re.MULTILINE,
)
_LIST_ITEM_RE = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+(.+)$")
_NONE_ITEM_RE = re.compile(r"^(?:none|n/?a|no\s+(?:open\s+)?questions?)\.?$", re.IGNORECASE)


@dataclass(frozen=True)
class PlanResult:
    """Outcome of executing the `planner` stage."""

    plan_id: str
    slug: str
    plan_path: str
    branch_name: str
    pr_number: int | None
    pr_url: str | None
    open_questions_count: int
    model_used: str
    route_name: str


def sanitize_slug(raw_slug: str | None, requirement: str) -> str:
    """Build a safe, ASCII-only kebab-case slug (<= 40 chars)."""
    source = (raw_slug or "").strip()
    if not source:
        source = " ".join(requirement.split()[:5])
    slug = re.sub(r"[^a-z0-9]+", "-", source.lower()).strip("-")[:40].strip("-")
    return slug or "plan"


def resolve_plan_path(target_dir: Path, plan_dir: str, plan_id: str) -> tuple[Path, str]:
    """Resolve `<plan_dir>/<plan_id>.md` safely inside `target_dir`."""
    if not re.fullmatch(r"[A-Za-z0-9._-]+", plan_id):
        raise ValueError(f"Unsafe plan_id: {plan_id!r}")
    clean_dir = plan_dir.strip("/") or "docs/plans"
    rel_path = f"{clean_dir}/{plan_id}.md"
    target_root = target_dir.resolve()
    full_path = (target_root / rel_path).resolve()
    if not full_path.is_relative_to(target_root):
        raise ValueError(f"Plan path escapes target_dir: {rel_path}")
    return full_path, rel_path


def count_open_questions(plan_markdown: str) -> int:
    """
    Count items strictly inside an anchored Clarifying/Open Questions heading.

    Prefers a dedicated `Clarifying Questions` / `Open Questions` heading over
    a combined `Clarifying Questions and Assumptions` heading, and stops only at
    a heading of equal or higher level. Prose mentioning 'question' outside that
    section is ignored.
    """
    heading_match = (
        _DEDICATED_QUESTIONS_HEADING_RE.search(plan_markdown)
        or _COMBINED_QUESTIONS_HEADING_RE.search(plan_markdown)
    )
    if not heading_match:
        return 0

    level = len(heading_match.group(1))
    section_start = heading_match.end()
    stop_re = re.compile(rf"^#{{1,{level}}}\s+\S", re.MULTILINE)
    next_heading = stop_re.search(plan_markdown, section_start)
    section = (
        plan_markdown[section_start:next_heading.start()]
        if next_heading
        else plan_markdown[section_start:]
    )

    count = 0
    for line in section.splitlines():
        item_match = _LIST_ITEM_RE.match(line)
        if not item_match:
            continue
        item_text = item_match.group(1).strip()
        if item_text and not _NONE_ITEM_RE.match(item_text):
            count += 1
    return count


def build_planner_prompts(
    requirement: str,
    config: FactoryConfig,
    factory_dir: Path,
) -> tuple[str, str]:
    """Construct `(system_prompt, user_prompt)` using skill + `"planner"` stage prompt."""
    bundle = load_prompts(factory_dir, config.archetype, "planner")
    system_prompt = bundle.stage_prompt or _DEFAULT_PLANNER_SYSTEM_PROMPT
    if bundle.archetype_skill:
        system_prompt = (
            f"{system_prompt}\n\n"
            f"### Archetype Guidelines ({config.archetype})\n"
            f"{bundle.archetype_skill}"
        )
    user_prompt = f"Requirement:\n{requirement.strip()}\n"
    return system_prompt, user_prompt


def assemble_plan_document(
    plan_id: str,
    created_at: str,
    model: str,
    route_name: str,
    run_url: str,
    requirement: str,
    plan_body: str,
) -> str:
    """Assemble the Markdown draft plan with YAML frontmatter."""
    safe_req = json.dumps(requirement)
    return (
        f"---\n"
        f"plan_id: {plan_id}\n"
        f"status: draft\n"
        f"created_at: {created_at}\n"
        f"model: {model}\n"
        f"route_name: {route_name}\n"
        f"workflow_run_url: {run_url}\n"
        f"requirement: {safe_req}\n"
        f"---\n\n"
        f"# Draft Plan: {plan_id}\n\n"
        f"> **Human Review Required:** Merging this Pull Request to the default branch "
        f"marks this exact file and commit SHA as approved for implementation.\n\n"
        f"{plan_body.strip()}\n"
    )


def format_plan_pr_body(
    plan_id: str,
    plan_path: str,
    model: str,
    route_name: str,
    run_url: str,
) -> str:
    """Format the pull request body for a draft plan PR."""
    return (
        f"## Draft Plan Ready for Review\n\n"
        f"- **Plan ID:** `{plan_id}`\n"
        f"- **File:** `{plan_path}`\n"
        f"- **Model:** `{model}` (route: `{route_name}`)\n"
        f"- **Workflow Run:** {run_url}\n\n"
        f"### Approval Rule\n"
        f"Review the Markdown file in the **Files changed** tab. "
        f"Edit directly on this branch if needed. "
        f"Click **Merge pull request** only when you approve this exact version "
        f"for Phase 2 implementation.\n"
    )


def _run_git(args: list[str], cwd: Path) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        text=True,
        capture_output=True,
    )
    return proc.stdout.strip()


def run_plan(
    target_dir: Path,
    factory_dir: Path,
    requirement: str,
    raw_slug: str = "",
    requirement_id: str | None = None,
    model_override: str | None = None,
    run_url: str = "",
    gh_run_id: str | None = None,
    base_branch: str = "main",
    github_client: GitHubClient | None = None,
    llm_client: LLMClient | None = None,
    dry_run: bool = False,
) -> PlanResult:
    """Execute the `planner` stage: generate draft plan, commit to branch, open PR."""
    req_text = requirement.strip()
    if not req_text:
        raise ValueError("Requirement input is empty.")

    target_path = Path(target_dir).resolve()
    factory_path = Path(factory_dir).resolve()
    config = load_config(target_path)

    slug = sanitize_slug(raw_slug, req_text)
    now_utc = datetime.datetime.now(datetime.UTC)
    timestamp = now_utc.strftime("%Y%m%d-%H%M%S")
    created_at = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
    plan_id = f"{timestamp}-{slug}"
    branch_name = f"plan/{plan_id}"
    full_plan_path, rel_plan_path = resolve_plan_path(target_path, config.plan_dir, plan_id)

    gh = github_client or GitHubClient()
    llm = llm_client or LLMClient()

    system_prompt, user_prompt = build_planner_prompts(
        requirement=req_text,
        config=config,
        factory_dir=factory_path,
    )

    try:
        response = llm.generate(
            profile="planner",
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            model_override=model_override or None,
        )
    except Exception as exc:
        if not dry_run:
            _send_plan_callback(
                gh=gh,
                slug=slug,
                status="FAILED",
                requirement_id=requirement_id,
                gh_run_id=gh_run_id,
                gh_run_url=run_url or None,
                plan_path=rel_plan_path,
                branch_name=branch_name,
                failure_reason=str(exc)[:500],
            )
        raise

    plan_body = strip_code_fences(response.text)
    open_questions = count_open_questions(plan_body)
    document = assemble_plan_document(
        plan_id=plan_id,
        created_at=created_at,
        model=response.model,
        route_name=response.route_name,
        run_url=run_url,
        requirement=req_text,
        plan_body=plan_body,
    )

    full_plan_path.parent.mkdir(parents=True, exist_ok=True)
    full_plan_path.write_text(document, encoding="utf-8")

    pr_number: int | None = None
    pr_url: str | None = None

    if not dry_run:
        _run_git(["config", "user.name", _BOT_NAME], cwd=target_path)
        _run_git(["config", "user.email", _BOT_EMAIL], cwd=target_path)
        _run_git(["checkout", "-b", branch_name], cwd=target_path)
        _run_git(["add", rel_plan_path], cwd=target_path)
        _run_git(["commit", "-m", f"plan: add draft spec {plan_id}"], cwd=target_path)
        _run_git(["push", "origin", branch_name], cwd=target_path)

        pr_body = format_plan_pr_body(
            plan_id=plan_id,
            plan_path=rel_plan_path,
            model=response.model,
            route_name=response.route_name,
            run_url=run_url,
        )
        created_pr = gh.create_pull_request(
            title=f"Plan: {plan_id}",
            body=pr_body,
            head=branch_name,
            base=base_branch,
        )
        pr_number = created_pr.get("number")
        pr_url = created_pr.get("html_url")

        _send_plan_callback(
            gh=gh,
            slug=slug,
            status="PR_OPEN",
            requirement_id=requirement_id,
            gh_run_id=gh_run_id,
            gh_run_url=run_url or None,
            plan_path=rel_plan_path,
            branch_name=branch_name,
            pr_number=pr_number,
            pr_url=pr_url,
            open_questions_count=open_questions,
            model_used=response.model,
        )

    return PlanResult(
        plan_id=plan_id,
        slug=slug,
        plan_path=rel_plan_path,
        branch_name=branch_name,
        pr_number=pr_number,
        pr_url=pr_url,
        open_questions_count=open_questions,
        model_used=response.model,
        route_name=response.route_name,
    )


def _send_plan_callback(
    gh: GitHubClient,
    slug: str,
    status: str,
    requirement_id: str | None = None,
    gh_run_id: str | None = None,
    gh_run_url: str | None = None,
    plan_path: str | None = None,
    branch_name: str | None = None,
    pr_number: int | None = None,
    pr_url: str | None = None,
    open_questions_count: int | None = None,
    model_used: str | None = None,
    failure_reason: str | None = None,
) -> None:
    if "/" not in gh.repo:
        return
    owner, repo_name = gh.repo.split("/", 1)
    payload = CallbackPayload(
        repoOwner=owner,
        repoName=repo_name,
        slug=slug[:40],
        requirementId=requirement_id or None,
        stage="plan",
        status=status,
        ghRunId=gh_run_id,
        ghRunUrl=gh_run_url,
        planPath=plan_path,
        branchName=branch_name,
        prNumber=pr_number,
        prUrl=pr_url,
        openQuestionsCount=open_questions_count,
        modelUsed=model_used,
        failureReason=failure_reason,
    )
    try:
        post_workflow_callback(payload)
    except Exception as exc:  # noqa: BLE001
        print(f"[planner] Warning: callback failed: {exc}")
