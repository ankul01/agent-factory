"""Automated PR code review stage (`factory-engine review`)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from factory_engine.config import FactoryConfig, load_config
from factory_engine.github.api import GitHubClient
from factory_engine.github.callback import CallbackPayload, post_workflow_callback
from factory_engine.llm.client import LLMClient, LLMError
from factory_engine.prompts.loader import load_prompts
from factory_engine.stages.planner_revise import extract_slug_from_plan_id

ReviewVerdict = Literal["PENDING", "APPROVED", "CHANGES_REQUESTED"]
TestStatus = Literal["PENDING", "PASSED", "FAILED"]

MAX_DIFF_CHARS = 100_000

_DEFAULT_REVIEW_SYSTEM_PROMPT = """You are a senior software engineer code reviewer for an \
automated software factory.
Review the PR diff against the approved plan (if provided).
Provide a balanced, thorough, and constructive review.

Always include positive feedback highlighting what was done well (architecture, clean code, \
best practices, test coverage, validation, etc.).
Even if all things look fine and there are no blocking issues, always provide detailed positive \
review comments and appreciation for what is well implemented.
Tag any critical blocking issues with `[P0]` and important non-blocking issues with `[P1]`.

Format your output strictly in this Markdown structure:

## Automated Code Review Summary
- **Approved Plan Checked:** <path or "None referenced">
- **Verdict:** `APPROVED` or `CHANGES_REQUESTED`

### What Looks Good (Key Strengths)
- <Detail what is implemented well: architecture, annotations, validation, test coverage, etc.>
- <Concrete praise referencing specific files and classes in the diff>

### Minor Feedback & Suggestions (Optional / Non-Blocking)
- <Constructive suggestions, code style tips, future improvements, or "None">

