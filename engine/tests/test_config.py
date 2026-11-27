"""Offline unit tests for factory_engine.config."""

from __future__ import annotations

from pathlib import Path

import pytest

from factory_engine.config import FactoryConfig, load_config


def test_load_config_defaults_when_missing(tmp_path: Path) -> None:
    cfg = load_config(tmp_path)
    assert cfg == FactoryConfig()
    assert cfg.archetype == "general"
    assert cfg.deploy_lane is None
    assert cfg.health_path is None
    assert cfg.test_command is None
    assert cfg.protected_paths == [".github/workflows/**"]
    assert cfg.plan_dir == "docs/plans"


def test_load_config_defaults_when_empty(tmp_path: Path) -> None:
    (tmp_path / ".agent-factory.yml").write_text("   \n", encoding="utf-8")
    cfg = load_config(tmp_path)
    assert cfg == FactoryConfig()


def test_load_config_partial_override(tmp_path: Path) -> None:
    (tmp_path / ".agent-factory.yml").write_text(
        "archetype: frontend-next\nhealth_path: /api/health\n",
        encoding="utf-8",
    )
    cfg = load_config(tmp_path)
    assert cfg.archetype == "frontend-next"
    assert cfg.health_path == "/api/health"
    assert cfg.deploy_lane is None
    assert cfg.test_command is None
    assert cfg.protected_paths == [".github/workflows/**"]
    assert cfg.plan_dir == "docs/plans"


def test_load_config_full_override(tmp_path: Path) -> None:
    (tmp_path / ".agent-factory.yml").write_text(
        """
archetype: python-fastapi
deploy_lane: fly
health_path: /healthz
test_command: pytest -q
protected_paths:
  - docs/plans/**
  - .github/workflows/**
plan_dir: specs/plans
""".lstrip(),
        encoding="utf-8",
    )
    cfg = load_config(tmp_path)
    assert cfg.archetype == "python-fastapi"
    assert cfg.deploy_lane == "fly"
    assert cfg.health_path == "/healthz"
    assert cfg.test_command == "pytest -q"
    assert cfg.protected_paths == ["docs/plans/**", ".github/workflows/**"]
    assert cfg.plan_dir == "specs/plans"


def test_load_config_rejects_non_mapping(tmp_path: Path) -> None:
    (tmp_path / ".agent-factory.yml").write_text("- item1\n- item2\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Expected YAML mapping"):
        load_config(tmp_path)
