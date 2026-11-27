"""Orchestrator callback client for `/api/callbacks/workflow`."""

from __future__ import annotations

import os
from typing import Any, Literal

import httpx
from pydantic import BaseModel

StageName = Literal["plan", "coding", "review", "deploy"]


class CallbackPayload(BaseModel):
    """Payload accepted by Agent Factory's `/api/callbacks/workflow` endpoint."""

    repoOwner: str
    repoName: str
    slug: str
    stage: StageName
    status: str
    requirementId: str | None = None
    ghRunId: str | None = None
    ghRunUrl: str | None = None
    planPath: str | None = None
    branchName: str | None = None
    prNumber: int | None = None
    prUrl: str | None = None
    mergeCommitSha: str | None = None
    openQuestionsCount: int | None = None
    modelUsed: str | None = None
    cursorAgentId: str | None = None
    cursorRunId: str | None = None
    cursorTrackingUrl: str | None = None
    testStatus: Literal["PENDING", "PASSED", "FAILED"] | None = None
    verdict: Literal["PENDING", "APPROVED", "CHANGES_REQUESTED"] | None = None
    p0Count: int | None = None
    p1Count: int | None = None
    commentUrl: str | None = None
    releaseTag: str | None = None
    releaseUrl: str | None = None
    commitSha: str | None = None
    smokeTestStatus: Literal["PENDING", "PASSED", "FAILED", "SKIPPED"] | None = None
    failureReason: str | None = None


def _resolve_callback_url(callback_url: str | None) -> str:
    url = (callback_url or os.environ.get("FACTORY_CALLBACK_URL", "")).strip()
    if url:
        return url
    orchestrator_url = os.environ.get("ORCHESTRATOR_URL", "").strip().rstrip("/")
    if not orchestrator_url:
        return ""
    if orchestrator_url.endswith("/api/callbacks/workflow"):
        return orchestrator_url
    return f"{orchestrator_url}/api/callbacks/workflow"


def post_workflow_callback(
    payload: CallbackPayload,
    callback_url: str | None = None,
    secret: str | None = None,
    timeout_sec: float = 15.0,
    http_client: httpx.Client | None = None,
) -> dict[str, Any] | None:
    """
    Post stage progress to the Agent Factory orchestrator callback endpoint.

    Returns the parsed JSON response, or `None` if `callback_url` or `secret` is
    not configured (allowing standalone repo runs without an orchestrator).
    """
    url = _resolve_callback_url(callback_url)
    token = (secret or os.environ.get("ORCHESTRATOR_CALLBACK_SECRET", "")).strip()
    if not url or not token:
        return None

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }
    body = payload.model_dump(exclude_none=True)

    if http_client is not None:
        resp = http_client.post(url, json=body, headers=headers, timeout=httpx.Timeout(timeout_sec))
        resp.raise_for_status()
        return resp.json()

    with httpx.Client(timeout=httpx.Timeout(timeout_sec)) as client:
        resp = client.post(url, json=body, headers=headers)
        resp.raise_for_status()
        return resp.json()
