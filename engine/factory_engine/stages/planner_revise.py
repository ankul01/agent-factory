"""Plan revision stage (`factory-engine revise`)."""

from __future__ import annotations

import datetime
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from factory_engine.config import FactoryConfig, load_config
from factory_engine.github.api import GitHubClient
from factory_engine.github.callback import CallbackPayload, post_workflow_callback
from factory_engine.llm.client import LLMClient, strip_code_fences
from factory_engine.prompts.loader import load_prompts
from factory_engine.stages.planner import count_open_questions, resolve_plan_path

_BOT_NAME = "github-actions[bot]"
_BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"

_DEFAULT_REVISE_SYSTEM_PROMPT = """You are a software planning assistant.
A user has requested revisions on an existing draft software plan.
Revise the plan by applying the feedback thoroughly while keeping existing decisions that are \
still valid.

Instructions:
1. Return the COMPLETE revised Markdown document.
2. Preserve the YAML frontmatter at the very top (`---`), keeping existing fields (plan_id, \
status: draft, created_at, model, route_name, workflow_run_url, requirement).
3. Add or update the frontmatter field revised_at with the timestamp provided in the user message.
4. Keep the human review header right below the frontmatter.
5. Do not claim to have inspected a repository.
6. Do not write or execute code.
7. Output only the revised markdown text. Do not wrap the entire response in triple backticks."""


@dataclass(frozen=True)
class ReviseResult:
    """Outcome of executing the `planner_revise` stage."""

    plan_id: str
    slug: str
    plan_path: str
    branch_name: str
    pr_number: int
    commit_sha: str | None
    comment_url: str | None
    open_questions_count: int
    model_used: str
    route_name: str


def extract_revise_feedback(comment_body: str) -> str:
    """Extract non-empty feedback following `/revise`."""
    feedback = comment_body.strip()
    if feedback.startswith("/revise"):
        feedback = feedback[len("/revise"):].strip()
    if not feedback:
        raise ValueError("Feedback following /revise is empty.")
    return feedback


def extract_slug_from_plan_id(plan_id: str) -> str:
    """Strip optional `YYYYMMDD-HHMMSS-` prefix from `plan_id` to recover slug."""
    match = re.match(r"^\d{8}-\d{6}-(.+)$", plan_id)
    raw = match.group(1) if match else plan_id
    return raw[:40]


def build_revise_prompts(
    current_plan: str,
    feedback: str,
    revised_at: str,
    config: FactoryConfig,
    factory_dir: Path,
) -> tuple[str, str]:
    """Construct `(system_prompt, user_prompt)` for revising an existing plan."""
    bundle = load_prompts(factory_dir, config.archetype, "planner-revise")
    system_prompt = bundle.stage_prompt or _DEFAULT_REVISE_SYSTEM_PROMPT
    if bundle.archetype_skill:
        system_prompt = (
            f"{system_prompt}\n\n"
            f"### Archetype Guidelines ({config.archetype})\n"
            f"{bundle.archetype_skill}"
        )
    user_prompt = (
        f'revised_at: "{revised_at}"\n\n'
        f"Existing Plan Document:\n"
        f"{current_plan}\n\n"
        f"User Feedback:\n"
        f"{feedback}\n"
    )
    return system_prompt, user_prompt


