# copilot-plugins

Plugins for [GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli)
and [Microsoft Scout](https://aka.ms/scout), focused on Microsoft 365 workflows.

This repository is also a **plugin marketplace**, so the plugins below can be
installed by name once the marketplace is registered.

## Plugins

| Plugin | What it does |
|---|---|
| [`teams-meetings`](plugins/teams-meetings) | Extract full speaker-attributed transcripts from Microsoft Teams meetings — recorded or transcription-only — even when Stream's Download transcript button is disabled by permissions. |

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

In **Microsoft Scout**, use **Customize → Plugins** to add the marketplace and
install from it.

## Requirements

Individual plugins declare their own requirements — see each plugin's README.
Broadly:

- **A Playwright MCP browser.** Plugins that automate a browser ship a
  `.mcp.json` declaring [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp),
  so Copilot CLI acquires the browser tools on install. Scout provides an
  equivalent browser surface already.
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
plugins/<name>/scripts/           # helper scripts shared across the skills
```

## Licence

MIT — see [LICENSE](LICENSE).
