"""Offline unit tests for factory_engine.stages.planner."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest
import respx

from factory_engine.llm import LLMClient, LLMProfilesConfig, RouteConfig
from factory_engine.llm.models import ProfileRoutes
from factory_engine.stages.planner import (
    count_open_questions,
    resolve_plan_path,
    run_plan,
    sanitize_slug,
)


def _planner_llm_client() -> LLMClient:
    route = RouteConfig(
        name="gemini-hydrogen",
        adapter="gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        model="gemini-4-hydrogen",
        api_key_env="GEMINI_API_KEY",
        retries=0,
    )
    cfg = LLMProfilesConfig(
        global_timeout_sec=60.0,
        profiles={"planner": ProfileRoutes(routes=[route])},
    )
    return LLMClient(config=cfg)


def _init_git_repo(repo_dir: Path) -> None:
    subprocess.run(["git", "init", "-b", "main"], cwd=repo_dir, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.name", "Test"], cwd=repo_dir, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=repo_dir,
        check=True,
        capture_output=True,
    )
    (repo_dir / "README.md").write_text("init\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo_dir, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "init"], cwd=repo_dir, check=True, capture_output=True
    )


def test_sanitize_slug_valid_and_adversarial() -> None:
    assert sanitize_slug("Add Due Dates!", "ignored") == "add-due-dates"
    assert sanitize_slug("", "Add task priority levels to API endpoints") == (
        "add-task-priority-levels-to"
    )
    # Adversarial: empty / punctuation-only input falls back safely to "plan"
    assert sanitize_slug("!!!", "???") == "plan"
    # Truncated to <= 40 chars without trailing hyphen
    long_slug = sanitize_slug("a-" * 30, "req")
    assert len(long_slug) <= 40
    assert not long_slug.endswith("-")


def test_resolve_plan_path_prevents_traversal(tmp_path: Path) -> None:
    full, rel = resolve_plan_path(tmp_path, "specs/plans", "20261127-add-auth")
    assert rel == "specs/plans/20261127-add-auth.md"
    assert full == (tmp_path / "specs" / "plans" / "20261127-add-auth.md").resolve()

    with pytest.raises(ValueError, match="Unsafe plan_id"):
        resolve_plan_path(tmp_path, "docs/plans", "../../etc/passwd")

    with pytest.raises(ValueError, match="escapes target_dir"):
        resolve_plan_path(tmp_path, "../../outside", "20261127-add-auth")


def test_count_open_questions_anchored_and_adversarial() -> None:
    md = """## 1. Clarifying Questions and Assumptions
- Should due dates support timezones?
- What is the default sort order?

## 2. Scope and Non-Goals
- This section mentions a question in prose: is that a question? No, ignore it!
- Another question word here should not be counted.
"""
    assert count_open_questions(md) == 2

    md_none = """## Open Questions
- None
"""
    assert count_open_questions(md_none) == 0


def test_count_open_questions_nested_subheadings() -> None:
    md_nested = """## 1. Clarifying Questions and Assumptions

### Clarifying Questions
- Should due dates support timezones?
- What is the default sort order?

### Assumptions
- Tasks belong to a single project.
- Dates are stored in UTC.

