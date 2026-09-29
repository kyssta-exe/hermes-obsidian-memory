"""Obsidian Memory — dashboard backend.

FastAPI routes for the dashboard tab, mounted by the host under
``/api/plugins/obsidian-memory/``.

The host loads this file with ``importlib.util.spec_from_file_location`` and no
package context, so a plain relative import of the plugin's ``vault`` module
cannot resolve. Load it by path instead — that keeps one implementation of the
vault logic shared with the agent-side tools in ``__init__.py``.

Routes are mounted once at dashboard startup, so a plugin change needs a
restart (``hermes dashboard``), not a rescan. Static JS/CSS are picked up by
``GET /api/dashboard/plugins/rescan``.
"""

import importlib.util
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

# ``api.py`` lives in <plugin>/dashboard/, so the shared module is one level up.
_PLUGIN_ROOT = Path(__file__).resolve().parent.parent


def _load_vault_module():
    """Import ``<plugin>/vault.py``, preferring an already-loaded copy.

    When the agent-side plugin is also enabled, Hermes has imported the same
    file as ``hermes_plugins.obsidian_memory.vault``. Reusing it keeps one
    module (and one ``default_store`` cache) in the process instead of two
    independent copies that can disagree. Otherwise fall back to a path-based
    import, which is all that is available when the dashboard is running
    without the agent plugin.
    """
    for name, module in list(sys.modules.items()):
        if module is not None and name.endswith(".vault") and name.startswith("hermes_plugins."):
            if getattr(module, "VaultStore", None) is not None:
                return module
    module_name = "obsidian_memory_vault"
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(module_name, _PLUGIN_ROOT / "vault.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load vault module from {_PLUGIN_ROOT / 'vault.py'}")
    module = importlib.util.module_from_spec(spec)
    # Registered before exec so dataclasses/pydantic can resolve annotations.
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(module_name, None)
        raise
    return module


_vault = _load_vault_module()
_VaultStore = _vault.VaultStore
_AmbiguousNote = _vault.AmbiguousNote
_NoteNotFound = _vault.NoteNotFound

# One store for the dashboard process: discovery walks the filesystem, so a
# fresh one per request would re-scan the home directory on every call.
store = _VaultStore()

router = APIRouter(tags=["obsidian"])


def _resolve(vault: Optional[str], identifier: Optional[str] = None):
    """Run a vault lookup, translating vault exceptions into HTTP responses.

    Ambiguity is a 409 with the candidate paths rather than a 404, so the UI
    can tell "wrong path" apart from "several notes share that title".
    """
    try:
        if identifier is None:
            return store.notes(vault)
        return store.get_note(vault, identifier)
    except _AmbiguousNote as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error": f"Note '{exc.name}' matches {len(exc.matches)} notes; use a full path.",
                "candidates": exc.matches,
            },
        ) from exc
    except _NoteNotFound as exc:
        raise HTTPException(status_code=404, detail=f"Note '{exc.args[0]}' not found") from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Vault '{exc.args[0]}' not found") from exc


@router.get("/vaults")
async def list_vaults(refresh: bool = Query(False, description="Re-run vault discovery")):
    """Every discovered vault, default first, with note counts."""
    if refresh:
        store.refresh_discovery()
    try:
        return store.list_vaults()
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Vault '{exc.args[0]}' not found") from exc


@router.get("/notes")
async def list_notes(
    vault: Optional[str] = Query(None),
    q: Optional[str] = Query(None, description="Match name, path or content"),
    folder: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
):
    """Note metadata for the sidebar list — no note bodies."""
    _resolve(vault)  # 404 on an unknown vault before touching the store
    notes = store.list_notes(vault_name=vault, query=q or "", folder=folder or "", tag=(tag or "").lstrip("#"))
    return [note.summary() for note in notes]


@router.get("/folders")
async def list_folders(vault: Optional[str] = Query(None)):
    _resolve(vault)
    return store.folders(vault)


@router.get("/tags")
async def list_tags(vault: Optional[str] = Query(None)):
    _resolve(vault)
    return store.tags(vault)


@router.get("/graph")
async def get_graph(vault: Optional[str] = Query(None)):
    _resolve(vault)
    return store.graph(vault)


@router.get("/notes/{name:path}")
async def get_note(name: str, vault: Optional[str] = Query(None)):
    """One note in full, including tags, outgoing links and backlinks."""
    return _resolve(vault, name).full()


@router.put("/notes/{name:path}")
async def update_note(name: str, content: str = Query(..., description="New markdown body"), vault: Optional[str] = Query(None)):
    """Overwrite a note's body.

    Content arrives as a query parameter rather than a JSON body: URLs are
    bounded by the browser and the proxy, and a long note in a URL is a
    reliable way to fail a save on a large vault. The dashboard client
    therefore PUTs with a text/plain body — see ``plugin.js``.
    """
    _resolve(vault, name)
    try:
        return store.write_note(vault, name, content).full()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/notes")
async def create_note(
    name: str = Query(..., description="Vault-relative path for the new note"),
    content: str = Query("", description="Initial markdown body"),
    vault: Optional[str] = Query(None),
):
    """Create a new note. 409 when the path is already taken."""
    try:
        return store.create_note(vault, name, content).full()
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=f"Note '{exc.args[0]}' already exists") from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Vault '{exc.args[0]}' not found") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/refresh")
async def refresh(vault: Optional[str] = Query(None), rediscover: bool = Query(False)):
    """Drop the scan cache (and optionally re-run discovery) after an external edit."""
    if rediscover:
        store.refresh_discovery()
    else:
        _resolve(vault)
        store.invalidate(vault)
    notes = _resolve(vault)
    return {"status": "ok", "vault": store.resolve_vault(vault), "notes": len(notes)}
