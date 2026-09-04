---
name: teams-transcript-transcription-only
description: "Extract the full speaker-attributed transcript from a transcription-only Microsoft Teams meeting — one that was transcribed but never recorded, so no shareable Stream URL exists. Takes NO URL: opens a browser, waits for the user to sign in, navigate to the meeting's Recap → Transcript tab and say \"go\", then harvests the transcript and saves it as a .txt. Use when the user has no recording link, says the meeting was \"transcript only\", asks whether an already-open tab can be used, or wants to drive the browser themselves. If a Stream recording URL is available, use teams-transcript-from-recording instead."
---

# Teams transcript — transcription-only meeting

Extract the complete transcript from a Teams meeting that was **transcribed but
not recorded**, and save it as a clean `.txt` file.

## When to use this skill instead of the other one

| Situation | Skill |
|---|---|
| Transcription-only meeting, or no usable URL | **this skill** |
| A recording exists and you have a `stream.aspx` URL | `teams-transcript-from-recording` |

If the user produces a Stream URL at any point, switch to
`teams-transcript-from-recording` — it runs unattended and needs no hand-off.

## Why this variant exists

Recording a meeting produces a Stream item with its own shareable
`stream.aspx` URL, which an agent can navigate to directly. **Transcription-only
meetings produce no such URL** — the transcript is reachable only by clicking
through the Teams client to the meeting's Recap tab. There is nothing to paste,
so the user must navigate and the agent harvests what they land on.

Two further constraints shape the procedure:

- The browser driven by Playwright uses a **separate profile** from the user's
  personal Edge or Chrome. Tabs already open in their own browser are invisible
  to you. The user must re-navigate inside your window — say so plainly rather
  than implying their existing tab can be read.
- Stream's **Download transcript** button is usually disabled for non-owners,
  and the `/cdnmedia/transcripts` payload is AES-encrypted. Harvesting the
  rendered DOM is the only reliable route, and it works with view-only rights.

## Requirements

- A Playwright MCP browser (`browser_navigate`, `browser_evaluate`, `browser_snapshot`).
- Python 3 on PATH.
- A **headed** browser — the user has to see it to drive it.

## Input

**None.** Never ask for a URL.

## Steps

### 1. Open the browser and hand over control

`browser_navigate` to `https://www.microsoft365.com/launch/stream`, purely to
materialise a visible window. A sign-in page is expected and fine.

Then tell the user, in one short message:

> The window's open. Sign in there, navigate to the meeting's
> **Recap → Transcript** tab, then say "go".

Then **end your turn and wait**. Do not poll the tab list, do not guess, do not
proceed until the user replies.

**If you were launched from the Transcript Workbench canvas** — the prompt says
so — point them at the panel's **Go** button instead of asking them to type, and
say you will wait. Pressing it resumes you in the same conversation, so the whole
job stays on one surface. Either signal means the same thing; carry on at step 2
when it arrives.

### 2. Discover where they landed

On "go", list the tabs, then search the page for `/transcript|recording|recap/i`.

Two shapes are possible:

- **Teams Recap** (`teams.cloud.microsoft`, tab "Recap" → sub-tab "Transcript")
  — the expected case. The transcript lives inside an **iframe**, typically
  named `RecapxPlatIframe`, hosted on
  `<tenant>-my.sharepoint.com/personal/<owner>_microsoft_com/_layouts/15/xplatplugins.aspx`.
  Ask the user to click Recap → Transcript if it is not already selected.
- **Stream player** (`.../_layouts/15/stream.aspx?id=...`) — they found a
  recording after all. The transcript is in the top-level document; open the
  panel by clicking the **menuitem** named "Transcript" in the "Enhancements
  menu" menubar, never the "Read transcript" button over the video.

### 3. Probe the scroll container

Run this inside the correct document to confirm the container and that the
Fluent UI class prefixes still match (suffixes change between Microsoft builds,
so never hard-code them):

```js
() => {
  const conts = Array.from(document.querySelectorAll('div'))
    .filter(e => e.clientHeight > 100 && e.scrollHeight > e.clientHeight + 200)
    .sort((a,b) => b.scrollHeight - a.scrollHeight).slice(0,4)
    .map(e => ({cls: e.className.toString().slice(0,120), ch: e.clientHeight, sh: e.scrollHeight}));
  const n = document.querySelectorAll('[class*="itemHeader-"], [class*="entryText-"], [class*="eventText-"]').length;
  return {conts, selCount: n};
}
```

Expect a container whose class contains `focusZoneWithAutoScroll-`, and
`selCount` around 40–60 — that is the virtualised window, not the whole
transcript. Note its `clientHeight`; the scroll step must stay below it. The
Recap panel is typically only ~380px tall.

### 4. Harvest

Call `browser_evaluate` with `filename: "transcript-raw.md"` and the function in
[`../../scripts/harvest-transcript.js`](../../scripts/harvest-transcript.js).

To reach inside the Recap iframe, pass a frame-piercing target:

```
target:  iframe[name="RecapxPlatIframe"] >> internal:control=enter-frame >> body
element: transcript iframe body
```

and keep `element.ownerDocument` on the first line. Set `STEP = 250` for the
Recap panel; use `400` only if the user landed on the full-height Stream player.

Do **not** use `browser_run_code_unsafe` to persist output: it cannot write files
(`require` is undefined, dynamic `import()` is unavailable, and its `filename`
argument throws ENOENT). It is also unnecessary for reaching the iframe — the
frame-piercing `target` above does that on its own.

Check the result object rather than eyeballing the text:

