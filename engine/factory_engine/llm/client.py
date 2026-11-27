"""Unified multi-provider LLM client with waterfall failover and JSON helpers."""

from __future__ import annotations

import abc
import json
import os
import random
import re
import time
from pathlib import Path
from typing import Any

import httpx

from factory_engine.llm.models import (
    DEFAULT_PROFILES_CONFIG,
    AdapterName,
    LLMProfilesConfig,
    LLMResponse,
    RouteConfig,
)

_TRANSIENT_CODES = {429, 500, 502, 503, 504}
_FATAL_CODES = {400, 401, 403, 404, 410}

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
_FENCE_RE = re.compile(
    r"^\s*```(?:[a-zA-Z0-9_-]+)?\s*\n?(.*?)\n?\s*```\s*$",
    re.DOTALL,
)


class LLMError(RuntimeError):
    """Raised when an LLM invocation fails across all configured routes."""


def strip_code_fences(text: str) -> str:
    """Strip `<think>...</think>` blocks and enclosing markdown code fences if present."""
    stripped = _THINK_RE.sub("", text).strip()
    match = _FENCE_RE.match(stripped)
    if match:
        return match.group(1).strip()
    return stripped


def parse_json_response(text: str) -> Any:
    """Strip markdown code fences from an LLM response and parse it as JSON."""
    cleaned = strip_code_fences(text)
    return json.loads(cleaned)


def _is_transient(status_code: int) -> bool:
    return status_code in _TRANSIENT_CODES or 500 <= status_code < 600


class ProviderAdapter(abc.ABC):
    """Abstract base; each concrete class handles one provider API shape."""

    @abc.abstractmethod
    def invoke(
        self,
        client: httpx.Client,
        route: RouteConfig,
        api_key: str,
        system_prompt: str,
        user_prompt: str,
        timeout_sec: float,
    ) -> str:
        """Call the provider and return generated text, or raise."""


class GeminiAdapter(ProviderAdapter):
    """Calls `{base_url}/models/{model}:generateContent`."""

    def invoke(
        self,
        client: httpx.Client,
        route: RouteConfig,
        api_key: str,
        system_prompt: str,
        user_prompt: str,
        timeout_sec: float,
    ) -> str:
        url = f"{route.base_url.rstrip('/')}/models/{route.model}:generateContent"
        payload: dict[str, Any] = {
            "contents": [{"parts": [{"text": user_prompt}]}],
        }
        if system_prompt:
            payload["systemInstruction"] = {"parts": [{"text": system_prompt}]}
        if route.max_tokens is not None:
            payload["generationConfig"] = {"maxOutputTokens": route.max_tokens}

        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        }
        resp = client.post(url, json=payload, headers=headers, timeout=httpx.Timeout(timeout_sec))
        resp.raise_for_status()
        result = resp.json()

        candidates = result.get("candidates", [])
        if not candidates:
            raise ValueError("Gemini returned no candidates")
        parts = (candidates[0].get("content") or {}).get("parts") or []
        text = "\n".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
        if not text:
            raise ValueError("Gemini returned empty text")
        return text


class OpenAICompatAdapter(ProviderAdapter):
    """Calls `{base_url}/chat/completions` (NVIDIA NIM, Groq, OpenAI-compatible)."""

    def invoke(
        self,
        client: httpx.Client,
        route: RouteConfig,
        api_key: str,
        system_prompt: str,
        user_prompt: str,
        timeout_sec: float,
    ) -> str:
        url = f"{route.base_url.rstrip('/')}/chat/completions"
        messages: list[dict[str, str]] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": user_prompt})

        payload: dict[str, Any] = {"model": route.model, "messages": messages}
        if route.max_tokens is not None:
            payload["max_tokens"] = route.max_tokens

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }
        resp = client.post(url, json=payload, headers=headers, timeout=httpx.Timeout(timeout_sec))
        resp.raise_for_status()
        result = resp.json()

        choices = result.get("choices", [])
        if not choices:
            raise ValueError("OpenAI-compat returned no choices")
        text = ((choices[0].get("message") or {}).get("content") or "").strip()
        if not text:
            raise ValueError("OpenAI-compat returned empty content")
        return text


