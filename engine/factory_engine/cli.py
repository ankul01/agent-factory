"""CLI entrypoint for factory-engine."""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from factory_engine.stages.planner import run_plan
from factory_engine.stages.planner_revise import run_revise
from factory_engine.stages.pr_review import run_pr_review
from factory_engine.stages.trigger_coder import run_trigger_coder


def _add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--target-dir",
        type=Path,
        default=Path("."),
        help="Path to the target repository directory (default: current directory).",
    )
    parser.add_argument(
        "--factory-dir",
        type=Path,
        default=Path("."),
        help="Path to the agent-factory repository directory (default: current directory).",
    )


def build_parser() -> argparse.ArgumentParser:
    """Construct the top-level argument parser."""
    parser = argparse.ArgumentParser(
        prog="factory-engine",
        description="Agent Factory workflow execution engine.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name, help_text in (
        ("plan", "Generate a draft implementation plan PR."),
        ("revise", "Revise an existing draft plan from PR feedback."),
        ("trigger-coder", "Trigger coding agent on an approved plan."),
        ("review", "Run automated AI code review on a pull request."),
    ):
        sub = subparsers.add_parser(name, help=help_text)
        _add_common_args(sub)
        if name == "plan":
            sub.add_argument(
                "--requirement",
                default=None,
                help="Requirement text (defaults to REQUIREMENT or PROMPT_TEXT env var).",
            )
            sub.add_argument(
                "--slug",
                default=None,
                help="Optional short slug (defaults to RAW_SLUG env var).",
            )
            sub.add_argument(
                "--requirement-id",
                default=None,
                help="Optional orchestrator requirement UUID (defaults to REQUIREMENT_ID).",
            )
            sub.add_argument(
                "--model-override",
                default=None,
                help="Optional LLM model override (defaults to MODEL_OVERRIDE).",
            )
            sub.add_argument(
                "--run-url",
                default="",
                help="Workflow run URL (defaults to RUN_URL).",
            )
            sub.add_argument(
                "--base-branch",
                default=None,
                help="Base branch for the plan PR (defaults to BASE_BRANCH or 'main').",
            )
            sub.add_argument(
                "--dry-run",
                action="store_true",
                help="Generate plan file locally without git push, PR creation, or callback.",
            )
        elif name == "revise":
            sub.add_argument(
                "--pr-number",
                type=int,
                default=None,
                help="Pull request number (defaults to PR_NUMBER env var).",
            )
            sub.add_argument(
                "--head-ref",
                default=None,
                help="PR head branch name (defaults to HEAD_REF env var).",
            )
            sub.add_argument(
                "--comment-body",
                default=None,
                help="PR comment body containing /revise feedback (defaults to COMMENT_BODY).",
            )
            sub.add_argument(
                "--requirement-id",
                default=None,
                help="Optional orchestrator requirement UUID (defaults to REQUIREMENT_ID).",
            )
            sub.add_argument(
                "--model-override",
                default=None,
                help="Optional LLM model override (defaults to MODEL_OVERRIDE).",
            )
            sub.add_argument(
                "--run-url",
                default="",
                help="Workflow run URL (defaults to RUN_URL).",
            )
            sub.add_argument(
                "--dry-run",
                action="store_true",
                help="Revise plan file locally without git push, PR comment, or callback.",
            )
        elif name == "trigger-coder":
            sub.add_argument(
                "--head-ref",
                default=None,
                help="Merged plan PR head ref (defaults to HEAD_REF env var).",
            )
            sub.add_argument(
                "--base-branch",
                default=None,
                help="Base branch name (defaults to BASE_REF or 'main').",
            )
            sub.add_argument(
                "--merge-sha",
                default=None,
                help="Merge commit SHA (defaults to MERGE_COMMIT_SHA or MERGE_SHA).",
            )
            sub.add_argument(
                "--pr-number",
                type=int,
                default=None,
                help="Optional merged PR number (defaults to PR_NUMBER).",
            )
            sub.add_argument(
                "--pr-body",
                default=None,
                help="Optional PR body text (defaults to PR_BODY).",
            )
            sub.add_argument(
                "--requirement-id",
                default=None,
                help="Optional orchestrator requirement UUID (defaults to REQUIREMENT_ID).",
            )
            sub.add_argument(
                "--run-url",
                default="",
                help="Workflow run URL (defaults to RUN_URL).",
            )
            sub.add_argument(
                "--dry-run",
                action="store_true",
                help="Build prompt without calling Cursor API or callback.",
            )
        elif name == "review":
            sub.add_argument(
                "--pr-number",
                type=int,
                default=None,
                help="Pull request number (defaults to PR_NUMBER env var).",
            )
            sub.add_argument(
                "--pr-body",
                default=None,
                help="Pull request body text (defaults to PR_BODY env var).",
            )
            sub.add_argument(
                "--run-url",
                default="",
                help="Workflow run URL (defaults to RUN_URL or GitHub Actions env vars).",
            )
            sub.add_argument(
                "--test-status",
                default=None,
                help="Automated test suite status (PASSED, FAILED, PENDING).",
            )
            sub.add_argument(
                "--model-override",
                default=None,
                help="Optional LLM model override.",
            )
            sub.add_argument(
                "--dry-run",
                action="store_true",
                help="Run review without posting PR comments or callbacks.",
            )

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Main CLI entrypoint."""
    parser = build_parser()
    args = parser.parse_args(argv)

    target_dir = args.target_dir.resolve()
    factory_dir = args.factory_dir.resolve()

    if args.command == "plan":
        requirement = (
            args.requirement
            if args.requirement is not None
            else (os.environ.get("REQUIREMENT") or os.environ.get("PROMPT_TEXT") or "")
        )
        if not requirement.strip():
            parser.error("--requirement or REQUIREMENT/PROMPT_TEXT env var is required for 'plan'.")
        result = run_plan(
            target_dir=target_dir,
            factory_dir=factory_dir,
            requirement=requirement,
            raw_slug=(
                args.slug if args.slug is not None else os.environ.get("RAW_SLUG", "")
            ),
            requirement_id=args.requirement_id or os.environ.get("REQUIREMENT_ID") or None,
            model_override=args.model_override or os.environ.get("MODEL_OVERRIDE"),
            run_url=args.run_url or os.environ.get("RUN_URL", ""),
            gh_run_id=os.environ.get("GITHUB_RUN_ID") or None,
            base_branch=args.base_branch or os.environ.get("BASE_BRANCH") or "main",
            dry_run=args.dry_run,
        )
        print(
            f"[factory-engine] plan complete: plan_id={result.plan_id} "
            f"branch={result.branch_name} pr=#{result.pr_number}"
        )
        return 0

    if args.command == "revise":
        raw_pr = args.pr_number or os.environ.get("PR_NUMBER", "").strip()
        if not raw_pr:
            parser.error("--pr-number or PR_NUMBER env var is required for 'revise'.")
        head_ref = (
            args.head_ref if args.head_ref is not None else os.environ.get("HEAD_REF", "")
        ).strip()
        if not head_ref:
            parser.error("--head-ref or HEAD_REF env var is required for 'revise'.")
        comment_body = (
            args.comment_body
            if args.comment_body is not None
            else os.environ.get("COMMENT_BODY", "")
        )
        result = run_revise(
            target_dir=target_dir,
            factory_dir=factory_dir,
            pr_number=int(raw_pr),
            head_ref=head_ref,
            comment_body=comment_body,
            requirement_id=args.requirement_id or os.environ.get("REQUIREMENT_ID") or None,
            model_override=args.model_override or os.environ.get("MODEL_OVERRIDE"),
            run_url=args.run_url or os.environ.get("RUN_URL", ""),
            gh_run_id=os.environ.get("GITHUB_RUN_ID") or None,
            dry_run=args.dry_run,
        )
        print(
            f"[factory-engine] revise complete: plan_id={result.plan_id} "
            f"pr=#{result.pr_number} commit={result.commit_sha}"
        )
        return 0

    if args.command == "trigger-coder":
        repo = os.environ.get("GH_REPO") or os.environ.get("GITHUB_REPOSITORY") or ""
        server_url = os.environ.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
        repo_url = os.environ.get("REPO_URL") or (f"{server_url}/{repo}" if repo else "")
        merge_sha = (
            args.merge_sha
            if args.merge_sha is not None
            else (
                os.environ.get("MERGE_COMMIT_SHA")
                or os.environ.get("MERGE_SHA")
                or os.environ.get("GITHUB_SHA")
                or ""
            )
        )
        raw_pr = args.pr_number or os.environ.get("PR_NUMBER", "").strip()
        pr_number = int(raw_pr) if raw_pr else None
        result = run_trigger_coder(
            target_dir=target_dir,
            factory_dir=factory_dir,
            cursor_api_key=os.environ.get("CURSOR_API_KEY", ""),
            repo=repo,
            repo_url=repo_url,
            merge_commit_sha=merge_sha,
            head_ref=args.head_ref if args.head_ref is not None else os.environ.get("HEAD_REF", ""),
            base_branch=args.base_branch or os.environ.get("BASE_REF") or "main",
            pr_number=pr_number,
            pr_body=args.pr_body if args.pr_body is not None else os.environ.get("PR_BODY", ""),
            cursor_model=os.environ.get("CURSOR_MODEL", ""),
            requirement_id=args.requirement_id or os.environ.get("REQUIREMENT_ID") or None,
            run_url=args.run_url or os.environ.get("RUN_URL", ""),
            gh_run_id=os.environ.get("GITHUB_RUN_ID") or None,
            dry_run=args.dry_run,
        )
        print(
            f"[factory-engine] trigger-coder complete: plan_id={result.plan_id} "
            f"agent_id={result.cursor_agent_id}"
        )
        return 0

    if args.command == "review":
        raw_pr = args.pr_number or os.environ.get("PR_NUMBER", "").strip()
        if not raw_pr:
            parser.error("--pr-number or PR_NUMBER environment variable is required for 'review'.")
        result = run_pr_review(
            target_dir=target_dir,
            factory_dir=factory_dir,
            pr_number=int(raw_pr),
            pr_body=args.pr_body if args.pr_body is not None else os.environ.get("PR_BODY", ""),
            run_url=args.run_url or os.environ.get("RUN_URL", ""),
            test_status=args.test_status or os.environ.get("TEST_STATUS"),
            model_override=args.model_override or os.environ.get("MODEL_OVERRIDE"),
            head_ref=os.environ.get("HEAD_REF", ""),
            gh_run_id=os.environ.get("GITHUB_RUN_ID") or None,
            dry_run=args.dry_run,
        )
        print(
            f"[factory-engine] review complete: pr=#{result.pr_number} "
            f"has_diff={result.has_diff} verdict={result.verdict}"
        )
        return 0

    print(
        f"[factory-engine] Stage '{args.command}' placeholder "
        f"(target_dir={target_dir}, factory_dir={factory_dir})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
