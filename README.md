# Obsidian Memory for Hermes

Browse, search, and edit your Obsidian vault from the Hermes dashboard — and let
the agent read and write the same notes.

## Install

```bash
hermes plugins install kyssta-exe/hermes-obsidian-memory
```

The installer asks **“Enable now? [y/N]”**. Answer `y` — this matters:

- A user plugin that is installed but not **enabled** is skipped entirely. Its
  dashboard tab never appears *and* its backend routes are never mounted, so
  the tab would load and then show nothing.
- If you declined, or you are installing by hand, run:

```bash
hermes plugins enable obsidian-memory
hermes plugins list        # confirm it shows ✓ enabled
```

Restart the dashboard afterwards (`hermes dashboard`). Backend routes are
mounted once at startup, so they are not picked up by a rescan.

## What you get

### Dashboard tab

An **Obsidian** tab appears in the dashboard sidebar, after Skills.

- **Multi-vault** — auto-discovers every vault; switch with the header dropdown
- **Graph view** — force-directed, curved edges, drag nodes, scroll to zoom
- **Note viewer** — markdown with code blocks, tables, callouts, task lists and
  clickable `[[wikilinks]]`
- **Backlinks** — see which notes link to the open note, click through
- **Inline editing** — edit and save a note without leaving the tab
- **Search & filter** — by name, folder or tag

The tab follows the active dashboard theme: it reads the theme's `--color-*`
tokens rather than hardcoding a palette, so switching themes in the dashboard
header reskins it.

### Agent tools

The same vault is available to the agent as four tools:

| Tool | Purpose |
| --- | --- |
| `obsidian_list_vaults` | Which vaults exist, with paths and note counts |
| `obsidian_search_notes` | Full-text search across titles, paths and bodies; filter by folder or tag |
| `obsidian_read_note` | One note in full, with tags, outgoing links and backlinks |
| `obsidian_write_note` | Create or update a note |

### Bundled skill

Loads on demand as `obsidian-memory:obsidian-vault` (`skill_view`), covering
the vault conventions that are easy to get wrong: notes are addressed by
vault-relative path rather than title, duplicate titles are common, frontmatter
tags come in several shapes, and overwriting a note the user wrote destroys
their content.

## Configuration

The vault is discovered automatically — a vault is any directory containing an
`.obsidian` folder. Searched, in order:

1. `OBSIDIAN_VAULT_PATH`, if set
2. `~/ObsidianVault` (the default)
3. sibling directories of the primary vault
4. `~/Documents/Obsidian/`, `~/obsidian-vaults/`, `~/vaults/`

To pin a specific vault, add this to `~/.hermes/.env`:

```bash
OBSIDIAN_VAULT_PATH=/path/to/your/vault
```

This is optional. If no vault is found the tab explains what to set instead of
failing silently, and the tools return an error that says so.

## Notes on behaviour

- **Notes are keyed by vault-relative path**, not filename. Real vaults repeat
  names across folders, so a title that is ambiguous returns a `409` listing the
  candidate paths instead of silently opening the wrong file.
- **Backlinks are paths**, so clicking one opens the exact note.
- Saving sends the note body as a URL parameter. A long note in a JSON body
  would be cleaner, but URLs are what the dashboard's authenticated fetch path
  handles reliably at the size real notes reach.

## Development

```bash
python3 selftest.py        # vault logic, tool handlers, dashboard router, manifest contract
node selftest_bundle.js    # runs dashboard/plugin.js headless against a stub SDK
```

The Python suite builds a throwaway vault in a temp dir and exercises the real
code paths; the JS suite executes the bundle in a VM with a stubbed SDK, React
and DOM so the render path and the authed-save path are actually run.

## Requirements

- Hermes Agent with the dashboard enabled
- One or more Obsidian vaults on the host machine
- `fastapi` (ships with Hermes) for the dashboard backend

## License

MIT
