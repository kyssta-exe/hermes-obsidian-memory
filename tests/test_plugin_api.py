"""Tests for the obsidian-memory plugin API.

Runs the real ``dashboard/plugin_api.py`` router through FastAPI's TestClient
against synthetic vault fixtures — no mocking of the scan/link/backlink logic,
which is where the bugs live.
"""

from __future__ import annotations

import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from dashboard import plugin_api

FIXTURE = {
    "TestVault/.obsidian/workspace.json": "{}",
    "TestVault/Projects/Alpha.md": (
        "---\ntags:\n  - project\n  - active\n---\n"
        "# Alpha\n\nLinks to [[Beta]] and [[Daily/2026-01-01]].\n\n"
        "- [x] done\n- [ ] todo\n\n"
        "```python\n# not a #tag\nprint('hi')\n```\n"
    ),
    "TestVault/Projects/Beta.md": "# Beta\nRelated to [[Alpha]].\n",
    "TestVault/Projects/Gamma.md": "# Gamma\nAlso about [[Alpha]].\n",
    "TestVault/Daily/2026-01-01.md": "# Daily 2026-01-01\nWorked on [[Projects/Alpha]].\n",
    "TestVault/Inbox.md": "# Inbox\nInline tag #quick and #todo.\n",
    "SecondVault/.obsidian/workspace.json": "{}",
    "SecondVault/Other.md": "# Second\n",
}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    for rel, content in FIXTURE.items():
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    monkeypatch.setenv("OBSIDIAN_VAULT_PATH", str(tmp_path))
    plugin_api._invalidate()
    plugin_api._vault_paths.clear()

    app = FastAPI()
    app.include_router(plugin_api.router, prefix="/api/plugins/obsidian-memory")
    with TestClient(app) as c:
        yield c

    plugin_api._invalidate()
    plugin_api._vault_paths.clear()


# ── Vaults ───────────────────────────────────────────────────────────


def test_discovers_both_vaults(client):
    vaults = client.get("/api/plugins/obsidian-memory/vaults").json()
    assert {v["name"] for v in vaults} == {"TestVault", "SecondVault"}


# ── Notes ────────────────────────────────────────────────────────────


def test_lists_notes(client):
    notes = client.get("/api/plugins/obsidian-memory/notes?vault=TestVault").json()
    assert {n["path"] for n in notes} == {
        "Projects/Alpha.md",
        "Projects/Beta.md",
        "Projects/Gamma.md",
        "Daily/2026-01-01.md",
        "Inbox.md",
    }


def test_note_by_path(client):
    note = client.get("/api/plugins/obsidian-memory/notes/Projects/Alpha.md?vault=TestVault").json()
    assert note["name"] == "Alpha"
    assert note["folder"] == "Projects"


def test_tags_exclude_code_fences(client):
    note = client.get("/api/plugins/obsidian-memory/notes/Projects/Alpha.md?vault=TestVault").json()
    assert set(note["tags"]) == {"project", "active"}


def test_inline_tags(client):
    note = client.get("/api/plugins/obsidian-memory/notes/Inbox.md?vault=TestVault").json()
    assert set(note["tags"]) == {"quick", "todo"}


def test_wikilinks_extracted(client):
    note = client.get("/api/plugins/obsidian-memory/notes/Projects/Alpha.md?vault=TestVault").json()
    assert set(note["links"]) == {"Beta", "Daily/2026-01-01"}


# ── Backlinks ────────────────────────────────────────────────────────


def test_backlinks_resolve_path_links(client):
    """[[Daily/2026-01-01]] must resolve to the daily note, not vanish."""
    alpha = client.get("/api/plugins/obsidian-memory/notes/Projects/Alpha.md?vault=TestVault").json()
    assert set(alpha["backlinks"]) == {"2026-01-01", "Beta", "Gamma"}


def test_backlinks_resolve_path_form(client):
    """[[Projects/Alpha]] resolves to Alpha, so Alpha is a backlink of the
    daily note."""
    daily = client.get("/api/plugins/obsidian-memory/notes/Daily/2026-01-01.md?vault=TestVault").json()
    assert daily["backlinks"] == ["Alpha"]


def test_backlinks_are_per_note(client):
    beta = client.get("/api/plugins/obsidian-memory/notes/Projects/Beta.md?vault=TestVault").json()
    assert beta["backlinks"] == ["Alpha"]


