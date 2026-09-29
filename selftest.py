"""End-to-end check of the Obsidian Memory plugin.

Builds a sample vault in a temp dir, then exercises vault.py, the agent-side
tool handlers and the dashboard router against it. Run with:

    python3 selftest.py

Not shipped with the plugin — a repo-level check that the code paths actually
work, not merely that they import.
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent
FAILURES = []


def check(label, condition, detail=""):
    status = "ok  " if condition else "FAIL"
    if not condition:
        FAILURES.append(f"{label}: {detail}")
    print(f"  [{status}] {label}" + (f" — {detail}" if detail and not condition else ""))


def build_vault(root: Path) -> Path:
    vault = root / "TestVault"
    (vault / ".obsidian").mkdir(parents=True)
    (vault / "Notes").mkdir()
    (vault / "Projects" / "Apollo").mkdir(parents=True)
    (vault / "Archive").mkdir()

    (vault / "Index.md").write_text(
        "---\ntags:\n  - hub\n  - index\n---\n"
        "# Index\n\nStart at [[Status]] or [[Projects/Apollo/Plan]].\n"
        "Inline tag #roadmap here.\n",
        encoding="utf-8",
    )
    (vault / "Notes" / "Status.md").write_text(
        "---\ntags: [shipped, q3]\n---\n"
        "# Status\n\nWe shipped v1. See [[Index]] and [[Plan]].\n\n"
        "- [x] auth\n- [ ] billing\n",
        encoding="utf-8",
    )
    (vault / "Projects" / "Apollo" / "Plan.md").write_text(
        "# Plan\n\nApollo plan. Links to [[Status]].\n\n"
        "| Step | Owner |\n| --- | --- |\n| auth | kyssta |\n",
        encoding="utf-8",
    )
    (vault / "Archive" / "Old.md").write_text(
        "# Old\n\nAn archived note about billing history.\n", encoding="utf-8"
    )
    # Duplicate basename in another folder: the ambiguity case.
    (vault / "Notes" / "README.md").write_text("# Notes readme\n", encoding="utf-8")
    (vault / "Archive" / "README.md").write_text("# Archive readme\n", encoding="utf-8")
    # Noise that must be skipped.
    (vault / ".obsidian" / "workspace.md").write_text("# noise [[Status]]\n", encoding="utf-8")
    return vault


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main():
    tmp = Path(tempfile.mkdtemp(prefix="obsidian-selftest-"))
    vault = build_vault(tmp)
    os.environ["OBSIDIAN_VAULT_PATH"] = str(vault)
    os.environ["HOME"] = str(tmp)  # keep real ~/Documents lookups out of it

    print("\n== vault.py ==")
    vault_mod = load_module("obsidian_selftest_vault", REPO / "vault.py")
    store = vault_mod.VaultStore()
    check("discovers the primary vault", store.default_vault == "TestVault",
          f"got {store.default_vault}")
    notes = store.notes()
    check("skips .obsidian internals", "Index.md" in notes and len(notes) == 6,
          f"{len(notes)} notes: {sorted(notes)}")

    index = notes["Index.md"]
    check("frontmatter list tags parsed", set(index.tags) >= {"hub", "index"},
          f"tags={index.tags}")
    check("inline tag parsed", "roadmap" in index.tags, f"tags={index.tags}")
    check("heading not treated as a tag", "Start" not in index.tags, f"tags={index.tags}")
    status = notes["Notes/Status.md"]
    check("inline frontmatter array tags parsed", set(status.tags) == {"shipped", "q3"},
          f"tags={status.tags}")
    check("backlinks are vault-relative paths",
          "Index.md" in status.backlinks and "Projects/Apollo/Plan.md" in status.backlinks,
          f"backlinks={status.backlinks}")
    check("tags never include a path separator", all("/" not in t for t in index.tags),
          f"tags={index.tags}")

    check("resolves by exact path", store.resolve_key(None, "Notes/Status.md") == "Notes/Status.md")
    check("resolves by stem-when-unique", store.resolve_key(None, "Index") == "Index.md")
    check("resolves by .md suffix", store.resolve_key(None, "Notes/Status.md") == "Notes/Status.md")
    try:
        store.resolve_key(None, "README")
        check("duplicate basename raises AmbiguousNote", False, "no exception raised")
    except vault_mod.AmbiguousNote as exc:
        check("duplicate basename raises AmbiguousNote", len(exc.matches) == 2, str(exc.matches))

    found = store.list_notes(query="billing")
    check("full-text search hits bodies", len(found) == 2, f"{[n.path for n in found]}")
    check("folder filter is prefix-inclusive",
          [n.path for n in store.list_notes(folder="Projects")] == ["Projects/Apollo/Plan.md"])
    check("tag filter works", [n.path for n in store.list_notes(tag="q3")] == ["Notes/Status.md"])

    graph = store.graph()
    check("graph edges deduplicated", len(graph["edges"]) == len(
        {(min(e["source"], e["target"]), max(e["source"], e["target"])) for e in graph["edges"]}))
    check("graph links Status", any("Notes/Status.md" in (e["source"], e["target"])
                                    for e in graph["edges"]), str(graph["edges"]))

    print("\n== tools.py ==")
    # tools.py uses a relative import, so give it a package context.
    pkg = tmp / "om_plugin"
    pkg.mkdir()
    for name in ("vault.py", "tools.py", "schemas.py"):
        shutil.copy(REPO / name, pkg / name)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    sys.path.insert(0, str(tmp))
    from om_plugin import tools  # noqa: E402
    from om_plugin import schemas  # noqa: E402

    res = json.loads(tools.list_vaults({}))
    check("list_vaults returns the vault", res["default"] == "TestVault", json.dumps(res)[:200])

    res = json.loads(tools.search_notes({"query": "apollo", "limit": 5}))
    check("search tool returns metadata without bodies",
          res["notes"] and "content" not in res["notes"][0], json.dumps(res)[:200])

    res = json.loads(tools.read_note({"note": "Index.md"}))
    check("read tool returns content", "# Index" in res["content"], res.get("error", ""))
    check("read tool returns path-keyed backlinks", "Notes/Status.md" in res["backlinks"],
          str(res.get("backlinks")))

    res = json.loads(tools.read_note({"note": "README"}))
    check("ambiguous read returns candidates", "candidates" in res, json.dumps(res)[:200])
    check("ambiguous read is a clean error, not a crash", "error" in res)

    res = json.loads(tools.write_note({"note": "Notes/Fresh.md", "content": "# Fresh\n"}))
    check("write creates a new note", res.get("status") == "created", json.dumps(res)[:200])
    check("created note hits disk", (vault / "Notes" / "Fresh.md").exists())
    res = json.loads(tools.write_note({"note": "Notes/Fresh.md", "content": "# Fresh 2\n"}))
    check("write updates an existing note", res.get("status") == "updated", json.dumps(res)[:200])
    res = json.loads(tools.read_note({"note": "Notes/Fresh.md"}))
    check("update is readable back", "# Fresh 2" in res["content"], res.get("error", ""))

    res = json.loads(tools.read_note({"note": "Nope.md"}))
    check("missing note returns guidance", "obsidian_search_notes" in res.get("error", ""),
          json.dumps(res)[:200])
    res = json.loads(tools.read_note({}))
    check("missing arg returns an error, not a crash", "required" in res.get("error", ""))
    res = json.loads(tools.write_note({"note": "x.md"}))
    check("write without content errors cleanly", "content" in res.get("error", ""))

    check("every schema has a handler",
          all(s["name"] in tools.HANDLERS for s in schemas.ALL_SCHEMAS))
    check("every schema declares an object parameter shape",
          all(s["parameters"].get("type") == "object" for s in schemas.ALL_SCHEMAS))
    check("every tool name is declared in plugin.yaml",
          {s["name"] for s in schemas.ALL_SCHEMAS} == set(
              __import__("yaml").safe_load((REPO / "plugin.yaml").read_text())["provides_tools"]))

    print("\n== dashboard/api.py ==")
    manifest_name = json.loads((REPO / "dashboard" / "manifest.json").read_text())["name"]
    try:
        api = load_module("hermes_dashboard_plugin_obsidian-memory", REPO / "dashboard" / "api.py")
    except ImportError as exc:
        check("dashboard api imports (needs fastapi)", False, str(exc))
        api = None
    if api is not None:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        check("api exposes a module-level router", hasattr(api, "router"))
        check("api reuses the shared store", hasattr(api, "store"))

        # Mount exactly the way the host does, so paths and methods are real.
        app = FastAPI()
        app.include_router(api.router, prefix=f"/api/plugins/{manifest_name}")
        client = TestClient(app)

        r = client.get(f"/api/plugins/{manifest_name}/vaults")
        check("GET /vaults lists the vault",
              r.status_code == 200 and r.json()[0]["name"] == "TestVault", r.text[:200])

        r = client.get(f"/api/plugins/{manifest_name}/notes")
        check("GET /notes returns summaries without bodies",
              r.status_code == 200 and all("content" not in n for n in r.json()), r.text[:200])

        r = client.get(f"/api/plugins/{manifest_name}/notes", params={"tag": "#q3"})
        check("GET /notes filters by tag (leading # tolerated)",
              r.status_code == 200 and [n["path"] for n in r.json()] == ["Notes/Status.md"],
              r.text[:200])

        r = client.get(f"/api/plugins/{manifest_name}/graph")
        check("GET /graph has nodes and edges",
              r.status_code == 200 and r.json()["nodes"] and r.json()["edges"], r.text[:200])

        r = client.get(f"/api/plugins/{manifest_name}/folders")
        check("GET /folders responds", r.status_code == 200 and r.json(), r.text[:200])
        r = client.get(f"/api/plugins/{manifest_name}/tags")
        check("GET /tags responds", r.status_code == 200 and r.json(), r.text[:200])

        r = client.get(f"/api/plugins/{manifest_name}/notes/Notes/Status.md")
        check("GET /notes/<path> handles a nested path",
              r.status_code == 200 and "# Status" in r.json()["content"], r.text[:200])
        check("GET note returns backlinks", "Index.md" in r.json()["backlinks"], r.text[:200])

        r = client.get(f"/api/plugins/{manifest_name}/notes/README")
        check("GET ambiguous note 409s with candidates",
              r.status_code == 409 and len(r.json()["detail"]["candidates"]) == 2, r.text[:200])

        r = client.get(f"/api/plugins/{manifest_name}/notes/Nope.md")
        check("GET missing note 404s", r.status_code == 404, r.text[:200])

        r = client.get(f"/api/plugins/{manifest_name}/notes", params={"vault": "Nope"})
        check("unknown vault 404s", r.status_code == 404, r.text[:200])

        r = client.put(
            f"/api/plugins/{manifest_name}/notes/Index.md",
            params={"content": "# Index\n\nEdited by api.\n"},
        )
        check("PUT /notes/<path> writes through", r.status_code == 200, r.text[:200])
        r = client.get(f"/api/plugins/{manifest_name}/notes/Index.md")
        check("PUT busts the scan cache", "Edited by api." in r.json()["content"], r.text[:200])

        r = client.post(
            f"/api/plugins/{manifest_name}/notes",
            params={"name": "Notes/FromApi.md", "content": "hello"},
        )
        check("POST /notes creates a note", r.status_code == 200
              and r.json()["path"] == "Notes/FromApi.md", r.text[:200])
        r = client.post(
            f"/api/plugins/{manifest_name}/notes",
            params={"name": "Notes/FromApi.md", "content": "again"},
        )
        check("POST /notes 409s on an existing path", r.status_code == 409, r.text[:200])

        r = client.post(f"/api/plugins/{manifest_name}/refresh")
        check("POST /refresh re-scans", r.status_code == 200 and r.json()["notes"] > 0, r.text[:200])

    print("\n== manifest contract ==")
    manifest = json.loads((REPO / "dashboard" / "manifest.json").read_text())
    host_icons = {
        "Activity", "BarChart3", "Clock", "Cpu", "FileText", "FolderOpen", "KeyRound",
        "MessageSquare", "Package", "Settings", "Puzzle", "Sparkles", "Terminal", "Globe",
        "Database", "Shield", "Users", "Wrench", "Zap", "Heart", "Star", "Code", "Eye",
    }
    check("manifest icon is in the host ICON_MAP", manifest["icon"] in host_icons, manifest["icon"])
    check("manifest declares no host-computed fields",
          "has_api" not in manifest and "source" not in manifest, str(sorted(manifest)))
    check("entry resolves inside dashboard/", (REPO / "dashboard" / manifest["entry"]).is_file())
    check("api file resolves inside dashboard/", (REPO / "dashboard" / manifest["api"]).is_file())
    check("api path is relative (host rejects absolute)", not Path(manifest["api"]).is_absolute())
    check("plugin has an __init__.py (loader hard-requires it)", (REPO / "__init__.py").is_file())
    check("plugin ships a SKILL.md", (REPO / "skills" / "obsidian-vault" / "SKILL.md").is_file())
    bundle = (REPO / "dashboard" / "plugin.js").read_text()
    check("bundle registers under the manifest name",
          f'register("{manifest["name"]}"' in bundle)
    check("bundle uses fetchJSON, never a bare fetch(",
          "await fetch(" not in bundle and "= await fetch(" not in bundle)
    check("bundle routes through the documented API prefix",
          f'"/api/plugins/{manifest["name"]}"' in bundle)

    shutil.rmtree(tmp, ignore_errors=True)
    print("\n" + "=" * 60)
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print("  -", f)
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
