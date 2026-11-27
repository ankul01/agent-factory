"""CLI entrypoint for factory-engine."""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from factory_engine.stages.pr_review import run_pr_review


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
        if name == "review":
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
