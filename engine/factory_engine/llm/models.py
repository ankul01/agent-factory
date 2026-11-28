"""Pydantic models and default waterfall profiles for the LLM client."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

AdapterName = Literal["gemini", "openai_compat", "openai_responses"]


class RouteConfig(BaseModel):
    """Single provider route configuration in an LLM waterfall."""

    name: str
    adapter: AdapterName
    base_url: str
    model: str
    api_key_env: str
    timeout_sec: float = Field(default=120.0, gt=0)
    retries: int = Field(default=1, ge=0)
    backoff_sec: float = Field(default=10.0, ge=0)
    max_input_chars: int | None = Field(default=None, gt=0)
    max_tokens: int | None = Field(default=None, gt=0)


class LLMResponse(BaseModel):
    """Result returned by a successful LLM invocation."""

    text: str
    route_name: str
    adapter: str
    model: str
    tier_index: int
    elapsed_sec: float
    attempts: int


class ProfileRoutes(BaseModel):
    """Wrapper matching `llm_profiles.json` profile structure."""

    routes: list[RouteConfig]


class LLMProfilesConfig(BaseModel):
    """Top-level LLM waterfall configuration."""

    global_timeout_sec: float = Field(default=540.0, gt=0)
    profiles: dict[str, ProfileRoutes]


def _default_routes(max_tokens: int) -> list[RouteConfig]:
    return [
        RouteConfig(
            name="gemini-hydrogen",
            adapter="gemini",
            base_url="https://generativelanguage.googleapis.com/v1beta",
            model="gemini-4-hydrogen",
            api_key_env="GEMINI_API_KEY",
            max_tokens=max_tokens,
            timeout_sec=120.0,
            retries=1,
            backoff_sec=15.0,
        ),
        RouteConfig(
            name="nvidia-glm",
            adapter="openai_compat",
            base_url="https://integrate.api.nvidia.com/v1",
            model="z-ai/glm-5.3-flash",
            api_key_env="NVIDIA_API_KEY",
            max_tokens=max_tokens,
            timeout_sec=90.0,
            retries=1,
            backoff_sec=10.0,
        ),
        RouteConfig(
            name="nvidia-minimax",
            adapter="openai_compat",
            base_url="https://integrate.api.nvidia.com/v1",
            model="minimaxai/minimax-m3.1-flash",
            api_key_env="NVIDIA_API_KEY",
            max_tokens=max_tokens,
            timeout_sec=90.0,
            retries=1,
            backoff_sec=10.0,
        ),
        RouteConfig(
            name="nvidia-nemotron",
            adapter="openai_compat",
            base_url="https://integrate.api.nvidia.com/v1",
            model="nvidia/nemotron-3-ultra-550b-a55b",
            api_key_env="NVIDIA_API_KEY",
            max_tokens=max_tokens,
            timeout_sec=90.0,
            retries=1,
            backoff_sec=10.0,
        ),
        RouteConfig(
            name="gemini-flash",
            adapter="gemini",
            base_url="https://generativelanguage.googleapis.com/v1beta",
            model="gemini-3.8-flash",
            api_key_env="GEMINI_API_KEY",
            max_tokens=max_tokens,
            timeout_sec=120.0,
            retries=1,
            backoff_sec=10.0,
        ),
        RouteConfig(
            name="groq-oss",
            adapter="openai_compat",
            base_url="https://api.groq.com/openai/v1",
            model="openai/gpt-oss-120b",
            api_key_env="GROQ_API_KEY",
            max_input_chars=20000,
            max_tokens=max_tokens,
            timeout_sec=120.0,
            retries=1,
            backoff_sec=10.0,
        ),
        RouteConfig(
            name="openai-fallback",
            adapter="openai_responses",
            base_url="https://api.openai.com/v1",
            model="gpt-6-luna",
            api_key_env="OPENAI_API_KEY",
            max_tokens=max_tokens,
            timeout_sec=120.0,
            retries=1,
            backoff_sec=10.0,
        ),
    ]


DEFAULT_PROFILES_CONFIG = LLMProfilesConfig(
    global_timeout_sec=540.0,
    profiles={
        "planner": ProfileRoutes(routes=_default_routes(8192)),
        "reviewer": ProfileRoutes(routes=_default_routes(4096)),
        "default": ProfileRoutes(routes=_default_routes(8192)),
    },
)
