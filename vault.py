"""Shared Obsidian vault logic for the Obsidian Memory plugin.

Pure standard library, no Hermes imports, so the same code backs both surfaces
of this plugin:

* the agent-side tool handlers (``tools.py``), imported normally as
  ``hermes_plugins.obsidian_memory.vault``;
* the dashboard backend (``dashboard/api.py``), which the host loads by file
  location with ``importlib.util.spec_from_file_location`` — no package
  context — and therefore pulls this module in through an explicit
  path-based import.

Keep it dependency-free: adding a third-party import here would put the
dashboard's startup-time ``exec_module`` on a package that may not be present
in the host environment.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

__all__ = [
    "Note",
    "AmbiguousNote",
    "NoteNotFound",
    "VaultStore",
    "default_store",
]

# Directories that never contain user notes and would otherwise dominate a
# graph render or a search result set.
_SKIP_DIRS = {".obsidian", ".trash", ".git", ".stfolder", "node_modules"}

# A vault is any directory carrying Obsidian's config folder.
_MARKER = ".obsidian"

_WIKILINK_RE = re.compile(r"\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]")
_INLINE_TAG_RE = re.compile(r"(?<![\w/])#([A-Za-z][\w-]*)")
_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---", re.DOTALL)


class NoteNotFound(KeyError):
    """A note identifier did not resolve to a file in the vault."""


class AmbiguousNote(LookupError):
    """A bare note name matched several files; the caller must use a path."""

    def __init__(self, name: str, matches: List[str]) -> None:
        super().__init__(name)
        self.name = name
        self.matches = matches


@dataclass
class Note:
    """One markdown note, keyed in a vault by its vault-relative path.

    ``path`` rather than the filename stem is the identity: real vaults repeat
    names across folders (``README.md`` in several services, mirrored
    ``index`` notes), and stem keys make notes vanish or open the wrong file.
    """

    name: str
    path: str
    folder: str
    size: int
    modified: float
    tags: List[str] = field(default_factory=list)
    links: List[str] = field(default_factory=list)
    backlinks: List[str] = field(default_factory=list)
    content: str = ""
    word_count: int = 0

    def summary(self) -> Dict[str, object]:
        """Metadata only — never the full note body."""
        return {
            "name": self.name,
            "path": self.path,
            "folder": self.folder,
            "size": self.size,
            "modified": self.modified,
            "tags": self.tags,
            "link_count": len(self.links),
            "backlink_count": len(self.backlinks),
            "word_count": self.word_count,
        }

    def full(self) -> Dict[str, object]:
        data = self.summary()
        data["links"] = self.links
        data["backlinks"] = self.backlinks
        data["content"] = self.content
        return data


def _frontmatter_block(content: str) -> str:
    match = _FRONTMATTER_RE.match(content)
    return match.group(1) if match else ""


def extract_tags(content: str) -> List[str]:
    """Tags from YAML frontmatter plus inline ``#tags`` in the body.

    Frontmatter is parsed loosely: a block list, a comma/space separated
    scalar, and an inline ``[a, b]`` array are all accepted, because all three
    appear in real vaults and a strict parser silently drops the first two.
    """
    found: List[str] = []
    frontmatter = _frontmatter_block(content)
    if frontmatter:
        lines = frontmatter.splitlines()
        for index, line in enumerate(lines):
            match = re.match(r"^\s*tags?\s*:\s*(.*)$", line, re.IGNORECASE)
            if not match:
                continue
            raw = match.group(1).strip()
            if raw.startswith("[") and raw.endswith("]"):
                found.extend(re.findall(r"[A-Za-z][\w-]*", raw[1:-1]))
                continue
            if raw and not raw.startswith("#"):
                # `tags: project, urgent` / `tags: project urgent`
                found.extend(re.findall(r"[A-Za-z][\w-]*", raw))
                continue
            # Otherwise the value is a block list: the `- item` lines that
            # follow, until the indentation stops.
            found.extend(_frontmatter_list_items(lines, index))
    # Inline tags only from the body, so a `# heading` never becomes a tag.
    body = content[len(frontmatter) + 6 :] if frontmatter else content
    found.extend(_INLINE_TAG_RE.findall(body))
    seen: Dict[str, None] = {}
    for tag in found:
        seen.setdefault(tag, None)
    return list(seen)


def _frontmatter_list_items(lines: List[str], header_index: int) -> List[str]:
    """Collect the ``- item`` entries of a block list under ``lines[header_index]``."""
    items: List[str] = []
    for line in lines[header_index + 1:]:
        item = re.match(r"^\s*-\s*(.+?)\s*$", line)
        if item:
            items.append(item.group(1).strip().lstrip("#"))
            continue
        if line.strip() and not line.startswith((" ", "\t")):
            break  # dedented back to another frontmatter key
    return items


def extract_wikilinks(content: str) -> List[str]:
    """Wikilink targets, with any ``|alias`` and ``#heading`` suffix stripped."""
    targets: Dict[str, None] = {}
    for raw in _WIKILINK_RE.findall(content):
        target = raw.split("#", 1)[0].split("^", 1)[0].strip()
        if target:
            targets.setdefault(target, None)
    return list(targets)


