"""Offline unit tests for factory_engine.stages.trigger_coder."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import respx

from factory_engine.stages.trigger_coder import (
    CURSOR_AGENTS_URL,
    CoderTriggerError,
    resolve_approved_plan,
    run_trigger_coder,
)


def test_resolve_approved_plan_head_ref_body_and_traversal(tmp_path: Path) -> None:
    plan_file = tmp_path / "specs" / "plans" / "20261127-add-auth.md"
    plan_file.parent.mkdir(parents=True)
    plan_file.write_text("# Approved Auth Plan\n", encoding="utf-8")

    plan_id, full_path, rel_path = resolve_approved_plan(
        tmp_path, "specs/plans", head_ref="plan/20261127-add-auth"
    )
    assert plan_id == "20261127-add-auth"
    assert full_path == plan_file.resolve()
    assert rel_path == "specs/plans/20261127-add-auth.md"

    # Fallback to PR body when head_ref is not plan/*
    plan_id2, _, rel_path2 = resolve_approved_plan(
        tmp_path,
        "specs/plans",
        head_ref="manual-trigger",
        pr_body="Implements specs/plans/20261127-add-auth.md",
    )
    assert plan_id2 == "20261127-add-auth"
    assert rel_path2 == "specs/plans/20261127-add-auth.md"

    # Path traversal rejected
    with pytest.raises(ValueError, match="Unsafe plan_id"):
        resolve_approved_plan(tmp_path, "specs/plans", head_ref="plan/../../etc/passwd")

    # Missing plan file rejected
    with pytest.raises(FileNotFoundError, match="Approved plan file not found"):
        resolve_approved_plan(tmp_path, "specs/plans", head_ref="plan/20261127-missing")


@respx.mock
def test_run_trigger_coder_launches_agent_and_posts_callback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    callback_url = "https://factory.example.com/api/callbacks/workflow"
    monkeypatch.setenv("FACTORY_CALLBACK_URL", callback_url)
    monkeypatch.setenv("ORCHESTRATOR_CALLBACK_SECRET", "cb-secret")

    target_dir = tmp_path / "target"
    target_dir.mkdir()
    (target_dir / ".agent-factory.yml").write_text(
        "archetype: backend-java\n"
        "test_command: \"mvn -B test\"\n"
        "protected_paths:\n"
        "  - \".github/workflows/**\"\n"
        "plan_dir: docs/plans\n",
        encoding="utf-8",
    )
    plan_file = target_dir / "docs" / "plans" / "20261127-190000-add-tags.md"
    plan_file.parent.mkdir(parents=True)
    plan_file.write_text("# Plan\nAdd tags.", encoding="utf-8")

    factory_dir = tmp_path / "factory"
    (factory_dir / "skills").mkdir(parents=True)
    (factory_dir / "skills" / "backend-java.md").write_text(
        "Use Spring Boot 3 + Java 21.", encoding="utf-8"
    )
    (factory_dir / ".agent-factory" / "prompts").mkdir(parents=True)
    (factory_dir / ".agent-factory" / "prompts" / "coder.md").write_text(
        "Custom coder instructions.", encoding="utf-8"
    )

    cursor_route = respx.post(CURSOR_AGENTS_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "bc_12345",
                "runId": "run_999",
                "url": "https://cursor.com/agents/bc_12345",
            },
        )
    )
    cb_route = respx.post(callback_url).mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    result = run_trigger_coder(
        target_dir=target_dir,
        factory_dir=factory_dir,
        cursor_api_key="cur_secret_key_value",
        repo="ankul01/task-manager",
        repo_url="https://github.com/ankul01/task-manager",
        merge_commit_sha="deadbeef1234",
        head_ref="plan/20261127-190000-add-tags",
        base_branch="main",
        pr_number=15,
        cursor_model="claude-4-sonnet",
        requirement_id="33333333-3333-3333-3333-333333333333",
        run_url="https://github.com/ankul01/task-manager/actions/runs/321",
        gh_run_id="321",
    )

    assert result.cursor_agent_id == "bc_12345"
    assert result.cursor_run_id == "run_999"
    assert result.cursor_tracking_url == "https://cursor.com/agents/bc_12345"
    assert result.branch_name == "feat/20261127-190000-add-tags"

    assert cursor_route.call_count == 1
    req = cursor_route.calls[0].request
    assert req.headers["Authorization"] == "Bearer cur_secret_key_value"
    cursor_payload = json.loads(req.content.decode("utf-8"))
    assert cursor_payload["name"] == "Implement 20261127-190000-add-tags"
    assert cursor_payload["repos"] == [
        {"url": "https://github.com/ankul01/task-manager", "startingRef": "deadbeef1234"}
    ]
    assert cursor_payload["model"] == {"id": "claude-4-sonnet"}
    assert cursor_payload["autoCreatePR"] is True
    prompt_text = cursor_payload["prompt"]["text"]
    assert "Custom coder instructions." in prompt_text
    assert "Use Spring Boot 3 + Java 21." in prompt_text
    assert "mvn -B test" in prompt_text
    assert "docs/plans/20261127-190000-add-tags.md" in prompt_text

    assert cb_route.call_count == 1
    cb_payload = json.loads(cb_route.calls[0].request.content.decode("utf-8"))
    assert cb_payload == {
        "repoOwner": "ankul01",
        "repoName": "task-manager",
        "slug": "add-tags",
        "requirementId": "33333333-3333-3333-3333-333333333333",
        "stage": "coding",
        "status": "RUNNING",
        "planPath": "docs/plans/20261127-190000-add-tags.md",
        "branchName": "feat/20261127-190000-add-tags",
        "mergeCommitSha": "deadbeef1234",
        "ghRunId": "321",
        "ghRunUrl": "https://github.com/ankul01/task-manager/actions/runs/321",
        "cursorAgentId": "bc_12345",
        "cursorRunId": "run_999",
        "cursorTrackingUrl": "https://cursor.com/agents/bc_12345",
    }
    assert "prNumber" not in cb_payload


@respx.mock
def test_run_trigger_coder_missing_key_and_http_error_no_leak(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    callback_url = "https://factory.example.com/api/callbacks/workflow"
    monkeypatch.setenv("FACTORY_CALLBACK_URL", callback_url)
    monkeypatch.setenv("ORCHESTRATOR_CALLBACK_SECRET", "cb-secret")

    target_dir = tmp_path / "target"
    plan_file = target_dir / "docs" / "plans" / "20261127-190000-add-tags.md"
    plan_file.parent.mkdir(parents=True)
    plan_file.write_text("# Plan\n", encoding="utf-8")

    cb_route = respx.post(callback_url).mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    with pytest.raises(CoderTriggerError, match="CURSOR_API_KEY is not configured"):
        run_trigger_coder(
            target_dir=target_dir,
            factory_dir=tmp_path,
            cursor_api_key="   ",
            repo="ankul01/task-manager",
            repo_url="https://github.com/ankul01/task-manager",
            merge_commit_sha="deadbeef",
            head_ref="plan/20261127-190000-add-tags",
        )

    assert cb_route.call_count == 1
    assert json.loads(cb_route.calls[0].request.content.decode("utf-8"))["status"] == "FAILED"

    secret_key = "cur_super_secret_do_not_leak"
    respx.post(CURSOR_AGENTS_URL).mock(
        return_value=httpx.Response(502, text="Bad Gateway")
    )

    with pytest.raises(CoderTriggerError) as exc_info:
        run_trigger_coder(
            target_dir=target_dir,
            factory_dir=tmp_path,
            cursor_api_key=secret_key,
            repo="ankul01/task-manager",
            repo_url="https://github.com/ankul01/task-manager",
            merge_commit_sha="deadbeef",
            head_ref="plan/20261127-190000-add-tags",
        )

    assert secret_key not in str(exc_info.value)
    assert cb_route.call_count == 2
    fail_payload = json.loads(cb_route.calls[1].request.content.decode("utf-8"))
    assert fail_payload["status"] == "FAILED"
    assert "HTTP 502" in fail_payload["failureReason"]
    assert secret_key not in fail_payload["failureReason"]


def test_run_trigger_coder_dry_run_without_api_key(tmp_path: Path) -> None:
    target_dir = tmp_path / "target"
    plan_file = target_dir / "docs" / "plans" / "20261127-190000-add-tags.md"
    plan_file.parent.mkdir(parents=True)
    plan_file.write_text("# Plan\n", encoding="utf-8")

    result = run_trigger_coder(
        target_dir=target_dir,
        factory_dir=tmp_path,
        cursor_api_key="",
        repo="ankul01/task-manager",
        repo_url="https://github.com/ankul01/task-manager",
        merge_commit_sha="deadbeef",
        head_ref="plan/20261127-190000-add-tags",
        dry_run=True,
    )
    assert result.plan_path == "docs/plans/20261127-190000-add-tags.md"
    assert result.cursor_agent_id is None


@respx.mock
def test_run_trigger_coder_timeout_sends_failed_callback_no_leak(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    callback_url = "https://factory.example.com/api/callbacks/workflow"
    monkeypatch.setenv("FACTORY_CALLBACK_URL", callback_url)
    monkeypatch.setenv("ORCHESTRATOR_CALLBACK_SECRET", "cb-secret")

    target_dir = tmp_path / "target"
    plan_file = target_dir / "docs" / "plans" / "20261127-190000-add-tags.md"
    plan_file.parent.mkdir(parents=True)
    plan_file.write_text("# Plan\n", encoding="utf-8")

    secret_key = "cur_timeout_secret_do_not_leak"
    respx.post(CURSOR_AGENTS_URL).mock(
        side_effect=httpx.ReadTimeout("timed out")
    )
    cb_route = respx.post(callback_url).mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    with pytest.raises(CoderTriggerError, match="ReadTimeout"):
        run_trigger_coder(
            target_dir=target_dir,
            factory_dir=tmp_path,
            cursor_api_key=secret_key,
            repo="ankul01/task-manager",
            repo_url="https://github.com/ankul01/task-manager",
            merge_commit_sha="deadbeef",
            head_ref="plan/20261127-190000-add-tags",
        )

    assert cb_route.call_count == 1
    fail_payload = json.loads(cb_route.calls[0].request.content.decode("utf-8"))
    assert fail_payload["status"] == "FAILED"
    assert "ReadTimeout" in fail_payload["failureReason"]
    assert secret_key not in fail_payload["failureReason"]
