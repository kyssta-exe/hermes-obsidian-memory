# Obsidian Memory for Hermes

Browse, search, and edit your Obsidian vault notes directly from Hermes — as a
desktop app page, a web dashboard tab, or both.

## Features

- **Multi-vault support** — auto-discovers every vault under your configured roots
- **Graph visualization** — force-directed graph with curved edges, node dragging, zoom controls
- **Note viewer** — full markdown rendering (code blocks, tables, callouts, checkboxes, wikilinks)
- **Inline editing** — edit notes directly with save/cancel
- **Search & filter** — search by name, filter by folder or tag
- **Backlinks** — see which notes link to the current note, click to navigate

## Install

```shell
hermes plugins install kyssta-exe/hermes-obsidian-memory
```

Then enable it — plugins install disabled by default:

```shell
hermes plugins enable obsidian-memory
```

## Configuration

Set your vault roots in the Desktop app under **Settings → Plugins →
Obsidian Memory → Vault roots** (one directory per line), or edit
`~/.hermes/.env`:

```shell
export OBSIDIAN_VAULT_PATH=/path/to/your/vault
```

Any subdirectory containing a `.obsidian` marker folder is discovered as a vault.
Each root and its immediate children are scanned, so a vault nested one level
under a root is found too. With no configuration, the defaults are
`~/Documents/Obsidian`, `~/obsidian-vaults`, and `~/vaults`.

## Usage

### Desktop app

After enabling, the **Obsidian** row appears in the sidebar (below Artifacts) and
the **Obsidian** page opens at `/obsidian`. Also reachable via ⌘K → "Open
Obsidian vault", or `⌘⌥O` / `Ctrl+Alt+O`.

- Click a note to view it
- Click **Edit** to modify note content
- Click `[[wikilinks]]` to navigate between notes
- Use the vault dropdown to switch between vaults
- Graph view: drag nodes, scroll to zoom, click to open a note
- The status bar shows your vault count; click it to open the page

### Web dashboard

```shell
hermes dashboard
```

The **OBSIDIAN** tab appears in the sidebar after **Skills**.

## Package layout

One installable folder, two SDKs — the desktop half and the dashboard tab share
one backend:

```
obsidian-memory/
├── plugin.yaml            # manifest: config_schema drives the settings form
├── __init__.py            # no agent-side tools/hooks — UI-only plugin
├── dashboard/
│   ├── manifest.json      # dashboard tab registration
│   ├── plugin_api.py      # FastAPI routes → /api/plugins/obsidian-memory/
│   └── plugin.js          # web dashboard UI
├── desktop/
│   └── plugin.js          # desktop app: page, sidebar, palette, keybind, chip
└── tests/
    └── test_plugin_api.py # backend tests against the real router
```

The Electron shell copies `desktop/plugin.js` into
`$HERMES_HOME/desktop-plugins/obsidian-memory/` on install, so the pane is
app-level and does not come and go with the active profile. Both UI halves call
the same `plugin_api.py` through their own doors (`ctx.rest` on the desktop,
`fetchJSON` on the dashboard).

## Requirements

- Hermes Agent with the desktop app and/or dashboard enabled
- Obsidian vault(s) on the host machine

## Development

```shell
hermes plugins validate .    # catalog admission gate
hermes plugins doctor .      # runtime discovery + registration
python -m pytest tests/ -q   # backend tests
```

## License

MIT
