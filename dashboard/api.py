"""Obsidian Memory plugin API — serves vault notes and graph data. Supports multiple vaults."""

import json
import os
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

router = APIRouter(tags=["obsidian"])

# ─── Vault discovery ────────────────────────────────────────────────
# Primary vault from env, plus auto-discover sibling .obsidian dirs
_PRIMARY = Path(os.environ.get("OBSIDIAN_VAULT_PATH", "/home/ubuntu/ObsidianVault"))


def _discover_vaults() -> dict[str, Path]:
    """Find all vaults: primary + any with .obsidian in common locations."""
    vaults = {}
    if _PRIMARY.exists():
        vaults[_PRIMARY.name] = _PRIMARY
    # Check parent dir for sibling vaults
    parent = _PRIMARY.parent
    if parent.exists():
        for d in parent.iterdir():
            if d.is_dir() and (d / ".obsidian").exists() and d not in vaults.values():
                vaults[d.name] = d
    # Also check common paths
    for extra in [
        Path.home() / "Documents" / "Obsidian",
        Path.home() / "obsidian-vaults",
        Path.home() / "vaults",
    ]:
        if extra.exists():
            for d in extra.iterdir():
                if d.is_dir() and (d / ".obsidian").exists() and d.name not in vaults:
                    vaults[d.name] = d
    return vaults


VAULTS = _discover_vaults()
DEFAULT_VAULT = _PRIMARY.name if _PRIMARY.name in VAULTS else next(iter(VAULTS), "")


# ─── Models ─────────────────────────────────────────────────────────
class NoteInfo(BaseModel):
    name: str
    path: str
    folder: str
    size: int
    modified: str
    tags: list[str]
    links: list[str]
    backlinks: list[str]
    content: str
    word_count: int


class GraphNode(BaseModel):
    id: str
    label: str
    folder: str
    size: int


class GraphEdge(BaseModel):
    source: str
    target: str


