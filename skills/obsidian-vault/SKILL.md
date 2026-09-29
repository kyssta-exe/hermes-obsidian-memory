---
name: obsidian-vault
description: How to search, read, and write notes in the user's Obsidian vault with the obsidian_memory tools. Use when the user asks you to find something they wrote down, recall earlier notes or decisions, follow a [[wikilink]], or save a new note. Covers vault-relative paths, duplicate note names, frontmatter tags, and how to avoid clobbering a note the user wrote.
---

# Working with the Obsidian vault

Four tools back vault access. The one rule that matters: **notes are
identified by their vault-relative path, not their title**, because real vaults
put `README.md` in every folder.

## Find a vault first, once

`obsidian_list_vaults` reports the vault names, their paths, and note counts.
Call it when you do not already know which vault you are in — it is also how
you confirm the vault is configured at all. If it reports no vault, the
`OBSIDIAN_VAULT_PATH` environment variable is unset and points nowhere; say
so rather than guessing a path. Every other tool takes an optional `vault`
argument and defaults to the primary one.

## Searching

`obsidian_search_notes` takes any combination of:

- `query` — matched case-insensitively against titles, paths **and full
  contents**, so it is a real full-text search, not a filename filter.
- `folder` — a folder path; subfolders are included.
- `tag` — a tag with no leading `#`.
- `limit` — results, most recently modified first.

It returns **metadata only** — path, folder, tags, word count, link counts.
That is on purpose: do not try to answer a content question from search
results. Search to locate, then read.

## Reading

`obsidian_read_note` accepts a vault-relative path (`Projects/Apollo/Status.md`)
or a title, and returns the full markdown plus tags, outgoing wikilinks, and
**backlinks** — the notes that link here. Backlinks are the cheapest way to
answer "what does this relate to".

Two failures worth knowing:

- *Ambiguous title* — several folders contain that name. The error returns
  `candidates`; retry with the full path from that list.
- *Not found* — the path was wrong, not the note. Search instead of guessing.

When a note is very long the content is truncated and the response says so.
Read the rest before quoting it.

## Writing

`obsidian_write_note` creates or overwrites. Before you overwrite something
that already exists, **read it first and preserve what the user wrote** — a
blind overwrite destroys their content and there is no undo.

Default to appending a *new* note over rewriting an existing one. Overwrite
only when the user asked for a specific edit to a specific note. A `.md`
extension is added if you omit it, and parent folders are created.

## Writing notes that fit the vault

- Link between notes with `[[double brackets]]`, not markdown links. Those are
  what the graph view and the backlinks feature actually follow.
- Put tags in YAML frontmatter as a list. Inline `#tags` also work and are
  picked up, but they can accidentally catch a `#` in prose.
- Match the vault's existing folder layout and note naming before inventing a
  new one — look at the `folder` field in search results first.

## Reporting back

Cite notes by their vault-relative path, not their title, so the user can find
the file. When you use a note, mention which one — the user is usually
checking your recall against a vault they know better than you do.
