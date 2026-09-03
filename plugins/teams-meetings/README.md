# teams-meetings

Extract full speaker-attributed transcripts from Microsoft Teams meetings and
save them as clean `.txt` files.

Works in two situations, with a skill for each:

| Skill | Use when |
|---|---|
| `teams-transcript-from-recording` | The meeting was **recorded** and you have a Microsoft Stream / SharePoint URL (`…/_layouts/15/stream.aspx?id=…`). Runs unattended. |
| `teams-transcript-transcription-only` | The meeting was **transcribed but not recorded**, so no shareable URL exists. Opens a browser, you navigate to Recap → Transcript and say "go", the agent harvests. |

Each skill points at the other, so the agent can hand off if it picks wrong —
for instance when a recording exists but its link turns out to be unusable.

## Why it isn't just a download

Two obvious approaches fail, and the skills document them so the agent doesn't
waste turns rediscovering them:

- Stream's **Download transcript** button is disabled whenever you are a viewer
  rather than the recording's owner.
- The `/cdnmedia/transcripts` network payload is **AES-encrypted**, so fetching
  it directly yields ciphertext.

Instead, both skills harvest the rendered DOM of the transcript panel, which
works with view-only rights. The panel is virtualised — only ~50 entries exist
in the DOM at once — so the harvest scrolls in small steps. Both surfaces tag
each turn with a sequential DOM id (`entry-0`, `entry-1`, …) and each speaker
change with a matching `itemHeader-N`, so entries are keyed on that integer
rather than measured by pixel position. Because the ids are contiguous, the
harvest can prove its own coverage: an empty `missingIds` means every turn was
captured, with no reference copy needed.

## Requirements

- **A Playwright MCP browser.** `.mcp.json` declares `@playwright/mcp`, so
  Copilot CLI and the GitHub Copilot app acquire the browser tools on install.
  Microsoft Scout already provides an equivalent surface.
- **Microsoft Edge.** `.mcp.json` pins `--browser msedge`, so the harvest drives
  the Edge already present on every Windows machine. Nothing to download and no
  admin rights needed.

  Do not remove that flag. Playwright MCP otherwise defaults to Google Chrome,
  which is absent by default on Microsoft-managed machines and typically needs
  admin approval to install — the plugin fails to launch at all without it.
  `npx playwright install chromium` is *not* a workaround: it resolves a
  Playwright core version independent of the one `@playwright/mcp` bundles, so
  you get, say, build 1234 while the server demands 1243, and the mismatch
  returns after the next MCP release.
- **Python 3** on `PATH`, for `scripts/clean-transcript.py`.
- **A headed browser** for `teams-transcript-transcription-only` — you have to
  see it in order to drive it. `@playwright/mcp` runs headed by default; do not
  pass `--headless` for that skill.
- You must be signed in to Microsoft 365 in that browser, and have at least
  view access to the meeting. The MCP server keeps a persistent profile, so the
  sign-in survives between sessions — but it is a *separate* Edge profile from
  your everyday one, so the first run always needs a fresh sign-in.
- Shell examples are **PowerShell / Windows**.

## Output

A `.txt` file named `<Short-Meeting-Name>-<YYYYMMDD>-transcript.txt`, headed
with the meeting title, date, duration, owner, and source:

```text
VBD Agents Landing Page Sync
Microsoft Teams Recap | 25 August 2026 | from 17:30 (BST) | Duration ~53:28
Owner: Jane Doe
Transcript extracted 27 August 2026 | AI-generated content may be incorrect
==============================================================================

[0:50] Ada Lovelace:
Hello, Dave.

[0:53] Dave Pizzi:
Hi, Ada.
```

## Contents

```text
plugin.json                              manifest
.mcp.json                                Playwright MCP server
skills/teams-transcript-from-recording/
skills/teams-transcript-transcription-only/
scripts/harvest-transcript.js            DOM harvest, passed to browser_evaluate
scripts/clean-transcript.py              raw JSON → headed .txt, prints a JSON summary
```

`clean-transcript.py` is a normal CLI and can be run by hand:

```powershell
python scripts/clean-transcript.py transcript-raw.md `
  --out "Standup-20260825-transcript.txt" `
  --title "Standup" --date "25 August 2026" --source "Microsoft Teams Recap"
```

## Known limitations

- **Transcripts are AI-generated.** Proper nouns and names are frequently
  mangled — including attendees' own names.
- **Overlapping speech is reordered.** Each speaker's contiguous speech is
  grouped into one turn, so a short interjection can land after the sentence it
  interrupted. No words are lost, but the order is not strictly chronological
  where people talk over one another.
- **Fluent UI class names change between Microsoft builds.** The harvest matches
  class *prefixes* (`itemHeader-`, `entryText-`, `eventText-`) and auto-detects
  the scroll container rather than hard-coding selectors, but a sufficiently
  large redesign will still break it. Both skills include a probe step to catch
  this before harvesting.
- Meeting content may be confidential. The transcript is written to local disk
  at your request; the skills are instructed never to forward or upload it.
