# copilot-plugins

Plugins for [GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli)
and [Microsoft Scout](https://aka.ms/scout), focused on Microsoft 365 workflows.

This repository is also a **plugin marketplace**, so the plugins below can be
installed by name once the marketplace is registered.

## Plugins

| Plugin | What it does |
|---|---|
| [`teams-meetings`](plugins/teams-meetings) | Extract full speaker-attributed transcripts from Microsoft Teams meetings — recorded or transcription-only — even when Stream's Download transcript button is disabled by permissions. Includes a Transcript Workbench canvas for the GitHub Copilot app. |

## Installing

Register the marketplace, then install a plugin from it:

```bash
copilot plugin marketplace add david-pizzi-msft/copilot-plugins
copilot plugin install teams-meetings@david-pizzi-plugins
```

Or install a single plugin directly, without the marketplace:

```bash
copilot plugin install david-pizzi-msft/copilot-plugins:plugins/teams-meetings
```

In **Microsoft Scout**, install with the same `copilot plugin` commands above —
register the marketplace, install the plugin, and the skills become available
after a restart.

Note Scout redirects `COPILOT_HOME` to `~/.scout/copilot`, so a `copilot plugin`
command run from inside Scout installs into Scout's own home and is invisible to
the GitHub Copilot app, which uses `~/.copilot`. To install for the app, run the
command from an ordinary terminal instead — and close the app first, since it
holds a lock on the plugin directory.

## Surfaces

Not every plugin feature works on every surface:

| | Copilot CLI | GitHub Copilot app | Microsoft Scout |
|---|---|---|---|
| Skills | yes | yes | yes |
| MCP servers from `.mcp.json` | yes | yes | provides its own equivalents |
| Canvas extensions | no | yes | no |

A canvas renders only in the app. The CLI and Scout can run the same skills
perfectly well from the conversation; they simply cannot draw the UI.

## Requirements

Individual plugins declare their own requirements — see each plugin's README.
Broadly:

- **A Playwright MCP browser.** Plugins that automate a browser ship a
  `.mcp.json` declaring [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp),
  so Copilot CLI and the GitHub Copilot app acquire the browser tools on install.
  Scout provides an equivalent browser surface already.

  Pin a browser channel in that file. Playwright MCP defaults to Google Chrome,
  which is absent by default on Microsoft-managed machines and usually needs
  admin approval, so the browser never launches. `--browser msedge` uses the Edge
  already present on every Windows machine.
- **Python 3** on `PATH` for plugins with post-processing scripts.
- **Windows** — the documented shell snippets are PowerShell. The logic is
  portable, but the command examples are not.

## Developing

Path-sourced plugins in a local marketplace load live from disk, so during
development you can point at a clone and edit in place:

```bash
copilot plugin marketplace add /path/to/copilot-plugins
```

Changes take effect on `/restart` or in a new session — no `copilot plugin
update` needed. Once installed from GitHub, use `copilot plugin update NAME`.

## Repository layout

```text
.github/plugin/marketplace.json   # marketplace catalog
plugins/<name>/plugin.json        # plugin manifest
plugins/<name>/.mcp.json          # MCP servers the plugin needs
plugins/<name>/skills/<skill>/SKILL.md
plugins/<name>/extensions/<ext>/  # canvas extensions, for the Copilot app
plugins/<name>/scripts/           # helper scripts shared across the skills
```

A plugin's `plugin.json` must declare each of these it uses — `skills`,
`extensions` and `mcpServers` — or they are simply not loaded. Adding an
`extensions` key to an already-installed plugin needs the app restarted, since
extensions are read at start-up.

## Licence

MIT — see [LICENSE](LICENSE).
