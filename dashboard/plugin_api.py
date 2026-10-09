"""Obsidian Memory plugin API — serves vault notes, graph, and metadata.

Mounted at ``/api/plugins/obsidian-memory/`` and consumed by both the Hermes
**desktop app** (``desktop/plugin.js`` via ``ctx.rest``) and the web dashboard
(``dashboard/manifest.json``). One backend, two UI surfaces.

Vault discovery is the same for both: the plugin's configured vault roots
(``plugins.entries.obsidian-memory.settings.vault_roots``, one per line)
auto-discovered by looking for a ``.obsidian`` marker directory. The vault path
and any sibling directories are included automatically so a vault added next to
a configured one appears on the next refresh.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter(tags=["obsidian-memory"])

# Default roots scanned when the plugin has no configured vault_roots.
_DEFAULT_ROOTS = (
    "~/Documents/Obsidian",
    "~/obsidian-vaults",
    "~/vaults",
)

# ─── Settings ────────────────────────────────────────────────────────

_CACHED_ROOTS: Optional[tuple[str, ...]] = None


def _configured_roots() -> tuple[str, ...]:
    """Vault roots from plugin settings, falling back to the env var, then defaults.

    Read fresh on every call (cheap dict lookup into the config cache) so a
    settings change in the Desktop settings form takes effect on the next
    refresh without a dashboard restart.
    """
    roots: list[str] = []

    try:
        from hermes_cli.config import load_config
        from hermes_cli.plugins_state import _plugin_settings_entry

        settings = (_plugin_settings_entry(load_config() or {}, "obsidian-memory") or {}).get("settings") or {}
        raw = settings.get("vault_roots") or ""
        if isinstance(raw, str):
            roots.extend(line.strip() for line in raw.splitlines() if line.strip())
    except Exception:
        pass

    env_root = os.environ.get("OBSIDIAN_VAULT_PATH")
    if env_root:
        roots.append(env_root)

    if not roots:
        roots.extend(_DEFAULT_ROOTS)

    seen: set[str] = set()
    ordered: list[str] = []
    for r in roots:
        if r not in seen:
            seen.add(r)
            ordered.append(r)
    return tuple(ordered)


# ─── Vault discovery ─────────────────────────────────────────────────


def _discover_vaults() -> dict[str, Path]:
    """Every directory with an ``.obsidian`` marker, keyed by folder name.

    Each configured root is scanned directly (a root may itself be a vault),
    plus its immediate children, so a vault nested one level under a root is
    found. Name collisions across roots are resolved by suffixing the parent
    directory name, since the UI keys vaults by this name.
    """
    vaults: dict[str, Path] = {}

    def _add(path: Path) -> None:
        name = path.name
        if name in vaults and vaults[name] != path:
            parent = path.parent.name or str(path)
            name = f"{parent}/{path.name}"
        vaults[name] = path

    for raw in _configured_roots():
        root = Path(raw).expanduser()
        try:
            root = root.resolve()
        except OSError:
            continue
        if not root.is_dir():
            continue
        if (root / ".obsidian").is_dir():
            _add(root)
        try:
            children = sorted(p for p in root.iterdir() if p.is_dir())
        except OSError:
            continue
        for child in children:
            if (child / ".obsidian").is_dir():
                try:
                    _add(child.resolve())
                except OSError:
                    _add(child)
    return vaults


# ─── Models ──────────────────────────────────────────────────────────


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


# ─── Helpers ─────────────────────────────────────────────────────────

_TAG_RE = re.compile(r"#(\w+)")
_FM_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)
_FM_TAGS_RE = re.compile(r"tags:\s*(?:\n|\s)\s*((?:-\s*[\w/-]+\s*\n?)+)")
_FM_TAGS_INLINE_RE = re.compile(r"tags:\s*\[([^\]]+)\]")
_WIKILINK_RE = re.compile(r"\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]")


class LinkIndex:
    """Vault link-resolution index: exact paths plus note stems."""

    def __init__(self, notes: dict[str, "NoteInfo"]) -> None:
        self.paths: set[str] = set(notes)
        self.stems: dict[str, list[str]] = {}
        for path, note in notes.items():
            self.stems.setdefault(note.name, []).append(path)

    def resolve(self, link: str) -> list[str]:
        """Resolve one wikilink to vault-relative note paths.

        Obsidian resolves a link by, in order: exact vault-relative path (with or
        without ``.md``), then the note stem anywhere in the vault, then the path
        tail stem. Matching on stem alone loses every ``[[Folder/Note]]`` link.
        """
        link = link.strip()
        if not link:
            return []
        for candidate in (link, f"{link}.md"):
            if candidate in self.paths:
                return [candidate]
        if link in self.stems:
            return self.stems[link]
        tail = link.rsplit("/", 1)[-1]
        return self.stems.get(tail, [])


def _extract_tags(content: str) -> list[str]:
    # Tags run #word only outside code fences/inline code — a '#1a2b3c' hex or a
    # '#' in a code block is not a tag.
    body_lines = []
    in_fence = False
    for line in content.splitlines():
        stripped = line.lstrip()
        if stripped.startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        if not in_fence:
            body_lines.append(re.sub(r"`[^`]*`", "", line))
    body = "\n".join(body_lines)
    tags = _TAG_RE.findall(body)
    fm_match = _FM_RE.match(content)
    if fm_match:
        for block in _FM_TAGS_RE.findall(fm_match.group(1)):
            tags.extend(t.lstrip("- ") for t in block.splitlines() if t.strip())
        # Inline list form: `tags: [a, b]`
        for inline in re.findall(r"tags:\s*\[([^\]]+)\]", fm_match.group(1)):
            tags.extend(t.strip().strip("'\"") for t in inline.split(",") if t.strip())
    return sorted(set(t for t in tags if t))


def _extract_wikilinks(content: str) -> list[str]:
    return list(dict.fromkeys(_WIKILINK_RE.findall(content)))


def _scan_vault(vault_path: Path) -> dict[str, NoteInfo]:
    notes: dict[str, NoteInfo] = {}
    if not vault_path.is_dir():
        return notes
    for md_file in vault_path.rglob("*.md"):
        rel = md_file.relative_to(vault_path)
        try:
            content = md_file.read_text(encoding="utf-8", errors="replace")
            stat = md_file.stat()
        except OSError:
            continue
        note = NoteInfo(
            name=md_file.stem,
            path=rel.as_posix(),
            folder=rel.parent.as_posix() if rel.parent.as_posix() != "." else "root",
            size=stat.st_size,
            modified=str(stat.st_mtime),
            tags=_extract_tags(content),
            links=_extract_wikilinks(content),
            backlinks=[],
            content=content,
            word_count=len(content.split()),
        )
        notes[note.path] = note

    # Backlinks keyed by PATH (not name) — two Beta.md in different folders
    # must not cross-link. LinkIndex resolves [[Beta]], [[Projects/Beta]] and
    # [[Projects/Beta.md]] alike.
    index = LinkIndex(notes)
    for key, note in notes.items():
        for link in note.links:
            for target in index.resolve(link):
                if target != key:
                    notes[target].backlinks.append(note.name)
    return notes


# Per-vault cache, keyed by vault name. Invalidated on writes and refreshes.
_vault_caches: dict[str, Optional[dict[str, NoteInfo]]] = {}
_vault_paths: dict[str, Path] = {}


def _vaults() -> dict[str, Path]:
    """Current vault map — re-discovered when settings change so a new vault
    appears without a restart."""
    global _vault_paths
    if not _vault_paths:
        _vault_paths = _discover_vaults()
    return _vault_paths


def _get_vault(name: str) -> dict[str, NoteInfo]:
    vaults = _vaults()
    if name not in vaults:
        raise HTTPException(status_code=404, detail=f"Vault '{name}' not found")
    cached = _vault_caches.get(name)
    if cached is None:
        cached = _scan_vault(vaults[name])
        _vault_caches[name] = cached
    return cached


def _resolve_vault(vault: Optional[str]) -> str:
    vaults = _vaults()
    if vault and vault in vaults:
        return vault
    return next(iter(vaults), "") if vaults else ""


def _resolve_note_key(notes: dict[str, NoteInfo], key: str) -> str:
    """Resolve a note identifier, preferring vault-relative paths.

    Accepts the path (``Projects/Alpha.md``), path without extension
    (``Projects/Alpha``), bare stem (``Alpha``), or stem with extension
    (``Alpha.md``).
    """
    if key in notes:
        return key
    # Path without / with extension, and bare stem with extension.
    matches = [path for path in notes if path == key or path == f"{key}.md"]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise HTTPException(
            status_code=409,
            detail=f"Note '{key}' is ambiguous; use the vault-relative path",
        )
    matches = [path for path, note in notes.items() if note.name == key or note.name == f"{key}.md"]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise HTTPException(
            status_code=409,
            detail=f"Note name '{key}' is ambiguous; use the vault-relative path",
        )
    # Last resort: a stem+ext key whose stem is unique ('Alpha.md' with no
    # note literally named 'Alpha.md' — matches the note whose name is 'Alpha').
    if key.endswith(".md"):
        stem = key[: -len(".md")]
        matches = [path for path, note in notes.items() if note.name == stem]
        if len(matches) == 1:
            return matches[0]
    raise HTTPException(status_code=404, detail=f"Note '{key}' not found")


def _invalidate(vault_name: Optional[str] = None) -> None:
    if vault_name:
        _vault_caches[vault_name] = None
    else:
        for k in _vault_caches:
            _vault_caches[k] = None


# ─── Routes ──────────────────────────────────────────────────────────


@router.get("/vaults")
async def list_vaults():
    vaults = _vaults()
    out = []
    for name, path in sorted(vaults.items(), key=lambda kv: kv[0].lower()):
        try:
            count = len(_get_vault(name))
        except HTTPException:
            count = 0
        out.append({"name": name, "path": str(path), "note_count": count})
    return out


@router.get("/notes")
async def list_notes(vault: Optional[str] = Query(None)):
    vault_name = _resolve_vault(vault)
    v = _get_vault(vault_name)
    return [
        {
            "id": n.path,
            "name": n.name,
            "path": n.path,
            "folder": n.folder,
            "size": n.size,
            "modified": n.modified,
            "tags": n.tags,
            "link_count": len(n.links),
            "backlink_count": len(n.backlinks),
            "word_count": n.word_count,
        }
        for n in sorted(v.values(), key=lambda x: float(x.modified), reverse=True)
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
    file_path = _vaults()[vault_name] / note.path
    # Containment check: a resolved note path must stay inside the vault root.
    try:
        file_path = file_path.resolve()
        file_path.relative_to(_vaults()[vault_name].resolve())
    except (OSError, ValueError):
        raise HTTPException(status_code=400, detail="Note path escapes the vault root")
    try:
        file_path.write_text(body.content, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    _invalidate(vault_name)
    v2 = _get_vault(vault_name)
    if key in v2:
        return v2[key].model_dump()
    return {"status": "ok"}


@router.get("/graph")
async def get_graph(vault: Optional[str] = Query(None)):
    vault_name = _resolve_vault(vault)
    v = _get_vault(vault_name)
    nodes, edges, seen = [], [], set()
    index = LinkIndex(v)
    for key, note in v.items():
        nodes.append(
            GraphNode(
                id=note.path,
                label=note.name,
                folder=note.folder,
                size=max(10, min(40, note.word_count // 10)),
            )
        )
        for link in note.links:
            for target in index.resolve(link):
                if target == key:
                    continue
                ek = tuple(sorted((note.path, target)))
                if ek not in seen:
                    seen.add(ek)
                    edges.append(GraphEdge(source=note.path, target=target))
    return GraphData(nodes=nodes, edges=edges)


@router.get("/folders")
async def list_folders(vault: Optional[str] = Query(None)):
    vault_name = _resolve_vault(vault)
    v = _get_vault(vault_name)
    folders: dict[str, int] = {}
    for note in v.values():
        folders[note.folder] = folders.get(note.folder, 0) + 1
    return [{"name": f, "count": c} for f, c in sorted(folders.items())]


@router.get("/tags")
async def list_tags(vault: Optional[str] = Query(None)):
    vault_name = _resolve_vault(vault)
    v = _get_vault(vault_name)
    counts: dict[str, int] = {}
    for note in v.values():
        for tag in note.tags:
            counts[tag] = counts.get(tag, 0) + 1
    return [{"tag": t, "count": c} for t, c in sorted(counts.items(), key=lambda x: -x[1])]


@router.post("/refresh")
async def refresh_vault(vault: Optional[str] = Query(None)):
    _invalidate()
    global _vault_paths
    _vault_paths = _discover_vaults()
    _invalidate()
    vault_name = _resolve_vault(vault)
    if not vault_name:
        return {"status": "ok", "vault": "", "notes": 0}
    v = _get_vault(vault_name)
    return {"status": "ok", "vault": vault_name, "notes": len(v)}
