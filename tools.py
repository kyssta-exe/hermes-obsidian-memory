"""Tool handlers — the code that actually runs for each vault tool.

Handler contract, per the Hermes plugin guide:

1. take ``(args: dict, **kwargs)`` — ``args`` is what the model passed;
2. do the work;
3. return a **JSON string**, for success and failure alike;
4. never raise — catch everything and return an error object.

``**kwargs`` is not decoration: the host injects context keywords
(``task_id``, ``session_id``, …) and only forwards the ones the signature
names, so accepting ``**kwargs`` opts a handler into the full, additively
growing context payload.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict

from .vault import AmbiguousNote, NoteNotFound, default_store

logger = logging.getLogger(__name__)

MAX_NOTE_CHARS = 60_000
DEFAULT_LIMIT = 20
MAX_LIMIT = 200


def _ok(**payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _err(message: str, **extra: Any) -> str:
    return json.dumps({"error": message, **extra}, ensure_ascii=False)


def _store_error(exc: Exception) -> str | None:
    """Map a vault exception onto a JSON error, or return None if not one."""
    if isinstance(exc, AmbiguousNote):
        return _err(
            f"'{exc.name}' matches {len(exc.matches)} notes; use one of the full paths.",
            candidates=exc.matches,
        )
    if isinstance(exc, NoteNotFound):
        return _err(
            f"No note matches '{exc.args[0]}'. Use obsidian_search_notes to find the right path."
        )
    if isinstance(exc, KeyError):
        vaults = [entry["name"] for entry in default_store.list_vaults()]
        if not vaults:
            return _err(
                "No Obsidian vault found. Set OBSIDIAN_VAULT_PATH to your vault directory, "
                "or run obsidian_list_vaults after creating a vault."
            )
        return _err(f"Vault '{exc.args[0]}' not found.", available_vaults=vaults)
    if isinstance(exc, FileExistsError):
        return _err(
            f"Note '{exc.args[0]}' already exists. Read it first, then pass its content "
            "back to overwrite it."
        )
    if isinstance(exc, OSError):
        return _err(f"Filesystem error: {exc}")
    return None


def _clamp_limit(raw: Any) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    return max(1, min(MAX_LIMIT, value))


def list_vaults(args: Dict[str, Any], **kwargs: Any) -> str:
    """Report every discovered vault."""
    try:
        vaults = default_store.list_vaults()
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("obsidian_list_vaults failed")
        return _err(f"Vault discovery failed: {exc}")
    if not vaults:
        return _err(
            "No Obsidian vault found. Set OBSIDIAN_VAULT_PATH to your vault directory, "
            "or pass a vault name to the other obsidian tools."
        )
    return _ok(vaults=vaults, default=default_store.default_vault)


def search_notes(args: Dict[str, Any], **kwargs: Any) -> str:
    """Search or filter notes, returning metadata only."""
    args = args or {}
    try:
        limit = _clamp_limit(args.get("limit", DEFAULT_LIMIT))
        notes = default_store.list_notes(
            vault_name=(args.get("vault") or None),
            query=str(args.get("query") or ""),
            folder=str(args.get("folder") or ""),
            tag=str(args.get("tag") or "").lstrip("#"),
        )
    except Exception as exc:
        mapped = _store_error(exc)
        if mapped:
            return mapped
        logger.exception("obsidian_search_notes failed")
        return _err(f"Search failed: {exc}")

    total = len(notes)
    return _ok(
        vault=default_store.resolve_vault(args.get("vault") or None),
        total=total,
        returned=min(total, limit),
        truncated=total > limit,
        notes=[note.summary() for note in notes[:limit]],
    )


def read_note(args: Dict[str, Any], **kwargs: Any) -> str:
    """Read one note in full."""
    args = args or {}
    identifier = str(args.get("note") or args.get("path") or args.get("name") or "").strip()
    if not identifier:
        return _err("'note' is required — pass a vault-relative path or a note title.")
    try:
        note = default_store.get_note(args.get("vault") or None, identifier)
    except Exception as exc:
        mapped = _store_error(exc)
        if mapped:
            return mapped
        logger.exception("obsidian_read_note failed")
        return _err(f"Read failed: {exc}")

    content = note.content
    truncated = len(content) > MAX_NOTE_CHARS
    payload = note.full()
    if truncated:
        payload["content"] = content[:MAX_NOTE_CHARS]
        payload["truncated"] = True
        payload["truncated_at_chars"] = MAX_NOTE_CHARS
    return _ok(**payload)


def write_note(args: Dict[str, Any], **kwargs: Any) -> str:
    """Create or overwrite a note."""
    args = args or {}
    note_path = str(args.get("note") or args.get("path") or "").strip()
    if not note_path:
        return _err("'note' is required — pass a vault-relative path, e.g. \"Notes/Ideas.md\".")
    if "content" not in args or args.get("content") is None:
        return _err("'content' is required — the full markdown body of the note.")
    content = str(args["content"])
    vault = args.get("vault") or None

    try:
        existed = True
        try:
            default_store.resolve_key(vault, note_path)
        except (NoteNotFound, AmbiguousNote):
            existed = False
        if existed:
            note = default_store.write_note(vault, note_path, content)
        else:
            note = default_store.create_note(vault, note_path, content)
    except Exception as exc:
        mapped = _store_error(exc)
        if mapped:
            return mapped
        logger.exception("obsidian_write_note failed")
        return _err(f"Write failed: {exc}")

    return _ok(
        status="updated" if existed else "created",
        note=note.summary(),
        word_count=note.word_count,
    )


# name -> handler, paired with the schemas module in __init__.py
HANDLERS = {
    "obsidian_list_vaults": list_vaults,
    "obsidian_search_notes": search_notes,
    "obsidian_read_note": read_note,
    "obsidian_write_note": write_note,
}
