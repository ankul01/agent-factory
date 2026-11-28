"""Loads archetype skills and optional stage prompt overrides with graceful fallback."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class PromptBundle:
    """Resolved skill and stage prompt texts."""

    archetype_skill: str = ""
    stage_prompt: str = ""


def _read_optional(path: Path) -> str:
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    return ""


def load_prompts(
    factory_dir: Path | str,
    archetype: str,
    stage: str,
) -> PromptBundle:
    """
    Load `<factory-dir>/skills/<archetype>.md` and optional
    `<factory-dir>/.agent-factory/prompts/<stage>.md`, falling back to empty
    strings when either file is absent.
    """
    base = Path(factory_dir)
    skill_text = _read_optional(base / "skills" / f"{archetype}.md")
    stage_text = _read_optional(base / ".agent-factory" / "prompts" / f"{stage}.md")
    return PromptBundle(archetype_skill=skill_text, stage_prompt=stage_text)