- `keyedBy` should be `"id"`. The Recap panel exposes sequential `entry-N` and
  `itemHeader-N` ids, same as the Stream player, so the harvest is exact.
  `"position"` means those ids were absent and it fell back to pixel
  measurement — that path can emit adjacent duplicate lines, so verify by hand.
- `missingIds` must be `[]`. The ids are contiguous, so an empty array proves
  every turn between `firstId` and `lastId` was captured. Any pair listed is a
  real gap: re-run with a smaller `STEP`.
- `entriesWithoutHeader` is expected to be large. Headers mark speaker changes,
  not entries, so in a two-person call roughly a third to a half of entries
  carry none. It is not an error.
- `recoveredFromLabel` should be `0`. Anything higher means a header was missed
  and the speaker was inferred from the group's aria-label, which is unreliable
  — see the note in the harvester.
- `entries` counts speaker turns, roughly 10 per minute on a two-person call.
  If it is under ~50 the container was mis-detected — retarget the element whose
  class contains `focusZoneWithAutoScroll-`.

### 5. Locate the raw output

```powershell
Get-ChildItem -Path $env:USERPROFILE -Recurse -Filter 'transcript-raw.md' -ErrorAction SilentlyContinue -Depth 7 | Select-Object FullName,Length
```

It commonly lands in the working directory. Peek at the first ~400 characters
only, to confirm it is JSON with `scrollHeight`, `entries`, and `text`. **Do not
read the whole file into context.**

### 6. Gather metadata from the page

- **Title** — the Teams tab title, minus the unread-count prefix.
- **Date and time** — the Recap "Select the meeting by time" combobox, e.g.
  "25 August 2026 17:30 - 18:00".
- **Owner** — named in the disabled Download tooltip, or the
  `/personal/<owner>_microsoft_com/` segment of the iframe URL.
- **Duration** — take it from the **last transcript timestamp**, not the
  scheduled slot. Meetings routinely overrun; a 30-minute booking that ran 53
  minutes is unremarkable. If they disagree, report the scheduled start together
  with the real duration.

### 7. Clean and write the .txt

```powershell
python <PLUGIN>/scripts/clean-transcript.py "<RAW JSON PATH>" `
  --out "<Short-Name>-<YYYYMMDD>-transcript.txt" `
  --title "<Meeting title>" `
  --date "<25 August 2026>" `
  --start "<17:30 (BST)>" `
  --owner "<Owner name>" `
  --source "Microsoft Teams Recap"
```

The script prints a JSON summary — path, folder, `file://` URLs, size, line
count, entries, first and last timestamp, and detected speakers. Use that for
your report rather than re-reading the transcript.

### 8. Filename and location

Name the file `<Short-Meeting-Name>-<YYYYMMDD>-transcript.txt`, using the
**meeting** date rather than today's. Strip characters invalid in Windows
filenames.

**Where to save it.** If the caller named a folder — the Transcript Workbench
canvas always does — pass `--out` as an absolute path inside that folder. Only
fall back to a bare filename in the working directory when no folder was given.

That default is a poor one in the GitHub Copilot app, where the working
directory is a per-chat scratch folder under `~/.copilot/chats/<date>/<slug>`:
correct, but effectively undiscoverable, and discarded with the chat. If no
folder was named and the `transcript-workbench` canvas is available, call its
`get_output_folder` action and save there instead.

### 9. Verify, tidy, report

Verification is **self-contained**. There is no reference copy to compare
against — this skill runs precisely when no recording and no downloadable
transcript exist — so rely on the result object, not on an external file.

- Confirm `keyedBy` was `"id"`, `missingIds` was `[]`, and `recoveredFromLabel`
  was `0`. Together those establish complete coverage with reliable speaker
  attribution.
- If `keyedBy` was `"position"`, there is no completeness proof available. Count
  long lines against distinct long lines — they should be equal — and scan for
  repeated adjacent lines before delivering the file.
- Confirm the last timestamp is plausible for the meeting length. If it stops
  far short, the scroll did not complete — re-run step 4 with a smaller `STEP`.
- Check the speaker list looks right. A transcription-only call is usually a
  small number of named people; a stray "Speaker 1" is normal for the
  "started transcription" event but not for actual speech.
- View the first ~14 lines to confirm the header and structure.
- Delete `transcript-raw.md`.
- **Lead the report with where the file is.** The saved location is not obvious
  to the reader, so do not bury it in a table cell. Give the filename and its
  full folder first.

  If the `transcript-workbench` canvas is available, say the transcript is listed
  there and can be read with its **View** button. Do not offer to open it in
  Explorer — the canvas cannot. A markdown `file://` link does not render as
  clickable in every surface either, so treat it as a supplement, never the only
  signpost. If you do include one, take the `url` from the summary verbatim; it
  is already percent-encoded, so paths containing spaces survive.
- Then report a compact table: path, size, line count, entries harvested, time
  span, and speakers detected. State which path was used when it was
  `"position"`.

## Caveats to pass on to the user

- Transcripts are AI-generated and mangle proper nouns and names frequently —
  including attendees' own names in their greetings. Say so, and cite an example
  from the file if you spot one.
- Overlapping speech is reordered. The panel groups each speaker's contiguous
  speech into a single turn, so a short interjection can appear after the
  sentence it interrupted rather than inside it. No words are lost, but the
  order is not strictly chronological where people talk over one another.
- Meeting content may be confidential. Writing it to local disk at the user's
  request is fine — never forward or upload it anywhere without explicit
  confirmation.

## Optional follow-up

Once the file is confirmed written, offer a structured summary or action-item
extraction.