def test_same_stem_notes_do_not_crosslink(client, tmp_path):
    archive = tmp_path / "TestVault" / "Archive"
    archive.mkdir(parents=True)
    (archive / "Beta.md").write_text("# Beta archive copy\n", encoding="utf-8")
    plugin_api._invalidate()

    projects = client.get("/api/plugins/obsidian-memory/notes/Projects/Beta.md?vault=TestVault").json()
    assert projects["folder"] == "Projects"
    assert "Alpha" in projects["backlinks"]

    archived = client.get("/api/plugins/obsidian-memory/notes/Archive/Beta.md?vault=TestVault").json()
    assert archived["folder"] == "Archive"


# ── Note resolution ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    "form",
    ["Projects/Alpha.md", "Projects/Alpha", "Alpha", "Alpha.md"],
)
def test_note_resolution_forms(client, form):
    r = client.get(f"/api/plugins/obsidian-memory/notes/{form}?vault=TestVault")
    assert r.status_code == 200
    assert r.json()["name"] == "Alpha"


def test_unknown_note_404(client):
    assert client.get("/api/plugins/obsidian-memory/notes/nope.md?vault=TestVault").status_code == 404


def test_cross_vault_note_404(client):
    assert client.get("/api/plugins/obsidian-memory/notes/Projects/Alpha.md?vault=SecondVault").status_code == 404


# ── Graph ────────────────────────────────────────────────────────────


def test_graph_edges_include_path_links(client):
    graph = client.get("/api/plugins/obsidian-memory/graph?vault=TestVault").json()
    pairs = {tuple(sorted((e["source"], e["target"]))) for e in graph["edges"]}
    assert ("Daily/2026-01-01.md", "Projects/Alpha.md") in pairs
    assert ("Projects/Alpha.md", "Projects/Beta.md") in pairs
    assert ("Projects/Alpha.md", "Projects/Gamma.md") in pairs
    assert len(graph["nodes"]) == 5


# ── Folders / tags ───────────────────────────────────────────────────


def test_folders(client):
    folders = client.get("/api/plugins/obsidian-memory/folders?vault=TestVault").json()
    assert {f["name"] for f in folders} == {"Projects", "Daily", "root"}


def test_tags(client):
    tags = client.get("/api/plugins/obsidian-memory/tags?vault=TestVault").json()
    assert {t["tag"] for t in tags} == {"project", "active", "quick", "todo"}


# ── Writes ───────────────────────────────────────────────────────────


def test_put_note_round_trip(client, tmp_path):
    r = client.put(
        "/api/plugins/obsidian-memory/notes/Projects/Beta.md?vault=TestVault",
        json={"content": "# Beta edited\nNow links to [[Alpha]] and [[Gamma]].\n"},
    )
    assert r.status_code == 200
    assert "edited" in r.json()["content"]

    on_disk = (tmp_path / "TestVault" / "Projects" / "Beta.md").read_text(encoding="utf-8")
    assert "edited" in on_disk


def test_put_updates_backlinks(client):
    client.put(
        "/api/plugins/obsidian-memory/notes/Projects/Beta.md?vault=TestVault",
        json={"content": "# Beta\nLinks to [[Alpha]] and [[Gamma]].\n"},
    )
    gamma = client.get("/api/plugins/obsidian-memory/notes/Projects/Gamma.md?vault=TestVault").json()
    assert "Beta" in gamma["backlinks"]


# ── Refresh ──────────────────────────────────────────────────────────


def test_refresh_picks_up_new_vault(client, tmp_path):
    new_vault = tmp_path / "ThirdVault"
    (new_vault / ".obsidian").mkdir(parents=True)
    (new_vault / "Fresh.md").write_text("# Fresh\n", encoding="utf-8")

    r = client.post("/api/plugins/obsidian-memory/refresh")
    assert r.status_code == 200

    vaults = {v["name"] for v in client.get("/api/plugins/obsidian-memory/vaults").json()}
    assert "ThirdVault" in vaults


# ── Vault isolation ──────────────────────────────────────────────────


def test_vault_isolation(client):
    notes = client.get("/api/plugins/obsidian-memory/notes?vault=SecondVault").json()
    assert len(notes) == 1
    assert notes[0]["name"] == "Other"
