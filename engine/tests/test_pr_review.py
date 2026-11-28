"""Offline unit tests for factory_engine.stages.pr_review."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest
import respx

from factory_engine.llm import LLMClient, LLMProfilesConfig, RouteConfig
from factory_engine.llm.models import ProfileRoutes
from factory_engine.stages.pr_review import (
    MAX_DIFF_CHARS,
    _normalize_test_status,
    extract_plan_reference,
    extract_review_metrics,
    format_review_comment,
    run_pr_review,
    truncate_diff,
)


def _reviewer_client() -> LLMClient:
    route = RouteConfig(
        name="gemini-reviewer",
        adapter="gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        model="gemini-4-hydrogen",
        api_key_env="GEMINI_API_KEY",
        retries=0,
    )
    cfg = LLMProfilesConfig(
        global_timeout_sec=60.0,
        profiles={"reviewer": ProfileRoutes(routes=[route])},
    )
    return LLMClient(config=cfg)


def test_normalize_test_status() -> None:
    assert _normalize_test_status("PASSED") == "PASSED"
    assert _normalize_test_status("success") == "PASSED"
    assert _normalize_test_status("FAILED") == "FAILED"
    assert _normalize_test_status("failure") == "FAILED"
    assert _normalize_test_status("skipped") == "PENDING"
    assert _normalize_test_status(None) == "PASSED"


def test_truncate_diff() -> None:
    short = "diff --git a/a.py b/a.py\n+hello"
    assert truncate_diff(short) == short

    long_diff = "x" * (MAX_DIFF_CHARS + 50)
    truncated = truncate_diff(long_diff)
    assert len(truncated) < len(long_diff)
    assert truncated.endswith("... [DIFF TRUNCATED]")


def test_extract_plan_reference(tmp_path: Path) -> None:
    plan_file = tmp_path / "docs" / "plans" / "20261127-add-auth.md"
    plan_file.parent.mkdir(parents=True)
    plan_file.write_text("# Plan\nImplement auth.", encoding="utf-8")

    rel, ctx = extract_plan_reference(
        "Implements `docs/plans/20261127-add-auth.md`",
        tmp_path,
    )
    assert rel == "docs/plans/20261127-add-auth.md"
    assert "Implement auth." in ctx

    rel_missing, ctx_missing = extract_plan_reference(
        "Implements `docs/plans/nonexistent.md`",
        tmp_path,
    )
    assert rel_missing is None
    assert ctx_missing == "No approved plan file referenced in PR body."


def test_extract_review_metrics_and_comment_formatting() -> None:
    body = (
        "## Automated Code Review Summary\n"
        "- **Approved Plan Checked:** None referenced\n"
        "- **Verdict:** `CHANGES_REQUESTED`\n\n"
        "### Blocking Issues (Must Fix Before Merge)\n"
        "- [P0] Null pointer in TaskController\n"
        "- [P1] Missing index on user_id\n"
        "- [p1] Minor naming issue\n"
    )
    formatted = format_review_comment(
        review_text=body,
        model="gemini-4-hydrogen",
        route_name="gemini-reviewer",
        run_url="https://github.com/org/repo/actions/runs/123",
    )
    assert "*Model: `gemini-4-hydrogen` · Route: `gemini-reviewer`" in formatted
    assert "[Workflow Run](https://github.com/org/repo/actions/runs/123)" in formatted

    metrics = extract_review_metrics(formatted)
    assert metrics.verdict == "CHANGES_REQUESTED"
    assert metrics.p0_count == 1
    assert metrics.p1_count == 2


def test_format_review_comment_fallback_notice() -> None:
    notice_passed = format_review_comment(
        review_text=None,
        model=None,
        route_name=None,
        run_url="https://github.com/org/repo/actions/runs/99",
        test_status="PASSED",
    )
    assert "## Automated Code Review Notice" in notice_passed
    assert "All automated test suites passed." in notice_passed

    notice_failed = format_review_comment(
        review_text="",
        model=None,
        route_name=None,
        run_url="https://github.com/org/repo/actions/runs/99",
        test_status="FAILED",
    )
    assert "Automated test suite status: `FAILED`." in notice_failed


@respx.mock
def test_run_pr_review_posts_comment_and_extracts_verdict(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("FACTORY_CALLBACK_URL", raising=False)
    monkeypatch.delenv("ORCHESTRATOR_URL", raising=False)

    (tmp_path / "skills").mkdir()
    (tmp_path / "skills" / "general.md").write_text("Follow clean code.", encoding="utf-8")

    gh = MagicMock()
    gh.repo = "ankul01/task-manager"
    gh.get_pr_diff.return_value = "diff --git a/Main.java b/Main.java\n+class Main {}"
    gh.get_pull_request.return_value = {"body": ""}
    gh.comment_on_pr.return_value = {
        "html_url": "https://github.com/ankul01/task-manager/pull/5#issuecomment-1"
    }

    review_md = (
        "## Automated Code Review Summary\n"
        "- **Approved Plan Checked:** None referenced\n"
        "- **Verdict:** `APPROVED`\n"
    )
    respx.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent"
    ).mock(
        return_value=httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": review_md}]}}]},
        )
    )

    result = run_pr_review(
        target_dir=tmp_path,
        factory_dir=tmp_path,
        pr_number=5,
        pr_body="",
        run_url="https://github.com/ankul01/task-manager/actions/runs/10",
        test_status="PASSED",
        github_client=gh,
        llm_client=_reviewer_client(),
    )

    assert result.has_diff is True
    assert result.verdict == "APPROVED"
    assert result.p0_count == 0
    assert result.p1_count == 0
    assert result.model_used == "gemini-4-hydrogen"
    assert result.comment_url == "https://github.com/ankul01/task-manager/pull/5#issuecomment-1"
    gh.comment_on_pr.assert_called_once()


def test_run_pr_review_skips_empty_diff(tmp_path: Path) -> None:
    gh = MagicMock()
    gh.repo = "ankul01/task-manager"
    gh.get_pr_diff.return_value = "   \n"

    result = run_pr_review(
        target_dir=tmp_path,
        factory_dir=tmp_path,
        pr_number=7,
        github_client=gh,
        llm_client=_reviewer_client(),
    )

    assert result.has_diff is False
    assert result.comment_body == ""
    gh.comment_on_pr.assert_not_called()


def test_extract_review_metrics_prioritizes_explicit_verdict_line() -> None:
    body = (
        "## Automated Code Review Summary\n"
        "- **Verdict:** `APPROVED`\n\n"
        "### Minor Feedback & Suggestions (Optional / Non-Blocking)\n"
        "- Note: previously this would have been CHANGES_REQUESTED, but now fixed.\n"
    )
    metrics = extract_review_metrics(body)
    assert metrics.verdict == "APPROVED"


@respx.mock
def test_send_review_callback_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    import json

    from factory_engine.stages.pr_review import ReviewMetrics, _send_review_callback

    callback_url = "https://factory.example.com/api/callbacks/workflow"
    monkeypatch.setenv("FACTORY_CALLBACK_URL", callback_url)
    monkeypatch.setenv("ORCHESTRATOR_CALLBACK_SECRET", "test-secret")

    route = respx.post(callback_url).mock(
        return_value=httpx.Response(200, json={"ok": True, "status": "IN_REVIEW"})
    )

    gh = MagicMock()
    gh.repo = "ankul01/task-manager"

    _send_review_callback(
        gh=gh,
        pr_number=42,
        run_url="https://github.com/ankul01/task-manager/actions/runs/777",
        test_status="PASSED",
        metrics=ReviewMetrics(verdict="CHANGES_REQUESTED", p0_count=1, p1_count=2),
        model_used="gemini-4-hydrogen",
        comment_url="https://github.com/ankul01/task-manager/pull/42#issuecomment-99",
        head_ref="feat/add-auth",
        gh_run_id="777",
    )

    assert route.call_count == 1
    sent = json.loads(route.calls[0].request.content.decode("utf-8"))
    assert sent["prNumber"] == 42
    assert sent["verdict"] == "CHANGES_REQUESTED"
    assert sent["testStatus"] == "PASSED"
    assert sent["p0Count"] == 1
    assert sent["p1Count"] == 2
    assert sent["ghRunId"] == "777"
    assert sent["slug"] == "add-auth"


@respx.mock
def test_send_review_callback_strips_plan_timestamp(monkeypatch: pytest.MonkeyPatch) -> None:
    import json

    from factory_engine.stages.pr_review import ReviewMetrics, _send_review_callback

    callback_url = "https://factory.example.com/api/callbacks/workflow"
    monkeypatch.setenv("FACTORY_CALLBACK_URL", callback_url)
    monkeypatch.setenv("ORCHESTRATOR_CALLBACK_SECRET", "test-secret")

    route = respx.post(callback_url).mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    gh = MagicMock()
    gh.repo = "ankul01/task-manager"

    _send_review_callback(
        gh=gh,
        pr_number=43,
        run_url="https://github.com/ankul01/task-manager/actions/runs/778",
        test_status="PASSED",
        metrics=ReviewMetrics(verdict="APPROVED", p0_count=0, p1_count=0),
        model_used="gemini-4-hydrogen",
        comment_url="https://github.com/ankul01/task-manager/pull/43#issuecomment-1",
        head_ref="feat/20261127-190000-add-tags",
        gh_run_id="778",
    )

    sent = json.loads(route.calls[0].request.content.decode("utf-8"))
    assert sent["slug"] == "add-tags"


@respx.mock
def test_run_pr_review_downgrades_approved_when_diff_truncated(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("FACTORY_CALLBACK_URL", raising=False)
    monkeypatch.delenv("ORCHESTRATOR_URL", raising=False)

    gh = MagicMock()
    gh.repo = "ankul01/task-manager"
    gh.get_pr_diff.return_value = "a" * (MAX_DIFF_CHARS + 500)
    gh.get_pull_request.return_value = {"body": ""}
    gh.comment_on_pr.return_value = {
        "html_url": "https://github.com/ankul01/task-manager/pull/99#issuecomment-1"
    }

    respx.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent"
    ).mock(
        return_value=httpx.Response(
            200,
            json={
                "candidates": [
                    {"content": {"parts": [{"text": "- **Verdict:** `APPROVED`"}]}}
                ]
            },
        )
    )

    result = run_pr_review(
        target_dir=tmp_path,
        factory_dir=tmp_path,
        pr_number=99,
        github_client=gh,
        llm_client=_reviewer_client(),
    )

    assert result.verdict == "PENDING"
    assert "truncated" in result.comment_body.lower()
    assert "downgraded to `PENDING`" in result.comment_body