def _default_primary() -> Path:
    configured = os.environ.get("OBSIDIAN_VAULT_PATH", "").strip()
    return Path(configured) if configured else Path.home() / "ObsidianVault"


def discover_vaults() -> Dict[str, Path]:
    """Every vault we can find, keyed by its directory name.

    The primary vault comes first in discovery order, then its siblings, then
    the well-known locations. A vault is only auto-discovered when it carries
    an ``.obsidian`` directory, except for the primary one — an explicitly
    configured path is honoured even before Obsidian has written its config.
    """
    primary = _default_primary()
    found: Dict[str, Path] = {}

    def _add(path: Path) -> None:
        if path.is_dir() and path not in found.values():
            found[path.name] = path

    if primary.is_dir():
        found[primary.name] = primary

    # Siblings of the primary vault — the usual multi-vault layout.
    if primary.parent.is_dir():
        for sibling in sorted(primary.parent.iterdir()):
            if sibling.is_dir() and (sibling / _MARKER).is_dir():
                _add(sibling)

    for container in (
        Path.home() / "Documents" / "Obsidian",
        Path.home() / "obsidian-vaults",
        Path.home() / "vaults",
    ):
        if container.is_dir():
            for candidate in sorted(container.iterdir()):
                if candidate.is_dir() and (candidate / _MARKER).is_dir():
                    _add(candidate)

    return found


def _iter_markdown(vault: Path):
    for md_file in vault.rglob("*.md"):
        try:
            relative_parts = md_file.relative_to(vault).parts
        except ValueError:  # pragma: no cover - rglob stays under vault
            continue
        if any(part in _SKIP_DIRS or part.startswith(".") for part in relative_parts[:-1]):
            continue
        yield md_file


def scan_vault(vault_path: Path) -> Dict[str, Note]:
    """Read every note in a vault and wire up link/backlink edges."""
    notes: Dict[str, Note] = {}
    if not vault_path.is_dir():
        return notes

    for md_file in _iter_markdown(vault_path):
        try:
            content = md_file.read_text(encoding="utf-8", errors="replace")
            stat = md_file.stat()
        except OSError:
            continue
        relative = md_file.relative_to(vault_path)
        parent = str(relative.parent)
        notes[str(relative)] = Note(
            name=md_file.stem,
            path=str(relative),
            folder=parent if parent != "." else "root",
            size=stat.st_size,
            modified=stat.st_mtime,
            tags=extract_tags(content),
            links=extract_wikilinks(content),
            content=content,
            word_count=len(content.split()),
        )

    by_name: Dict[str, List[str]] = {}
    for key, note in notes.items():
        by_name.setdefault(note.name, []).append(key)
    for key, note in notes.items():
        for link in note.links:
            for target in by_name.get(link, []):
                # Backlinks are the *referring note's path*, not its name, so
                # a reader can open the exact file even when several folders
                # hold notes with the same title.
                notes[target].backlinks.append(note.path)
    return notes


