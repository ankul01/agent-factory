"""Offline unit tests for factory_engine.llm using respx."""

from __future__ import annotations

import httpx
import pytest
import respx

from factory_engine.llm import (
    LLMClient,
    LLMError,
    LLMProfilesConfig,
    RouteConfig,
    parse_json_response,
    strip_code_fences,
)
from factory_engine.llm.models import ProfileRoutes


def _make_config(routes: list[RouteConfig], global_timeout_sec: float = 60.0) -> LLMProfilesConfig:
    return LLMProfilesConfig(
        global_timeout_sec=global_timeout_sec,
        profiles={"default": ProfileRoutes(routes=routes)},
    )


def test_strip_code_fences_and_parse_json() -> None:
    raw = '```json\n{"verdict": "APPROVED", "p0": 0}\n```'
    assert strip_code_fences(raw) == '{"verdict": "APPROVED", "p0": 0}'
    assert parse_json_response(raw) == {"verdict": "APPROVED", "p0": 0}

    plain = '{"ok": true}'
    assert parse_json_response(plain) == {"ok": True}


@respx.mock
def test_gemini_adapter_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    route = RouteConfig(
        name="gemini-primary",
        adapter="gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        model="gemini-4-hydrogen",
        api_key_env="GEMINI_API_KEY",
        max_tokens=1024,
        retries=0,
    )
    endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent"
    respx.post(endpoint).mock(
        return_value=httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": "Plan ready"}]}}]},
        )
    )

    client = LLMClient(config=_make_config([route]))
    resp = client.generate(system_prompt="sys", user_prompt="usr")
    assert resp.text == "Plan ready"
    assert resp.route_name == "gemini-primary"
    assert resp.tier_index == 0
    assert resp.attempts == 1


@respx.mock
def test_openai_compat_failover_from_fatal_gemini(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "bad-key")
    monkeypatch.setenv("NVIDIA_API_KEY", "nv-key")

    routes = [
        RouteConfig(
            name="gemini-primary",
            adapter="gemini",
            base_url="https://generativelanguage.googleapis.com/v1beta",
            model="gemini-4-hydrogen",
            api_key_env="GEMINI_API_KEY",
            retries=1,
            backoff_sec=0,
        ),
        RouteConfig(
            name="nvidia-glm",
            adapter="openai_compat",
            base_url="https://integrate.api.nvidia.com/v1",
            model="z-ai/glm-5.3-flash",
            api_key_env="NVIDIA_API_KEY",
            retries=0,
            backoff_sec=0,
        ),
    ]

    gemini_call = respx.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent"
    ).mock(return_value=httpx.Response(401, json={"error": "invalid key"}))

    nvidia_call = respx.post("https://integrate.api.nvidia.com/v1/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={"choices": [{"message": {"content": "Fallback response"}}]},
        )
    )

    client = LLMClient(config=_make_config(routes))
    resp = client.generate(user_prompt="hello")
    assert resp.text == "Fallback response"
    assert resp.route_name == "nvidia-glm"
    assert resp.tier_index == 1
    assert gemini_call.call_count == 1  # fatal 401 fails over immediately without retry
    assert nvidia_call.call_count == 1


@respx.mock
def test_transient_retry_then_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "oa-key")
    route = RouteConfig(
        name="openai-fallback",
        adapter="openai_responses",
        base_url="https://api.openai.com/v1",
        model="gpt-6-luna",
        api_key_env="OPENAI_API_KEY",
        retries=1,
        backoff_sec=0,
    )

    mock_route = respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            httpx.Response(429, text="rate limited"),
            httpx.Response(
                200,
                json={
                    "output": [
                        {
                            "type": "message",
                            "content": [{"type": "output_text", "text": "Recovered"}],
                        }
                    ]
                },
            ),
        ]
    )

    client = LLMClient(config=_make_config([route]))
    resp = client.generate(user_prompt="test")
    assert resp.text == "Recovered"
    assert resp.attempts == 2
    assert mock_route.call_count == 2


@respx.mock
def test_skips_missing_key_and_oversized_prompt_then_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("GROQ_API_KEY", "groq-key")

    routes = [
        RouteConfig(
            name="gemini-missing-key",
            adapter="gemini",
            base_url="https://generativelanguage.googleapis.com/v1beta",
            model="gemini-4-hydrogen",
            api_key_env="GEMINI_API_KEY",
        ),
        RouteConfig(
            name="groq-small",
            adapter="openai_compat",
            base_url="https://api.groq.com/openai/v1",
            model="openai/gpt-oss-120b",
            api_key_env="GROQ_API_KEY",
            max_input_chars=10,
        ),
    ]

    client = LLMClient(config=_make_config(routes))
    with pytest.raises(LLMError, match="All LLM routes failed"):
        client.generate(user_prompt="this prompt exceeds ten characters")


def test_strip_code_fences_removes_think_block() -> None:
    raw = '<think>internal reasoning\nmore thought</think>\n```json\n{"ok": true}\n```'
    assert strip_code_fences(raw) == '{"ok": true}'
    assert parse_json_response(raw) == {"ok": True}


@respx.mock
def test_gemini_adapter_ignores_thought_parts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    route = RouteConfig(
        name="gemini-primary",
        adapter="gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        model="gemini-4-hydrogen",
        api_key_env="GEMINI_API_KEY",
        retries=0,
    )
    endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent"
    respx.post(endpoint).mock(
        return_value=httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {"text": "Thinking process...", "thought": True},
                                {"text": "Final answer"},
                            ]
                        }
                    }
                ]
            },
        )
    )

    client = LLMClient(config=_make_config([route]))
    resp = client.generate(user_prompt="hi")
    assert resp.text == "Final answer"


@respx.mock
def test_model_override_defaults_to_first_route_adapter(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NVIDIA_API_KEY", "nv-key")
    route = RouteConfig(
        name="nvidia-glm",
        adapter="openai_compat",
        base_url="https://integrate.api.nvidia.com/v1",
        model="z-ai/glm-5.3-flash",
        api_key_env="NVIDIA_API_KEY",
        retries=0,
    )
    respx.post("https://integrate.api.nvidia.com/v1/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={"choices": [{"message": {"content": "Override ok"}}]},
        )
    )

    client = LLMClient(config=_make_config([route]))
    resp = client.generate(user_prompt="hi", model_override="custom/unlisted-model")
    assert resp.adapter == "openai_compat"
    assert resp.model == "custom/unlisted-model"
    assert resp.text == "Override ok"