### Blocking Issues (Must Fix Before Merge)
- <Only list critical bugs or violated requirements. Else write "None - ready to merge.">"""


@dataclass(frozen=True)
class ReviewMetrics:
    """Parsed verdict and severity counts from a review comment."""

    verdict: ReviewVerdict
    p0_count: int
    p1_count: int


@dataclass(frozen=True)
class PRReviewResult:
    """Outcome of executing the `pr_review` stage."""

    pr_number: int
    has_diff: bool
    comment_body: str
    comment_url: str | None
    verdict: ReviewVerdict
    p0_count: int
    p1_count: int
    model_used: str | None
    route_name: str | None
    plan_path: str | None


def extract_plan_reference(
    pr_body: str | None,
    target_dir: Path,
    plan_dir: str = "docs/plans",
) -> tuple[str | None, str]:
    """Find an approved plan file referenced in `pr_body` and load its contents."""
    if not pr_body:
        return None, "No approved plan file referenced in PR body."

    clean_dir = plan_dir.strip("/")
    pattern = re.compile(rf"({re.escape(clean_dir)}/[A-Za-z0-9._-]+\.md)")
    match = pattern.search(pr_body)
    if not match:
        return None, "No approved plan file referenced in PR body."

    rel_path = match.group(1)
    plan_file = (target_dir / rel_path).resolve()
    target_root = target_dir.resolve()
    if not plan_file.is_relative_to(target_root) or not plan_file.is_file():
        return None, "No approved plan file referenced in PR body."

    content = plan_file.read_text(encoding="utf-8")
    return rel_path, f"Approved Plan ({rel_path}):\n\n{content}"


def truncate_diff(diff_text: str, max_chars: int = MAX_DIFF_CHARS) -> str:
    """Keep diff within a safe size for single-pass LLM review."""
    if len(diff_text) > max_chars:
        return diff_text[:max_chars] + "\n\n... [DIFF TRUNCATED]"
    return diff_text


def extract_review_metrics(comment_body: str) -> ReviewMetrics:
    """Extract verdict and `[P0]`/`[P1]` counts matching orchestrator webhook rules."""
    verdict: ReviewVerdict = "PENDING"
    explicit = re.search(
        r"Verdict:\**\s*`?(CHANGES_REQUESTED|APPROVED)`?",
        comment_body,
        re.IGNORECASE,
    )
    if explicit:
        matched_verdict = explicit.group(1).upper()
        verdict = "CHANGES_REQUESTED" if matched_verdict == "CHANGES_REQUESTED" else "APPROVED"
    elif re.search(r"\bCHANGES_REQUESTED\b", comment_body, re.IGNORECASE):
        verdict = "CHANGES_REQUESTED"
    elif re.search(r"\bAPPROVED\b", comment_body, re.IGNORECASE):
        verdict = "APPROVED"

    p0_count = len(re.findall(r"\[P0\]", comment_body, re.IGNORECASE))
    p1_count = len(re.findall(r"\[P1\]", comment_body, re.IGNORECASE))
    return ReviewMetrics(verdict=verdict, p0_count=p0_count, p1_count=p1_count)


def build_review_prompts(
    diff_text: str,
    plan_context: str,
    config: FactoryConfig,
    factory_dir: Path,
) -> tuple[str, str]:
    """Construct `(system_prompt, user_prompt)` for PR code review."""
    bundle = load_prompts(factory_dir, config.archetype, "reviewer")
    system_prompt = bundle.stage_prompt or _DEFAULT_REVIEW_SYSTEM_PROMPT
    if bundle.archetype_skill:
        system_prompt = (
            f"{system_prompt}\n\n"
            f"### Archetype Guidelines ({config.archetype})\n"
            f"{bundle.archetype_skill}"
        )

    truncated = truncate_diff(diff_text)
    user_prompt = (
        f"{plan_context}\n\n"
        f"---\n"
        f"### Pull Request Diff\n"
        f"```diff\n"
        f"{truncated}\n"
        f"```"
    )
    return system_prompt, user_prompt


def format_review_comment(
    review_text: str | None,
    model: str | None,
    route_name: str | None,
    run_url: str,
    test_status: TestStatus = "PASSED",
) -> str:
    """Format the final PR review comment or fallback service-unavailable notice."""
    if review_text and review_text.strip():
        return (
            f"{review_text.strip()}\n\n"
            f"---\n"
            f"*Model: `{model}` · Route: `{route_name}` · [Workflow Run]({run_url})*\n"
        )

    status_sentence = (
        "All automated test suites passed."
        if test_status == "PASSED"
        else f"Automated test suite status: `{test_status}`."
    )
    return (
        "## Automated Code Review Notice\n\n"
        "> **Notice:** Automated code review could not be generated "
        f"due to temporary AI service unavailability. {status_sentence}\n\n"
        f"---\n*[Workflow Run]({run_url})*\n"
    )


def _normalize_test_status(raw: str | None) -> TestStatus:
    upper = (raw or "PASSED").strip().upper()
    if upper in ("PASSED", "SUCCESS"):
        return "PASSED"
    if upper in ("FAILED", "FAILURE"):
        return "FAILED"
    return "PENDING"


def run_pr_review(
    target_dir: Path,
    factory_dir: Path,
    pr_number: int,
    pr_body: str = "",
    run_url: str = "",
    test_status: str | None = None,
    model_override: str | None = None,
    head_ref: str = "",
    gh_run_id: str | None = None,
    github_client: GitHubClient | None = None,
    llm_client: LLMClient | None = None,
    dry_run: bool = False,
) -> PRReviewResult:
    """Execute the automated PR review stage for `pr_number`."""
    target_path = Path(target_dir).resolve()
    factory_path = Path(factory_dir).resolve()
    config = load_config(target_path)

    gh = github_client or GitHubClient()
    llm = llm_client or LLMClient()
    normalized_test_status = _normalize_test_status(test_status)

    diff_text = gh.get_pr_diff(pr_number)
    if not diff_text.strip():
        return PRReviewResult(
            pr_number=pr_number,
            has_diff=False,
            comment_body="",
            comment_url=None,
            verdict="PENDING",
            p0_count=0,
            p1_count=0,
            model_used=None,
            route_name=None,
            plan_path=None,
        )

    if not pr_body and gh.repo:
        try:
            pr_meta = gh.get_pull_request(pr_number)
            pr_body = pr_meta.get("body") or ""
        except Exception:  # noqa: BLE001
            pr_body = ""

    plan_path, plan_context = extract_plan_reference(
        pr_body=pr_body,
        target_dir=target_path,
        plan_dir=config.plan_dir,
    )
    system_prompt, user_prompt = build_review_prompts(
        diff_text=diff_text,
        plan_context=plan_context,
        config=config,
        factory_dir=factory_path,
    )

    review_text: str | None = None
    model_used: str | None = None
    route_name: str | None = None

    try:
        response = llm.generate(
            profile="reviewer",
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            model_override=model_override or None,
        )
        review_text = response.text
        model_used = response.model
        route_name = response.route_name
    except LLMError as exc:
        print(f"[pr-review] LLM waterfall failed; posting fallback notice: {exc}")

    effective_run_url = run_url or _default_run_url()
    is_truncated = len(diff_text) > MAX_DIFF_CHARS
    comment_body = format_review_comment(
        review_text=review_text,
        model=model_used,
        route_name=route_name,
        run_url=effective_run_url,
        test_status=normalized_test_status,
    )
    metrics = (
        extract_review_metrics(comment_body)
        if review_text
        else ReviewMetrics(verdict="PENDING", p0_count=0, p1_count=0)
    )
    if is_truncated and metrics.verdict == "APPROVED":
        metrics = ReviewMetrics(
            verdict="PENDING",
            p0_count=metrics.p0_count,
            p1_count=metrics.p1_count,
        )
        warning_note = (
            "> **Warning:** PR diff exceeded 100,000 characters and was truncated; "
            "automated approval has been downgraded to `PENDING` for human review.\n\n"
        )
        comment_body = warning_note + comment_body

    comment_url: str | None = None
    if not dry_run:
        created = gh.comment_on_pr(pr_number, comment_body)
        comment_url = created.get("html_url")
        _send_review_callback(
            gh=gh,
            pr_number=pr_number,
            run_url=effective_run_url,
            test_status=normalized_test_status,
            metrics=metrics,
            model_used=model_used,
            comment_url=comment_url,
            head_ref=head_ref,
            gh_run_id=gh_run_id,
        )

    return PRReviewResult(
        pr_number=pr_number,
        has_diff=True,
        comment_body=comment_body,
        comment_url=comment_url,
        verdict=metrics.verdict,
        p0_count=metrics.p0_count,
        p1_count=metrics.p1_count,
        model_used=model_used,
        route_name=route_name,
        plan_path=plan_path,
    )


def _default_run_url() -> str:
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    if repo and run_id:
        return f"{server}/{repo}/actions/runs/{run_id}"
    return server


def _send_review_callback(
    gh: GitHubClient,
    pr_number: int,
    run_url: str,
    test_status: TestStatus,
    metrics: ReviewMetrics,
    model_used: str | None,
    comment_url: str | None,
    head_ref: str = "",
    gh_run_id: str | None = None,
) -> None:
    if "/" not in gh.repo:
        return
    owner, repo_name = gh.repo.split("/", 1)
    raw_tail = head_ref.split("/", 1)[-1]
    slug = extract_slug_from_plan_id(raw_tail) if raw_tail else f"pr-{pr_number}"
    payload = CallbackPayload(
        repoOwner=owner,
        repoName=repo_name,
        slug=slug[:40],
        stage="review",
        status="FAILED" if test_status == "FAILED" else "IN_REVIEW",
        prNumber=pr_number,
        ghRunId=gh_run_id,
        ghRunUrl=run_url or None,
        testStatus=test_status,
        verdict=metrics.verdict,
        p0Count=metrics.p0_count,
        p1Count=metrics.p1_count,
        commentUrl=comment_url,
        modelUsed=model_used,
    )
    try:
        post_workflow_callback(payload)
    except Exception as exc:  # noqa: BLE001
        print(f"[pr-review] Warning: callback failed: {exc}")
