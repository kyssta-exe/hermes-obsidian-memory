"""Obsidian Memory — registration.

Wires the vault tool schemas to their handlers and ships a bundled skill, so
one install gives the user both the dashboard tab (see ``dashboard/``) and
agent-side access to the same vault.

The host imports this module by file location under
``hermes_plugins.obsidian_memory`` with this directory as the package path, so
relative imports of the sibling modules resolve normally.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import List

from . import schemas, tools

logger = logging.getLogger(__name__)

TOOLSET = "obsidian"
SKILL_DIRNAME = "obsidian-vault"

PLUGIN_DIR = Path(__file__).resolve().parent


def _register_tools(ctx) -> int:
    """Register every vault tool. Returns how many took."""
    registered = 0
    for schema in schemas.ALL_SCHEMAS:
        handler = tools.HANDLERS.get(schema["name"])
        if handler is None:  # pragma: no cover - schemas/handlers drift
            logger.warning("Obsidian Memory: no handler for tool %r", schema["name"])
            continue
        try:
            if ctx.register_tool(
                name=schema["name"],
                toolset=TOOLSET,
                schema=schema,
                handler=handler,
                description=schema["description"],
                emoji="📓",
            ) is not None:
                registered += 1
        except Exception as exc:
            # A rejected name collision must not take the whole plugin down —
            # register() is called once at startup and a crash here disables
            # every other tool and the skill with it.
            logger.warning("Obsidian Memory: tool %r not registered: %s", schema["name"], exc)
    return registered


def _register_skills(ctx) -> List[str]:
    """Register every ``skills/<name>/SKILL.md`` shipped in this plugin.

    Plugin skills are read-only and namespaced: they resolve as
    ``obsidian-memory:<name>`` through ``skill_view`` and never enter
    ``~/.hermes/skills/``, so they cannot collide with a built-in skill.
    """
    skills_root = PLUGIN_DIR / "skills"
    if not skills_root.is_dir():
        return []
    registered: List[str] = []
    for child in sorted(skills_root.iterdir()):
        skill_md = child / "SKILL.md"
        if not (child.is_dir() and skill_md.is_file()):
            continue
        try:
            ctx.register_skill(child.name, skill_md)
        except Exception as exc:
            logger.warning("Obsidian Memory: skill %r not registered: %s", child.name, exc)
            continue
        registered.append(child.name)
    return registered


def register(ctx) -> None:
    """Entry point called exactly once by the plugin manager at startup."""
    tool_count = _register_tools(ctx)
    skill_names = _register_skills(ctx)
    if not tool_count and not skill_names:
        logger.warning("Obsidian Memory: nothing registered — check for name collisions")
        return
    logger.info(
        "Obsidian Memory ready: %d tool(s)%s",
        tool_count,
        f", skills {', '.join(skill_names)}" if skill_names else "",
    )