class OpenAIResponsesAdapter(ProviderAdapter):
    """Calls `{base_url}/responses` and extracts `output_text` chunks."""

    def invoke(
        self,
        client: httpx.Client,
        route: RouteConfig,
        api_key: str,
        system_prompt: str,
        user_prompt: str,
        timeout_sec: float,
    ) -> str:
        url = f"{route.base_url.rstrip('/')}/responses"
        payload: dict[str, Any] = {
            "model": route.model,
            "input": user_prompt,
        }
        if system_prompt:
            payload["instructions"] = system_prompt
        if route.max_tokens is not None:
            payload["max_output_tokens"] = route.max_tokens

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }
        resp = client.post(url, json=payload, headers=headers, timeout=httpx.Timeout(timeout_sec))
        resp.raise_for_status()
        result = resp.json()

        chunks: list[str] = []
        for item in result.get("output", []):
            if isinstance(item, dict):
                for block in item.get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "output_text":
                        chunks.append(block.get("text", ""))
        text = "".join(chunks).strip()
        if not text:
            text = str(result.get("output_text", "")).strip()
        if not text:
            raise ValueError("OpenAI Responses API returned empty output_text")
        return text


ADAPTERS: dict[AdapterName, type[ProviderAdapter]] = {
    "gemini": GeminiAdapter,
    "openai_compat": OpenAICompatAdapter,
    "openai_responses": OpenAIResponsesAdapter,
}