class GraphData(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class NoteUpdate(BaseModel):
    content: str


# ─── Helpers ────────────────────────────────────────────────────────
def _extract_tags(content: str) -> list[str]:
    tags = re.findall(r"#(\w+)", content)
    fm_match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if fm_match:
        fm = fm_match.group(1)
        tag_matches = re.findall(r"tags:\s*\n((?:\s*-\s*\w+\n?)+)", fm)
        for block in tag_matches:
            tags.extend(re.findall(r"-\s*(\w+)", block))
    return list(set(tags))


def _extract_wikilinks(content: str) -> list[str]:
    return list(set(re.findall(r"\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]", content)))


def _scan_vault(vault_path: Path) -> dict[str, NoteInfo]:
    notes = {}
    if not vault_path.exists():
        return notes
    for md_file in vault_path.rglob("*.md"):
        rel = md_file.relative_to(vault_path)
        try:
            content = md_file.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        stat = md_file.stat()
        tags = _extract_tags(content)
        links = _extract_wikilinks(content)
        note = NoteInfo(
            name=md_file.stem,
            path=str(rel),
            folder=str(rel.parent) if str(rel.parent) != "." else "root",
            size=stat.st_size,
            modified=str(stat.st_mtime),
            tags=tags,
            links=links,
            backlinks=[],
            content=content,
            word_count=len(content.split()),
        )
        # Key by vault-relative path, not filename stem. Real vaults often have
        # repeated note names in different folders (README.md, Overview.md,
        # mirrored service/index notes). Stem keys make notes disappear and
        # make clicks open the wrong file.
        notes[str(rel)] = note
    by_stem: dict[str, list[str]] = {}
    for key, note in notes.items():
        by_stem.setdefault(note.name, []).append(key)
    for key, note in notes.items():
        for link in note.links:
            for target in by_stem.get(link, []):
                notes[target].backlinks.append(note.name)
    return notes


# Per-vault cache
_vault_caches: dict[str, dict[str, NoteInfo]] = {}


def _get_vault(vault_name: str) -> dict[str, NoteInfo]:
    if vault_name not in VAULTS:
        raise HTTPException(status_code=404, detail=f"Vault '{vault_name}' not found")
    if vault_name not in _vault_caches or _vault_caches[vault_name] is None:
        _vault_caches[vault_name] = _scan_vault(VAULTS[vault_name])
    return _vault_caches[vault_name]


def _resolve_vault(vault: Optional[str]) -> str:
    return vault or DEFAULT_VAULT


def _resolve_note_key(notes: dict[str, NoteInfo], key: str) -> str:
    """Resolve a note identifier, preferring vault-relative paths."""
    if key in notes:
        return key
    matches = [path for path, note in notes.items() if note.name == key]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise HTTPException(
            status_code=409,
            detail=f"Note name '{key}' is ambiguous; use vault-relative path",
        )
    raise HTTPException(status_code=404, detail=f"Note '{key}' not found")


def invalidate_cache(vault_name: str = None):
    if vault_name:
        _vault_caches[vault_name] = None
    else:
        for k in _vault_caches:
            _vault_caches[k] = None


# ─── Routes ─────────────────────────────────────────────────────────
@router.get("/vaults")
async def list_vaults():
    """List all discovered vaults, with the configured default first."""
    ordered = sorted(
        VAULTS.items(),
        key=lambda item: (0 if item[0] == DEFAULT_VAULT else 1, item[0].lower()),
    )
    return [
        {"name": name, "path": str(path), "note_count": len(_get_vault(name))}
        for name, path in ordered
    ]


@router.get("/notes")
async def list_notes(vault: Optional[str] = Query(None)):
    vault_name = _resolve_vault(vault)
    v = _get_vault(vault_name)
    return [
        {
            "id": n.path, "name": n.name, "path": n.path, "folder": n.folder,
            "size": n.size, "modified": n.modified, "tags": n.tags,
            "link_count": len(n.links), "backlink_count": len(n.backlinks),
            "word_count": n.word_count,
        }
        for n in sorted(v.values(), key=lambda x: x.modified, reverse=True)
    ]


@router.get("/notes/{name:path}")
async def get_note(name: str, vault: Optional[str] = Query(None)):
    vault_name = _resolve_vault(vault)
    v = _get_vault(vault_name)
    key = _resolve_note_key(v, name)
    return v[key].model_dump()


@router.put("/notes/{name:path}")
async def update_note(name: str, body: NoteUpdate, vault: Optional[str] = Query(None)):
    vault_name = _resolve_vault(vault)
    v = _get_vault(vault_name)
    key = _resolve_note_key(v, name)
    note = v[key]
    file_path = VAULTS[vault_name] / note.path
    try:
        file_path.write_text(body.content, encoding="utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    invalidate_cache(vault_name)
    v2 = _get_vault(vault_name)
    if key in v2:
        return v2[key].model_dump()
    return {"status": "ok"}


@router.get("/graph")
async def get_graph(vault: Optional[str] = Query(None)):
    vault_name = _resolve_vault(vault)
    v = _get_vault(vault_name)
    nodes, edges, seen = [], [], set()
    by_stem: dict[str, list[str]] = {}
    for key, note in v.items():
        by_stem.setdefault(note.name, []).append(key)
    for key, note in v.items():
        nodes.append(GraphNode(id=note.path, label=note.name, folder=note.folder, size=max(10, min(40, note.word_count // 10))))
        for link in note.links:
            for target in by_stem.get(link, []):
                ek = tuple(sorted([note.path, target]))
                if ek not in seen:
                    seen.add(ek)
                    edges.append(GraphEdge(source=note.path, target=target))
    return GraphData(nodes=nodes, edges=edges)


@router.get("/folders")
async def list_folders(vault: Optional[str] = Query(None)):
    vault_name = _resolve_vault(vault)
    v = _get_vault(vault_name)
    folders = {}
    for note in v.values():
        folders[note.folder] = folders.get(note.folder, 0) + 1
    return [{"name": f, "count": c} for f, c in sorted(folders.items())]


@router.get("/tags")
async def list_tags(vault: Optional[str] = Query(None)):
    vault_name = _resolve_vault(vault)
    v = _get_vault(vault_name)
    tc: dict[str, int] = {}
    for note in v.values():
        for tag in note.tags:
            tc[tag] = tc.get(tag, 0) + 1
    return [{"tag": t, "count": c} for t, c in sorted(tc.items(), key=lambda x: -x[1])]


@router.post("/refresh")
async def refresh_vault(vault: Optional[str] = Query(None)):
    vault_name = _resolve_vault(vault)
    invalidate_cache(vault_name)
    v = _get_vault(vault_name)
    return {"status": "ok", "vault": vault_name, "notes": len(v)}
