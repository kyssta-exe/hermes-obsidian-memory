## Obsidian Memory installed

Obsidian Memory is available on two surfaces — the **desktop app** and the
**web dashboard**. Both read the same backend.

### Enable it first

Plugins install disabled. Enable it with:

```bash
hermes plugins enable obsidian-memory
```

### Desktop app

- The **Obsidian** row appears in the sidebar, below **Artifacts**
- ⌘K → **Open Obsidian vault**, or `⌘⌥O` / `Ctrl+Alt+O`
- The status bar shows your vault count; click it to open the page
- The page has a **Notes** / **Graph** toggle, search, folder and tag filters,
  and inline editing (Edit → Save)

### Web dashboard

Run `hermes dashboard` — the **OBSIDIAN** tab appears after **Skills**.

### Multi-vault

Vaults are auto-discovered by looking for `.obsidian` marker directories under
your configured roots. With more than one vault, a dropdown appears in the
header to switch between them.

### Custom vault roots

Set them in **Settings → Plugins → Obsidian Memory → Vault roots** (one
directory per line), or via env:

```bash
export OBSIDIAN_VAULT_PATH=/path/to/your/vault
```

Add this to `~/.hermes/.env` to persist it. With no configuration, the plugin
scans `~/Documents/Obsidian`, `~/obsidian-vaults`, and `~/vaults`.
