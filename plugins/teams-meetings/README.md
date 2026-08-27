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
in the DOM at once — so the harvest scrolls in small steps and de-duplicates by
vertical document position, which also preserves ordering.

## Requirements

- **A Playwright MCP browser.** `.mcp.json` declares `@playwright/mcp`, so
  Copilot CLI acquires the browser tools on install. Microsoft Scout already
  provides an equivalent surface.
- **Python 3** on `PATH`, for `scripts/clean-transcript.py`.
- **A headed browser** for `teams-transcript-transcription-only` — you have to
  see it in order to drive it.
- You must be signed in to Microsoft 365 in that browser, and have at least
  view access to the meeting.
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
- **Fluent UI class names change between Microsoft builds.** The harvest matches
  class *prefixes* (`itemHeader-`, `entryText-`, `eventText-`) and auto-detects
  the scroll container rather than hard-coding selectors, but a sufficiently
  large redesign will still break it. Both skills include a probe step to catch
  this before harvesting.
- Meeting content may be confidential. The transcript is written to local disk
  at your request; the skills are instructed never to forward or upload it.