def format_revise_reply(
    plan_path: str,
    model: str,
    route_name: str,
    commit_sha: str,
    run_url: str,
    changed: bool = True,
) -> str:
    """Format the PR comment reply after processing a plan revision."""
    summary_line = (
        "The draft plan has been updated per your `/revise` comment."
        if changed
        else "Evaluated your `/revise` comment; no file changes were needed."
    )
    return (
        f"## Plan Revised from Feedback\n\n"
        f"{summary_line}\n\n"
        f"- **File:** `{plan_path}`\n"
        f"- **Model:** `{model}` (route: `{route_name}`)\n"
        f"- **Commit:** `{commit_sha}`\n"
        f"- **Workflow Run:** {run_url}\n\n"
        f"Review the updated Markdown document in the **Files changed** tab.\n"
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


def run_revise(
    target_dir: Path,
    factory_dir: Path,
    pr_number: int,
    head_ref: str,
    comment_body: str,
    requirement_id: str | None = None,
    model_override: str | None = None,
    run_url: str = "",
    gh_run_id: str | None = None,
    github_client: GitHubClient | None = None,
    llm_client: LLMClient | None = None,
    dry_run: bool = False,
) -> ReviseResult:
    """Execute the `planner_revise` stage on an open `plan/*` PR."""
    if not head_ref.startswith("plan/"):
        raise ValueError(f"PR headRefName '{head_ref}' does not start with 'plan/'.")

    plan_id = head_ref.removeprefix("plan/")
    slug = extract_slug_from_plan_id(plan_id)
    feedback = extract_revise_feedback(comment_body)

    target_path = Path(target_dir).resolve()
    factory_path = Path(factory_dir).resolve()
    config = load_config(target_path)
    full_plan_path, rel_plan_path = resolve_plan_path(target_path, config.plan_dir, plan_id)

    if not full_plan_path.is_file():
        raise FileNotFoundError(f"Plan file not found: {rel_plan_path}")

    current_plan = full_plan_path.read_text(encoding="utf-8")
    revised_at = datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    gh = github_client or GitHubClient()
    llm = llm_client or LLMClient()

    system_prompt, user_prompt = build_revise_prompts(
        current_plan=current_plan,
        feedback=feedback,
        revised_at=revised_at,
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
            _send_revise_callback(
                gh=gh,
                slug=slug,
                status="FAILED",
                requirement_id=requirement_id,
                gh_run_id=gh_run_id,
                gh_run_url=run_url or None,
                plan_path=rel_plan_path,
                branch_name=head_ref,
                pr_number=pr_number,
                failure_reason=str(exc)[:500],
            )
        raise

    revised_text = strip_code_fences(response.text)
    open_questions = count_open_questions(revised_text)
    full_plan_path.write_text(revised_text + "\n", encoding="utf-8")

    commit_sha: str | None = None
    comment_url: str | None = None

    if not dry_run:
        _run_git(["config", "user.name", _BOT_NAME], cwd=target_path)
        _run_git(["config", "user.email", _BOT_EMAIL], cwd=target_path)
        _run_git(["add", "--", rel_plan_path], cwd=target_path)
        diff_check = subprocess.run(
            ["git", "diff", "--cached", "--quiet", "--", rel_plan_path],
            cwd=target_path,
            check=False,
        )
        has_changes = diff_check.returncode != 0
        if has_changes:
            _run_git(
                [
                    "commit",
                    "--only",
                    rel_plan_path,
                    "-m",
                    f"plan: revise {plan_id} from PR feedback",
                ],
                cwd=target_path,
            )
            _run_git(["push", "origin", f"HEAD:{head_ref}"], cwd=target_path)
        commit_sha = _run_git(["rev-parse", "--short", "HEAD"], cwd=target_path)

        reply_body = format_revise_reply(
            plan_path=rel_plan_path,
            model=response.model,
            route_name=response.route_name,
            commit_sha=commit_sha,
            run_url=run_url,
            changed=has_changes,
        )
        created_comment = gh.comment_on_pr(pr_number, reply_body)
        comment_url = created_comment.get("html_url")

        _send_revise_callback(
            gh=gh,
            slug=slug,
            status="PR_OPEN",
            requirement_id=requirement_id,
            gh_run_id=gh_run_id,
            gh_run_url=run_url or None,
            plan_path=rel_plan_path,
            branch_name=head_ref,
            pr_number=pr_number,
            open_questions_count=open_questions,
            model_used=response.model,
        )

    return ReviseResult(
        plan_id=plan_id,
        slug=slug,
        plan_path=rel_plan_path,
        branch_name=head_ref,
        pr_number=pr_number,
        commit_sha=commit_sha,
        comment_url=comment_url,
        open_questions_count=open_questions,
        model_used=response.model,
        route_name=response.route_name,
    )


def _send_revise_callback(
    gh: GitHubClient,
    slug: str,
    status: str,
    requirement_id: str | None = None,
    gh_run_id: str | None = None,
    gh_run_url: str | None = None,
    plan_path: str | None = None,
    branch_name: str | None = None,
    pr_number: int | None = None,
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
        openQuestionsCount=open_questions_count,
        modelUsed=model_used,
        failureReason=failure_reason,
    )
    try:
        post_workflow_callback(payload)
    except Exception as exc:  # noqa: BLE001
        print(f"[planner-revise] Warning: callback failed: {exc}")
