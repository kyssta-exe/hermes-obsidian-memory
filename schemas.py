"""Tool schemas — what the model reads to decide when to reach for the vault.

Descriptions are the only thing that drives tool selection, so each one says
what the tool does *and* when to prefer it over a plain file read.
"""

LIST_VAULTS = {
    "name": "obsidian_list_vaults",
    "description": (
        "List the Obsidian vaults available on this machine, with their paths and note counts. "
        "Call this first when the user refers to 'my notes' or 'the vault' and you do not "
        "already know which vault or path they mean — it is also the fastest way to confirm that "
        "the vault is configured and reachable at all."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "required": [],
    },
}

SEARCH_NOTES = {
    "name": "obsidian_search_notes",
    "description": (
        "Search Obsidian vault notes by text, or list them filtered by folder or tag. "
        "The query is matched case-insensitively against note titles, paths and full contents, "
        "so it doubles as full-text search across the vault. Use this to find where something "
        "was written down instead of grepping the filesystem, and prefer it over reading files "
        "directly: it understands the vault layout, skips Obsidian's own config directory, and "
        "returns wikilink backlinks so you can follow a trail of related notes. Returns note "
        "metadata only (path, folder, tags, word count) — call obsidian_read_note for the body."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "Text to search for across note titles, paths and bodies. "
                    "Omit to list all notes."
                ),
            },
            "vault": {
                "type": "string",
                "description": "Vault name from obsidian_list_vaults. Defaults to the primary vault.",
            },
            "folder": {
                "type": "string",
                "description": "Restrict results to this folder (e.g. \"Projects/Apollo\").",
            },
            "tag": {
                "type": "string",
                "description": "Restrict results to notes carrying this tag (without the leading #).",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum notes to return, most recently modified first. Default 20.",
            },
        },
        "required": [],
    },
}

READ_NOTE = {
    "name": "obsidian_read_note",
    "description": (
        "Read one Obsidian note by its vault-relative path (e.g. \"Projects/Apollo/Status.md\") "
        "or by its title when that title is unique in the vault. Returns the note's full markdown "
        "content plus its tags, outgoing wikilinks and the notes that link back to it. "
        "Use this to read a note found by obsidian_search_notes, or to follow a [[wikilink]] "
        "to its target. If a title is ambiguous because several folders contain the same name, "
        "the error lists the candidate paths — retry with the full path."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "note": {
                "type": "string",
                "description": "Vault-relative path or unique note title.",
            },
            "vault": {
                "type": "string",
                "description": "Vault name from obsidian_list_vaults. Defaults to the primary vault.",
            },
        },
        "required": ["note"],
    },
}

WRITE_NOTE = {
    "name": "obsidian_write_note",
    "description": (
        "Create or overwrite an Obsidian note in a vault. Use this to record something the user "
        "asked you to remember or save, or to update an existing note you have read. "
        "Always read the note first with obsidian_read_note before overwriting an existing one, "
        "so you preserve content the user wrote. Prefer appending a new note over rewriting an "
        "existing one unless the user asked for a specific edit. Note titles and links use "
        "Obsidian's [[double bracket]] wikilink syntax; a .md extension is added if you omit it."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "note": {
                "type": "string",
                "description": "Vault-relative path for the note, e.g. \"Journal/2026-09-29.md\".",
            },
            "content": {
                "type": "string",
                "description": "Full markdown content of the note.",
            },
            "vault": {
                "type": "string",
                "description": "Vault name from obsidian_list_vaults. Defaults to the primary vault.",
            },
        },
        "required": ["note", "content"],
    },
}

ALL_SCHEMAS = (LIST_VAULTS, SEARCH_NOTES, READ_NOTE, WRITE_NOTE)
