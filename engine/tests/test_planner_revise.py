"""Offline unit tests for factory_engine.stages.planner_revise."""

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
from factory_engine.stages.planner_revise import (
    extract_revise_feedback,
    extract_slug_from_plan_id,
    run_revise,
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


def test_extract_revise_feedback_and_slug() -> None:
    assert extract_revise_feedback("/revise Add pagination") == "Add pagination"
    assert extract_slug_from_plan_id("20261127-180000-add-due-dates") == "add-due-dates"

    with pytest.raises(ValueError, match="empty"):
        extract_revise_feedback("/revise   ")


def test_run_revise_rejects_invalid_branch_and_traversal(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="does not start with 'plan/'"):
        run_revise(
            target_dir=tmp_path,
            factory_dir=tmp_path,
            pr_number=9,
            head_ref="feat/not-a-plan",
            comment_body="/revise fix",
        )

    with pytest.raises(ValueError, match="Unsafe plan_id"):
        run_revise(
            target_dir=tmp_path,
            factory_dir=tmp_path,
            pr_number=9,
            head_ref="plan/../../etc/passwd",
            comment_body="/revise fix",
        )


@respx.mock
def test_run_revise_updates_plan_commits_comments_and_posts_callback(
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

    plan_id = "20261127-180000-add-due-dates"
    head_ref = f"plan/{plan_id}"
    subprocess.run(
        ["git", "checkout", "-b", head_ref], cwd=target_dir, check=True, capture_output=True
    )
    plan_file = target_dir / "docs" / "plans" / f"{plan_id}.md"
    plan_file.parent.mkdir(parents=True)
    plan_file.write_text("---\nplan_id: old\n---\n# Old\n", encoding="utf-8")
    subprocess.run(
        ["git", "add", f"docs/plans/{plan_id}.md"], cwd=target_dir, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-m", "draft"], cwd=target_dir, check=True, capture_output=True
    )

    factory_dir = tmp_path / "factory"
    factory_dir.mkdir()

    revised_md = (
        "---\nplan_id: 20261127-180000-add-due-dates\nrevised_at: \"2026-11-27T18:05:00Z\"\n---\n"
        "## 1. Open Questions\n- Confirm timezone format?\n"
        "## 2. Scope\n- Question in prose should be ignored.\n"
    )
    wrapped = f"```markdown\n{revised_md}```"
    respx.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent"
    ).mock(
        return_value=httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": wrapped}]}}]},
        )
    )
    cb_route = respx.post(callback_url).mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    gh = MagicMock()
    gh.repo = "ankul01/task-manager"
    gh.comment_on_pr.return_value = {
        "html_url": "https://github.com/ankul01/task-manager/pull/12#issuecomment-2"
    }

    original_run = subprocess.run

    def fake_run(cmd: list[str], *args: object, **kwargs: object) -> subprocess.CompletedProcess:
        if cmd[:2] == ["git", "push"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        return original_run(cmd, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = run_revise(
        target_dir=target_dir,
        factory_dir=factory_dir,
        pr_number=12,
        head_ref=head_ref,
        comment_body="/revise Please clarify timezone handling",
        requirement_id="22222222-2222-2222-2222-222222222222",
        run_url="https://github.com/ankul01/task-manager/actions/runs/888",
        gh_run_id="888",
        github_client=gh,
        llm_client=_planner_llm_client(),
    )

    assert result.slug == "add-due-dates"
    assert result.open_questions_count == 1
    assert "Confirm timezone format?" in plan_file.read_text(encoding="utf-8")
    assert result.commit_sha is not None
    gh.comment_on_pr.assert_called_once()

    assert cb_route.call_count == 1
    sent = json.loads(cb_route.calls[0].request.content.decode("utf-8"))
    assert sent == {
        "repoOwner": "ankul01",
        "repoName": "task-manager",
        "slug": "add-due-dates",
        "requirementId": "22222222-2222-2222-2222-222222222222",
        "stage": "plan",
        "status": "PR_OPEN",
        "ghRunId": "888",
        "ghRunUrl": "https://github.com/ankul01/task-manager/actions/runs/888",
        "planPath": f"docs/plans/{plan_id}.md",
        "branchName": head_ref,
        "prNumber": 12,
        "openQuestionsCount": 1,
        "modelUsed": "gemini-4-hydrogen",
    }


@respx.mock
def test_run_revise_ignores_planner_prompt_and_handles_no_diff(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("FACTORY_CALLBACK_URL", raising=False)
    monkeypatch.delenv("ORCHESTRATOR_URL", raising=False)

    target_dir = tmp_path / "target"
    target_dir.mkdir()
    _init_git_repo(target_dir)

    plan_id = "20261127-180000-add-due-dates"
    head_ref = f"plan/{plan_id}"
    subprocess.run(
        ["git", "checkout", "-b", head_ref], cwd=target_dir, check=True, capture_output=True
    )
    existing_content = "---\nplan_id: 20261127-180000-add-due-dates\n---\n# Unchanged Plan\n"
    plan_file = target_dir / "docs" / "plans" / f"{plan_id}.md"
    plan_file.parent.mkdir(parents=True)
    plan_file.write_text(existing_content, encoding="utf-8")
    subprocess.run(
        ["git", "add", f"docs/plans/{plan_id}.md"], cwd=target_dir, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-m", "draft"], cwd=target_dir, check=True, capture_output=True
    )

    # Create .agent-factory/prompts/planner.md and verify revise does NOT use it
    factory_dir = tmp_path / "factory"
    prompts_dir = factory_dir / ".agent-factory" / "prompts"
    prompts_dir.mkdir(parents=True)
    (prompts_dir / "planner.md").write_text("PLANNER ONLY PROMPT", encoding="utf-8")

    llm_route = respx.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent"
    ).mock(
        return_value=httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": existing_content.strip()}]}}]},
        )
    )

    gh = MagicMock()
    gh.repo = "ankul01/task-manager"
    gh.comment_on_pr.return_value = {
        "html_url": "https://github.com/ankul01/task-manager/pull/12#issuecomment-3"
    }

    result = run_revise(
        target_dir=target_dir,
        factory_dir=factory_dir,
        pr_number=12,
        head_ref=head_ref,
        comment_body="/revise Looks good as-is",
        github_client=gh,
        llm_client=_planner_llm_client(),
    )

    assert result.commit_sha is not None
    req_body = json.loads(llm_route.calls[0].request.content.decode("utf-8"))
    system_text = req_body["systemInstruction"]["parts"][0]["text"]
    assert "PLANNER ONLY PROMPT" not in system_text
    assert "requested revisions on an existing draft software plan" in system_text

    gh.comment_on_pr.assert_called_once()
    posted_comment = gh.comment_on_pr.call_args[0][1]
    assert "no file changes were needed" in posted_comment


@respx.mock
def test_run_revise_commits_only_plan_file_ignoring_prestaged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("FACTORY_CALLBACK_URL", raising=False)
    monkeypatch.delenv("ORCHESTRATOR_URL", raising=False)

    target_dir = tmp_path / "target"
    target_dir.mkdir()
    _init_git_repo(target_dir)

    plan_id = "20261127-180000-add-due-dates"
    head_ref = f"plan/{plan_id}"
    subprocess.run(
        ["git", "checkout", "-b", head_ref], cwd=target_dir, check=True, capture_output=True
    )
    plan_file = target_dir / "docs" / "plans" / f"{plan_id}.md"
    plan_file.parent.mkdir(parents=True)
    plan_file.write_text("# Old\n", encoding="utf-8")
    subprocess.run(
        ["git", "add", f"docs/plans/{plan_id}.md"], cwd=target_dir, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-m", "draft"], cwd=target_dir, check=True, capture_output=True
    )

    # Pre-stage an unrelated file in the index before run_revise runs
    (target_dir / "unrelated_staged.txt").write_text("do not commit\n", encoding="utf-8")
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
            json={"candidates": [{"content": {"parts": [{"text": "# Revised\n"}]}}]},
        )
    )

    gh = MagicMock()
    gh.repo = "ankul01/task-manager"
    gh.comment_on_pr.return_value = {"html_url": "https://example.com/comment/1"}

    original_run = subprocess.run

    def fake_run(cmd: list[str], *args: object, **kwargs: object) -> subprocess.CompletedProcess:
        if cmd[:2] == ["git", "push"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        return original_run(cmd, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = run_revise(
        target_dir=target_dir,
        factory_dir=factory_dir,
        pr_number=12,
        head_ref=head_ref,
        comment_body="/revise Update title",
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
