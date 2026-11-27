"""Configuration loader for target repositories (.agent-factory.yml)."""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, Field

CONFIG_FILENAME = ".agent-factory.yml"


class FactoryConfig(BaseModel):
    """Schema for `.agent-factory.yml` with safe defaults."""

    archetype: str = "general"
    deploy_lane: str | None = None
    health_path: str | None = None
    test_command: str | None = None
    protected_paths: list[str] = Field(default_factory=lambda: [".github/workflows/**"])
    plan_dir: str = "docs/plans"


def load_config(target_dir: Path | str) -> FactoryConfig:
    """Load `.agent-factory.yml` from `target_dir`, returning defaults if missing or empty."""
    config_path = Path(target_dir) / CONFIG_FILENAME
    if not config_path.is_file():
        return FactoryConfig()

    raw_text = config_path.read_text(encoding="utf-8")
    if not raw_text.strip():
        return FactoryConfig()

    data = yaml.safe_load(raw_text)
    if data is None:
        return FactoryConfig()
    if not isinstance(data, dict):
        raise ValueError(f"Expected YAML mapping in {config_path}, got {type(data).__name__}")

    return FactoryConfig.model_validate(data)