class VaultStore:
    """Vault discovery plus a per-vault scan cache.

    Scans are memoised because they read every note in the vault; the cache is
    dropped explicitly after a write and by :meth:`refresh`.
    """

    def __init__(self) -> None:
        self._vaults: Dict[str, Path] = discover_vaults()
        self._default = self._pick_default()
        self._caches: Dict[str, Optional[Dict[str, Note]]] = {}

    # ─── discovery ────────────────────────────────────────────────────
    @property
    def vaults(self) -> Dict[str, Path]:
        return dict(self._vaults)

    @property
    def default_vault(self) -> str:
        return self._default

    def _pick_default(self) -> str:
        if not self._vaults:
            return ""
        primary_name = _default_primary().name
        if primary_name in self._vaults:
            return primary_name
        return next(iter(sorted(self._vaults, key=str.lower)))

    def refresh_discovery(self) -> None:
        self._vaults = discover_vaults()
        self._default = self._pick_default()
        self.invalidate()

    def resolve_vault(self, name: Optional[str]) -> str:
        return name or self._default

    def vault_path(self, name: Optional[str]) -> Path:
        vault_name = self.resolve_vault(name)
        if vault_name not in self._vaults:
            raise KeyError(vault_name)
        return self._vaults[vault_name]

    def list_vaults(self) -> List[Dict[str, object]]:
        ordered = sorted(
            self._vaults.items(),
            key=lambda item: (0 if item[0] == self._default else 1, item[0].lower()),
        )
        return [
            {"name": name, "path": str(path), "note_count": len(self.notes(name))}
            for name, path in ordered
        ]

    # ─── cache ────────────────────────────────────────────────────────
    def invalidate(self, vault_name: Optional[str] = None) -> None:
        if vault_name is None:
            self._caches.clear()
        else:
            self._caches[vault_name] = None

    def notes(self, vault_name: Optional[str] = None) -> Dict[str, Note]:
        name = self.resolve_vault(vault_name)
        if name not in self._vaults:
            raise KeyError(name)
        cached = self._caches.get(name, "unset")
        if cached == "unset" or cached is None:
            cached = scan_vault(self._vaults[name])
            self._caches[name] = cached
        return cached

    # ─── lookups ──────────────────────────────────────────────────────
    def resolve_key(self, vault_name: Optional[str], identifier: str) -> str:
        """Resolve a vault-relative path, or a unique bare note name.

        Raises:
            AmbiguousNote: the bare name matches more than one file.
            NoteNotFound: nothing matched.
        """
        notes = self.notes(vault_name)
        identifier = (identifier or "").strip().lstrip("/")
        if identifier in notes:
            return identifier
        if not identifier:
            raise NoteNotFound(identifier)
        # Tolerate callers that pass "notes/Foo.md" against a vault whose
        # notes live elsewhere, and "Foo.md" against a vault keyed by path.
        with_suffix = identifier if identifier.endswith(".md") else f"{identifier}.md"
        matches = [key for key in notes if key == with_suffix or key.endswith(f"/{with_suffix}")]
        if len(matches) == 1:
            return matches[0]
        stem_matches = [key for key, note in notes.items() if note.name == identifier or note.name == Path(identifier).stem]
        if len(stem_matches) == 1:
            return stem_matches[0]
        if len(stem_matches) > 1:
            raise AmbiguousNote(identifier, sorted(stem_matches))
        raise NoteNotFound(identifier)

    def get_note(self, vault_name: Optional[str], identifier: str) -> Note:
        return self.notes(vault_name)[self.resolve_key(vault_name, identifier)]

    def write_note(self, vault_name: Optional[str], identifier: str, content: str) -> Note:
        key = self.resolve_key(vault_name, identifier)
        name = self.resolve_vault(vault_name)
        target = self._vaults[name] / key
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        self.invalidate(name)
        return self.notes(name)[key]

    def create_note(self, vault_name: Optional[str], relative_path: str, content: str = "") -> Note:
        name = self.resolve_vault(vault_name)
        if name not in self._vaults:
            raise KeyError(name)
        key = relative_path if relative_path.endswith(".md") else f"{relative_path}.md"
        target = self._vaults[name] / key
        if target.exists():
            raise FileExistsError(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        self.invalidate(name)
        return self.notes(name)[key]

    # ─── derived views ────────────────────────────────────────────────
    def list_notes(
        self,
        vault_name: Optional[str] = None,
        query: str = "",
        folder: str = "",
        tag: str = "",
    ) -> List[Note]:
        notes = list(self.notes(vault_name).values())
        if folder:
            notes = [n for n in notes if n.folder == folder or n.path.startswith(f"{folder}/")]
        if tag:
            notes = [n for n in notes if tag in n.tags]
        if query:
            needle = query.lower()
            notes = [
                n
                for n in notes
                if needle in n.name.lower()
                or needle in n.path.lower()
                or needle in n.content.lower()
            ]
        notes.sort(key=lambda n: n.modified, reverse=True)
        return notes

    def folders(self, vault_name: Optional[str] = None) -> List[Dict[str, object]]:
        counts: Dict[str, int] = {}
        for note in self.notes(vault_name).values():
            counts[note.folder] = counts.get(note.folder, 0) + 1
        return [{"name": name, "count": count} for name, count in sorted(counts.items())]

    def tags(self, vault_name: Optional[str] = None) -> List[Dict[str, object]]:
        counts: Dict[str, int] = {}
        for note in self.notes(vault_name).values():
            for tag in note.tags:
                counts[tag] = counts.get(tag, 0) + 1
        return [
            {"tag": tag, "count": count}
            for tag, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
        ]

    def graph(self, vault_name: Optional[str] = None) -> Dict[str, List[Dict[str, object]]]:
        notes = self.notes(vault_name)
        by_name: Dict[str, List[str]] = {}
        for key, note in notes.items():
            by_name.setdefault(note.name, []).append(key)

        nodes = [
            {
                "id": note.path,
                "label": note.name,
                "folder": note.folder,
                "size": max(10, min(40, note.word_count // 10)),
            }
            for note in notes.values()
        ]
        edges: List[Dict[str, str]] = []
        seen = set()
        for note in notes.values():
            for link in note.links:
                for target in by_name.get(link, []):
                    edge_key = (note.path, target) if note.path <= target else (target, note.path)
                    if edge_key in seen:
                        continue
                    seen.add(edge_key)
                    edges.append({"source": edge_key[0], "target": edge_key[1]})
        return {"nodes": nodes, "edges": edges}


# One process-wide store: discovery walks the filesystem, so a fresh one per
# request would re-scan the home directory on every dashboard call.
default_store = VaultStore()
