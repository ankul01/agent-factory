"""Reusable GitHub REST API and `gh` CLI wrapper."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

import httpx


class GitHubClient:
    """Thin wrapper around the GitHub REST API and `gh` CLI."""

    def __init__(
        self,
        repo: str | None = None,
        token: str | None = None,
        base_url: str = "https://api.github.com",
        timeout_sec: float = 30.0,
    ) -> None:
        self.repo = repo or os.environ.get("GH_REPO") or os.environ.get("GITHUB_REPOSITORY", "")
        self.token = (
            token
            or os.environ.get("GH_TOKEN")
            or os.environ.get("GITHUB_TOKEN", "")
        ).strip()
        self.base_url = base_url.rstrip("/")
        self.timeout_sec = timeout_sec

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def get_pull_request(self, pr_number: int) -> dict[str, Any]:
        """Fetch pull request metadata from the GitHub REST API."""
        url = f"{self.base_url}/repos/{self.repo}/pulls/{pr_number}"
        with httpx.Client(timeout=httpx.Timeout(self.timeout_sec)) as client:
            resp = client.get(url, headers=self._headers())
            resp.raise_for_status()
            return resp.json()

    def get_pr_diff(self, pr_number: int) -> str:
        """Fetch the unified diff for a pull request."""
        url = f"{self.base_url}/repos/{self.repo}/pulls/{pr_number}"
        headers = self._headers()
        headers["Accept"] = "application/vnd.github.v3.diff"
        with httpx.Client(timeout=httpx.Timeout(self.timeout_sec)) as client:
            resp = client.get(url, headers=headers)
            resp.raise_for_status()
            return resp.text

    def create_pull_request(
        self,
        title: str,
        body: str,
        head: str,
        base: str = "main",
    ) -> dict[str, Any]:
        """Open a new pull request via the GitHub REST API."""
        url = f"{self.base_url}/repos/{self.repo}/pulls"
        payload = {"title": title, "body": body, "head": head, "base": base}
        with httpx.Client(timeout=httpx.Timeout(self.timeout_sec)) as client:
            resp = client.post(url, json=payload, headers=self._headers())
            resp.raise_for_status()
            return resp.json()

    def comment_on_pr(self, pr_number: int, body: str) -> dict[str, Any]:
        """Post an issue comment on a pull request."""
        url = f"{self.base_url}/repos/{self.repo}/issues/{pr_number}/comments"
        with httpx.Client(timeout=httpx.Timeout(self.timeout_sec)) as client:
            resp = client.post(url, json={"body": body}, headers=self._headers())
            resp.raise_for_status()
            return resp.json()

    def run_gh(
        self,
        args: list[str],
        cwd: Path | str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        """Execute a `gh` CLI subcommand with `GH_TOKEN` and `GH_REPO` configured."""
        env = os.environ.copy()
        if self.token:
            env["GH_TOKEN"] = self.token
        if self.repo:
            env["GH_REPO"] = self.repo
        return subprocess.run(
            ["gh", *args],
            cwd=cwd,
            env=env,
            check=True,
            text=True,
            capture_output=True,
        )
