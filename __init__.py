"""Obsidian Memory — unified Hermes plugin.

Ships as one folder with two halves:

* **agent half** — this manifest plus ``dashboard/plugin_api.py`` (FastAPI
  routes mounted at ``/api/plugins/obsidian-memory/``, consumed by the web
  dashboard and by the desktop half through ``ctx.rest``).
* **desktop half** — ``desktop/plugin.js`` (page, sidebar nav, command palette,
  keybind, status bar chip). The Electron shell copies it into
  ``desktop-plugins/obsidian-memory/`` beside a ``.hermes-package.json`` marker.

There is no agent-side Python to register — no tools, no hooks. The desktop
half reads the backend through the plugin's own REST namespace, and the web
dashboard loads it through its own manifest. This module exists so the package
satisfies the directory-plugin loader (which requires ``__init__.py`` beside
``plugin.yaml``) and to expose a no-op ``register`` for hosts that import it.
"""

import logging

logger = logging.getLogger(__name__)


def register(ctx):
    """No agent-side registrations — this plugin contributes UI only."""
    logger.debug("obsidian-memory: UI-only plugin (desktop half + dashboard API)")
