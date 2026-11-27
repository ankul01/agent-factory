"""Cursor Cloud Agent trigger stage (`factory-engine trigger-coder`)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from factory_engine.config import FactoryConfig, load_config
from factory_engine.github.callback import CallbackPayload, post_workflow_callback
from factory_engine.prompts.loader import load_prompts
from factory_engine.stages.planner import resolve_plan_path
from factory_engine.stages.planner_revise import extract_slug_from_plan_id

CURSOR_AGENTS_URL = "https://api.cursor.com/v1/agents"


class CoderTriggerError(RuntimeError):
    """Raised when triggering the Cursor Cloud Agent fails."""


@dataclass(frozen=True)
class TriggerCoderResult:
    """Outcome of executing the `trigger_coder` stage."""

    plan_id: str
    slug: str
    plan_path: str
    branch_name: str
    merge_commit_sha: str
    cursor_agent_id: str | None
    cursor_run_id: str | None
    cursor_tracking_url: str | None


def resolve_approved_plan(
    target_dir: Path,
    plan_dir: str,
    head_ref: str = "",
    pr_body: str = "",
) -> tuple[str, Path, str]:
    """
    Resolve `(plan_id, full_plan_path, rel_plan_path)` inside `target_dir`.

    Prefers `head_ref` (`plan/<plan_id>`); falls back to an anchored
    `<plan_dir>/<plan_id>.md` reference in `pr_body`.
    """
    clean_dir = plan_dir.strip("/") or "docs/plans"
    if head_ref.startswith("plan/"):
        plan_id = head_ref.removeprefix("plan/").strip()
    else:
        pattern = re.compile(rf"\b{re.escape(clean_dir)}/([A-Za-z0-9._-]+)\.md\b")
        match = pattern.search(pr_body or "")
        if not match:
            raise ValueError(
                f"Unable to determine approved plan from head_ref={head_ref!r} or PR body."
            )
        plan_id = match.group(1)

    full_path, rel_path = resolve_plan_path(target_dir, clean_dir, plan_id)
    if not full_path.is_file():
        raise FileNotFoundError(f"Approved plan file not found: {rel_path}")
    return plan_id, full_path, rel_path


def build_coder_prompt(
    plan_id: str,
    plan_path: str,
    merge_commit_sha: str,
    base_branch: str,
    config: FactoryConfig,
    factory_dir: Path,
) -> str:
    """Construct the Cursor Cloud Agent implementation prompt."""
    bundle = load_prompts(factory_dir, config.archetype, "coder")
    test_rule = (
        f"run the full test suite (`{config.test_command}`) until all tests pass"
        if config.test_command
        else "verify all relevant tests and checks pass"
    )
    protected = ", ".join(dict.fromkeys([plan_path, *config.protected_paths]))

    parts = [
        bundle.stage_prompt or "You are the Software Developer Agent for this repository.",
        (
            f"Implement the approved specification at `{plan_path}` "
            f"(approved on `{base_branch}` at commit `{merge_commit_sha}`)."
        ),
        (
            "Rules:\n"
            f"1. Create a new feature branch `feat/{plan_id}` from `{base_branch}`.\n"
            f"2. Implement all tasks cleanly and {test_rule}.\n"
            f"3. Do NOT modify protected paths: {protected}.\n"
            f"4. Open a Pull Request targeting `{base_branch}` that references `{plan_path}` "
            f"and commit `{merge_commit_sha}` in the PR body, along with test results."
        ),
    ]
    if bundle.archetype_skill:
        parts.append(f"### Archetype Guidelines ({config.archetype})\n{bundle.archetype_skill}")

    return "\n\n".join(parts)


def run_trigger_coder(
    target_dir: Path,
    factory_dir: Path,
    cursor_api_key: str,
    repo: str,
    repo_url: str,
    merge_commit_sha: str,
    head_ref: str = "",
    base_branch: str = "main",
    pr_number: int | None = None,
    pr_body: str = "",
    cursor_model: str = "",
    requirement_id: str | None = None,
    run_url: str = "",
    gh_run_id: str | None = None,
    timeout_sec: float = 60.0,
    http_client: httpx.Client | None = None,
    dry_run: bool = False,
) -> TriggerCoderResult:
    """Launch the Cursor Cloud Agent for an approved plan and notify the orchestrator."""
    target_path = Path(target_dir).resolve()
    factory_path = Path(factory_dir).resolve()
    config = load_config(target_path)

    plan_id, _full_plan_path, rel_plan_path = resolve_approved_plan(
        target_dir=target_path,
        plan_dir=config.plan_dir,
        head_ref=head_ref,
        pr_body=pr_body,
    )
    slug = extract_slug_from_plan_id(plan_id)
    feature_branch = f"feat/{plan_id}"
    merge_sha = merge_commit_sha.strip()
    if not merge_sha:
        raise ValueError("merge_commit_sha is required.")

    prompt_text = build_coder_prompt(
        plan_id=plan_id,
        plan_path=rel_plan_path,
        merge_commit_sha=merge_sha,
        base_branch=base_branch,
        config=config,
        factory_dir=factory_path,
    )

    if dry_run:
        return TriggerCoderResult(
            plan_id=plan_id,
            slug=slug,
            plan_path=rel_plan_path,
            branch_name=feature_branch,
            merge_commit_sha=merge_sha,
            cursor_agent_id=None,
            cursor_run_id=None,
            cursor_tracking_url=None,
        )

    api_key = cursor_api_key.strip()
    if not api_key:
        msg = "CURSOR_API_KEY is not configured."
        _send_coding_callback(
            repo=repo,
            slug=slug,
            status="FAILED",
            plan_path=rel_plan_path,
            feature_branch=feature_branch,
            merge_commit_sha=merge_sha,
            requirement_id=requirement_id,
            gh_run_id=gh_run_id,
            gh_run_url=run_url or None,
            failure_reason=msg,
        )
        raise CoderTriggerError(msg)

    payload: dict[str, Any] = {
        "name": f"Implement {plan_id}"[:100],
        "prompt": {"text": prompt_text},
        "env": {"type": "cloud"},
        "repos": [{"url": repo_url, "startingRef": merge_sha}],
        "autoCreatePR": True,
    }
    if cursor_model.strip():
        payload["model"] = {"id": cursor_model.strip()}

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    try:
        if http_client is not None:
            resp = http_client.post(
                CURSOR_AGENTS_URL,
                json=payload,
                headers=headers,
                timeout=httpx.Timeout(timeout_sec),
            )
            resp.raise_for_status()
            result = resp.json()
        else:
            with httpx.Client(timeout=httpx.Timeout(timeout_sec)) as client:
                resp = client.post(CURSOR_AGENTS_URL, json=payload, headers=headers)
                resp.raise_for_status()
                result = resp.json()
    except httpx.HTTPStatusError as exc:
        body_snippet = (exc.response.text or "")[:300].replace(api_key, "[REDACTED]")
        err_msg = f"Cursor API error HTTP {exc.response.status_code}: {body_snippet}"
        _send_coding_callback(
            repo=repo,
            slug=slug,
            status="FAILED",
            plan_path=rel_plan_path,
            feature_branch=feature_branch,
            merge_commit_sha=merge_sha,
            requirement_id=requirement_id,
            gh_run_id=gh_run_id,
            gh_run_url=run_url or None,
            failure_reason=err_msg,
        )
        raise CoderTriggerError(err_msg) from exc
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        err_msg = f"Cursor API transport error ({type(exc).__name__})"
        _send_coding_callback(
            repo=repo,
            slug=slug,
            status="FAILED",
            plan_path=rel_plan_path,
            feature_branch=feature_branch,
            merge_commit_sha=merge_sha,
            requirement_id=requirement_id,
            gh_run_id=gh_run_id,
            gh_run_url=run_url or None,
            failure_reason=err_msg,
        )
        raise CoderTriggerError(err_msg) from exc

    agent_id = result.get("id")
    run_id = result.get("runId")
    tracking_url = (
        result.get("url")
        or result.get("trackingUrl")
        or (f"https://cursor.com/agents/{agent_id}" if agent_id else None)
    )

    _send_coding_callback(
        repo=repo,
        slug=slug,
        status="RUNNING",
        plan_path=rel_plan_path,
        feature_branch=feature_branch,
        merge_commit_sha=merge_sha,
        requirement_id=requirement_id,
        gh_run_id=gh_run_id,
        gh_run_url=run_url or None,
        cursor_agent_id=agent_id,
        cursor_run_id=run_id,
        cursor_tracking_url=tracking_url,
    )

    return TriggerCoderResult(
        plan_id=plan_id,
        slug=slug,
        plan_path=rel_plan_path,
        branch_name=feature_branch,
        merge_commit_sha=merge_sha,
        cursor_agent_id=agent_id,
        cursor_run_id=run_id,
        cursor_tracking_url=tracking_url,
    )


def _send_coding_callback(
    repo: str,
    slug: str,
    status: str,
    plan_path: str,
    feature_branch: str,
    merge_commit_sha: str,
    requirement_id: str | None = None,
    gh_run_id: str | None = None,
    gh_run_url: str | None = None,
    cursor_agent_id: str | None = None,
    cursor_run_id: str | None = None,
    cursor_tracking_url: str | None = None,
    failure_reason: str | None = None,
) -> None:
    if "/" not in repo:
        return
    owner, repo_name = repo.split("/", 1)
    payload = CallbackPayload(
        repoOwner=owner,
        repoName=repo_name,
        slug=slug[:40],
        requirementId=requirement_id or None,
        stage="coding",
        status=status,
        planPath=plan_path,
        branchName=feature_branch,
        mergeCommitSha=merge_commit_sha,
        ghRunId=gh_run_id,
        ghRunUrl=gh_run_url,
        cursorAgentId=cursor_agent_id,
        cursorRunId=cursor_run_id,
        cursorTrackingUrl=cursor_tracking_url,
        failureReason=failure_reason,
    )
    try:
        post_workflow_callback(payload)
    except Exception as exc:  # noqa: BLE001
        print(f"[trigger-coder] Warning: callback failed: {exc}")
