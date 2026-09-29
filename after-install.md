## Obsidian Memory installed

An **Obsidian** tab is now available in your Hermes dashboard, and the agent
can search, read and write the same vault.

### 1. Make sure the plugin is enabled

```bash
hermes plugins enable obsidian-memory
hermes plugins list
```

An installed-but-disabled plugin is skipped completely: no dashboard tab and no
backend routes. If `hermes plugins list` does not show it enabled, that is why
the tab is missing.

### 2. Restart the dashboard

```bash
hermes dashboard
```

Backend routes are mounted once at startup. Rescanning picks up new static
assets, but not new Python routes.

### 3. Open the tab

Click **Obsidian** in the sidebar, after Skills.

- Click a note to read it, **Edit** to change it
- Click a `[[wikilink]]` to jump between notes
- **Graph** switches to the force-directed view
- Use the header dropdown to switch vaults

If the tab reports **No Obsidian vault found**, set your vault path in
`~/.hermes/.env`:

```bash
OBSIDIAN_VAULT_PATH=/path/to/your/vault
```

then restart the dashboard. A vault is any folder containing an `.obsidian`
folder; with no path set, `~/ObsidianVault` and its siblings, plus
`~/Documents/Obsidian/`, `~/obsidian-vaults/` and `~/vaults/`, are searched.

### 4. The agent side

The vault is reachable from the agent too — you can just ask:

- "Search my notes for the auth rollout"
- "What did I write about billing?"
- "Save this as a note under Projects/Apollo"

For the conventions the agent should follow (paths over titles, duplicate
names, not clobbering your writing), it can load the bundled skill
`obsidian-memory:obsidian-vault` via `skill_view`.