class LLMClient:
    """Multi-provider LLM client with waterfall failover, retries, and explicit timeouts."""

    def __init__(
        self,
        config: LLMProfilesConfig | None = None,
        config_path: Path | str | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        if config is not None:
            self._config = config
        elif config_path is not None:
            raw = json.loads(Path(config_path).read_text(encoding="utf-8"))
            self._config = LLMProfilesConfig.model_validate(raw)
        else:
            self._config = DEFAULT_PROFILES_CONFIG
        self._external_client = http_client

    def _get_routes(self, profile: str) -> tuple[list[RouteConfig], float]:
        if profile not in self._config.profiles:
            available = list(self._config.profiles.keys())
            raise LLMError(f"Profile '{profile}' not found. Available: {available}")
        routes = list(self._config.profiles[profile].routes)
        if not routes:
            raise LLMError(f"Profile '{profile}' has no routes configured.")
        return routes, self._config.global_timeout_sec

    @staticmethod
    def _build_override_route(
        model: str,
        adapter: AdapterName,
        base_url: str,
        api_key_env: str,
        max_tokens: int | None = None,
    ) -> RouteConfig:
        return RouteConfig(
            name=f"override-{model}",
            adapter=adapter,
            base_url=base_url,
            model=model,
            api_key_env=api_key_env,
            timeout_sec=120.0,
            retries=1,
            backoff_sec=10.0,
            max_tokens=max_tokens,
        )

    def generate(
        self,
        profile: str = "default",
        system_prompt: str = "",
        user_prompt: str = "",
        model_override: str | None = None,
        adapter_override: AdapterName | None = None,
        base_url_override: str | None = None,
        api_key_env_override: str | None = None,
    ) -> LLMResponse:
        """Invoke the LLM waterfall for `profile` and return the first successful response."""
        routes, global_timeout = self._get_routes(profile)

        if model_override:
            matched = next((r for r in routes if r.model == model_override), None)
            override_adapter: AdapterName = adapter_override or (
                matched.adapter if matched else routes[0].adapter
            )
            override_base_url = base_url_override or (
                matched.base_url if matched else routes[0].base_url
            )
            override_key_env = api_key_env_override or (
                matched.api_key_env if matched else routes[0].api_key_env
            )
            override_max_tokens = (
                matched.max_tokens if matched else (4096 if profile == "reviewer" else 8192)
            )
            routes = [
                self._build_override_route(
                    model=model_override,
                    adapter=override_adapter,
                    base_url=override_base_url,
                    api_key_env=override_key_env,
                    max_tokens=override_max_tokens,
                )
            ]

        global_deadline = time.monotonic() + global_timeout
        attempt_log: list[str] = []

        if self._external_client is not None:
            return self._run_waterfall(
                self._external_client,
                profile,
                routes,
                system_prompt,
                user_prompt,
                global_deadline,
                attempt_log,
            )

        with httpx.Client() as client:
            return self._run_waterfall(
                client,
                profile,
                routes,
                system_prompt,
                user_prompt,
                global_deadline,
                attempt_log,
            )

    def _run_waterfall(
        self,
        client: httpx.Client,
        profile: str,
        routes: list[RouteConfig],
        system_prompt: str,
        user_prompt: str,
        global_deadline: float,
        attempt_log: list[str],
    ) -> LLMResponse:
        for tier_index, route in enumerate(routes):
            api_key = os.environ.get(route.api_key_env, "").strip()
            if not api_key:
                attempt_log.append(f"[SKIP] {route.name}: {route.api_key_env} not configured")
                continue

            total_chars = len(system_prompt) + len(user_prompt)
            if route.max_input_chars is not None and total_chars > route.max_input_chars:
                attempt_log.append(
                    f"[SKIP] {route.name}: prompt length {total_chars} "
                    f"exceeds max_input_chars {route.max_input_chars}"
                )
                continue

            if time.monotonic() >= global_deadline:
                attempt_log.append(f"[SKIP] {route.name}: global_timeout_sec exhausted")
                break

            adapter_cls = ADAPTERS.get(route.adapter)
            if adapter_cls is None:
                attempt_log.append(f"[SKIP] {route.name}: unknown adapter '{route.adapter}'")
                continue

            adapter = adapter_cls()
            route_start = time.monotonic()
            last_error = ""

            for attempt in range(route.retries + 1):
                attempts = attempt + 1
                remaining = global_deadline - time.monotonic()
                if remaining <= 0:
                    last_error = "global timeout expired"
                    break

                effective_timeout = min(route.timeout_sec, remaining)
                try:
                    text = adapter.invoke(
                        client=client,
                        route=route,
                        api_key=api_key,
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        timeout_sec=effective_timeout,
                    )
                    elapsed = time.monotonic() - route_start
                    return LLMResponse(
                        text=text,
                        route_name=route.name,
                        adapter=route.adapter,
                        model=route.model,
                        tier_index=tier_index,
                        elapsed_sec=elapsed,
                        attempts=attempts,
                    )
                except httpx.HTTPStatusError as exc:
                    code = exc.response.status_code
                    snippet = (exc.response.text or "")[:300]
                    last_error = f"HTTP {code}: {snippet}"
                    if code in _FATAL_CODES:
                        break
                    if _is_transient(code) and attempt < route.retries:
                        self._sleep_backoff(route.backoff_sec, attempt, global_deadline)
                    else:
                        break
                except (httpx.TimeoutException, httpx.TransportError) as exc:
                    last_error = f"{type(exc).__name__}: {exc}"
                    if attempt < route.retries:
                        self._sleep_backoff(route.backoff_sec, attempt, global_deadline)
                    else:
                        break
                except Exception as exc:  # noqa: BLE001
                    last_error = f"{type(exc).__name__}: {exc}"
                    break

            attempt_log.append(
                f"[TRIED] {route.name} ({route.adapter}/{route.model}): {last_error}"
            )

        summary = "\n  ".join(attempt_log)
        raise LLMError(f"All LLM routes failed for profile '{profile}'.\n  {summary}")

    @staticmethod
    def _sleep_backoff(backoff_sec: float, attempt: int, global_deadline: float) -> None:
        if backoff_sec <= 0:
            return
        delay = backoff_sec * (2**attempt) + random.uniform(0, 2)
        delay = min(delay, global_deadline - time.monotonic())
        if delay > 0:
            time.sleep(delay)


LLMRouter = LLMClient