## 2. Scope and Non-Goals
- Build REST endpoints.
"""
    assert count_open_questions(md_nested) == 2


@respx.mock
def test_run_plan_writes_config_dir_creates_branch_and_posts_callback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    callback_url = "https://factory.example.com/api/callbacks/workflow"
    monkeypatch.setenv("FACTORY_CALLBACK_URL", callback_url)
    monkeypatch.setenv("ORCHESTRATOR_CALLBACK_SECRET", "cb-secret")

    target_dir = tmp_path / "target"
    target_dir.mkdir()
    _init_git_repo(target_dir)
    (target_dir / ".agent-factory.yml").write_text(
        "archetype: backend-java\nplan_dir: specs/plans\n",
        encoding="utf-8",
    )

    factory_dir = tmp_path / "factory"
    (factory_dir / "skills").mkdir(parents=True)
    (factory_dir / "skills" / "backend-java.md").write_text("Java 21 skill", encoding="utf-8")

    plan_markdown = (
        "## 1. Clarifying Questions and Assumptions\n"
        "- Which status codes should be returned?\n\n"
        "## 2. Scope and Non-Goals\n"
        "- Question in prose outside section should not count.\n"
    )
    respx.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent"
    ).mock(
        return_value=httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": plan_markdown}]}}]},
        )
    )
    cb_route = respx.post(callback_url).mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    gh = MagicMock()
    gh.repo = "ankul01/task-manager"
    gh.create_pull_request.return_value = {
        "number": 12,
        "html_url": "https://github.com/ankul01/task-manager/pull/12",
    }

    # Mock git push so test stays 100% offline while real git checkout/commit run
    original_run = subprocess.run

    def fake_run(cmd: list[str], *args: object, **kwargs: object) -> subprocess.CompletedProcess:
        if cmd[:2] == ["git", "push"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        return original_run(cmd, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = run_plan(
        target_dir=target_dir,
        factory_dir=factory_dir,
        requirement="Add due dates to tasks",
        raw_slug="add-due-dates",
        requirement_id="11111111-1111-1111-1111-111111111111",
        run_url="https://github.com/ankul01/task-manager/actions/runs/555",
        gh_run_id="555",
        github_client=gh,
        llm_client=_planner_llm_client(),
    )

    assert result.slug == "add-due-dates"
    assert result.plan_path.startswith("specs/plans/")
    assert result.branch_name.startswith("plan/")
    assert (target_dir / result.plan_path).is_file()
    assert result.open_questions_count == 1
    assert result.pr_number == 12
    gh.create_pull_request.assert_called_once()

    assert cb_route.call_count == 1
    sent = json.loads(cb_route.calls[0].request.content.decode("utf-8"))
    assert sent == {
        "repoOwner": "ankul01",
        "repoName": "task-manager",
        "slug": "add-due-dates",
        "requirementId": "11111111-1111-1111-1111-111111111111",
        "stage": "plan",
        "status": "PR_OPEN",
        "ghRunId": "555",
        "ghRunUrl": "https://github.com/ankul01/task-manager/actions/runs/555",
        "planPath": result.plan_path,
        "branchName": result.branch_name,
        "prNumber": 12,
        "prUrl": "https://github.com/ankul01/task-manager/pull/12",
        "openQuestionsCount": 1,
        "modelUsed": "gemini-4-hydrogen",
    }


@respx.mock
def test_run_plan_commits_only_plan_file_ignoring_prestaged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("FACTORY_CALLBACK_URL", raising=False)
    monkeypatch.delenv("ORCHESTRATOR_URL", raising=False)

    target_dir = tmp_path / "target"
    target_dir.mkdir()
    _init_git_repo(target_dir)

    # Pre-stage an unrelated file in the index before run_plan runs
    unrelated = target_dir / "unrelated_staged.txt"
    unrelated.write_text("should not be committed\n", encoding="utf-8")
    subprocess.run(
        ["git", "add", "unrelated_staged.txt"], cwd=target_dir, check=True, capture_output=True
    )

    factory_dir = tmp_path / "factory"
    factory_dir.mkdir()

    respx.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent"
    ).mock(
        return_value=httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": "## Scope\n- Task"}]}}]},
        )
    )

    gh = MagicMock()
    gh.repo = "ankul01/task-manager"
    gh.create_pull_request.return_value = {"number": 99, "html_url": "https://example.com/pr/99"}

    original_run = subprocess.run

    def fake_run(cmd: list[str], *args: object, **kwargs: object) -> subprocess.CompletedProcess:
        if cmd[:2] == ["git", "push"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        return original_run(cmd, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = run_plan(
        target_dir=target_dir,
        factory_dir=factory_dir,
        requirement="Add isolated plan commit",
        raw_slug="isolated-commit",
        github_client=gh,
        llm_client=_planner_llm_client(),
    )

    committed_files = subprocess.run(
        ["git", "show", "--name-only", "--format=", "HEAD"],
        cwd=target_dir,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.splitlines()
    assert committed_files == [result.plan_path]
    assert "unrelated_staged.txt" not in committed_files
