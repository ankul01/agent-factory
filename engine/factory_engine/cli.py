"""CLI entrypoint for factory-engine."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path


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

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Main CLI entrypoint."""
    parser = build_parser()
    args = parser.parse_args(argv)

    target_dir = args.target_dir.resolve()
    factory_dir = args.factory_dir.resolve()

    print(
        f"[factory-engine] Stage '{args.command}' placeholder "
        f"(target_dir={target_dir}, factory_dir={factory_dir})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
