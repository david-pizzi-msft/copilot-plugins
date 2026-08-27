---
name: teams-transcript-from-recording
description: "Extract the full speaker-attributed transcript from a recorded Microsoft Teams meeting and save it as a .txt file. Use when the user supplies a Microsoft Stream / SharePoint recording URL (contains /_layouts/15/stream.aspx?id=...) and wants the transcript, a transcript file, or asks to \"pull the transcript\" from a recording. Works even when Stream's own Download transcript button is disabled by permissions. If the meeting was transcription-only, or no usable URL exists, use teams-transcript-transcription-only instead."
---

# Teams transcript — from a recording

Extract the complete transcript from a recorded Teams meeting given its Stream
URL, and save it as a clean `.txt` file.

## When to use this skill instead of the other one

| Situation | Skill |
|---|---|
| A recording exists and you have a `stream.aspx` URL | **this skill** |
| Transcription-only meeting, or no usable URL | `teams-transcript-transcription-only` |

If the user has no link, or the link turns out to be unusable (sign-in wall,
expired, or the recording opens only inside the Teams client), **hand off to
`teams-transcript-transcription-only`** rather than stalling.

## Requirements

- A Playwright MCP browser (`browser_navigate`, `browser_evaluate`, `browser_snapshot`).
- Python 3 on PATH.
- The user signed in to Microsoft 365 in that browser.

## Input

A SharePoint Stream URL containing `/_layouts/15/stream.aspx?id=...`.
If the user did not supply one, ask for it and wait.

## Why this procedure exists

Two obvious routes are dead ends — do not spend turns on them:

- Stream's **Download transcript** button is usually disabled when the user is a
  viewer rather than the recording owner ("You don't have permission to download
  the transcript. Contact _owner_ to request access.").
- The `/cdnmedia/transcripts` network payload is **AES-encrypted** — fetching it
  returns ciphertext, not text.

Harvesting the rendered DOM works with view-only rights and is the reliable path.

## Steps

### 1. Open the recording

`browser_navigate` to the URL. Long URLs can be trimmed: `id=` and `ovuser=` are
essential; `xsdata`, `sdata`, `TeamsCID`, and `clickparams` can be dropped.

Confirm the page title is the recording name, not a sign-in page. If a sign-in
wall appears, tell the user and offer the transcription-only skill instead.

### 2. Open the Transcript panel

Locate an element named "Transcript" (via `browser_find` if available, otherwise
`browser_snapshot`), then click the **menuitem** named "Transcript" in the
"Enhancements menu" menubar on the right-hand rail.

Do **not** click the "Read transcript" button overlaying the video — it opens a
different, non-harvestable view.

If no "Transcript" menuitem exists, the recording has no transcript. Say so and
stop.

### 3. Probe the scroll container

Before harvesting, confirm the container and that the Fluent UI class prefixes
still match (suffixes change between Microsoft builds, so never hard-code them):

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
transcript. Note its `clientHeight`; the scroll step must stay below it.

### 4. Harvest

Call `browser_evaluate` with `filename: "transcript-raw.md"` and the function in
[`../../scripts/harvest-transcript.js`](../../scripts/harvest-transcript.js).

For this skill the transcript is in the **top-level document**, so pass no
`target` and change `element.ownerDocument` to `document` on the first line.
Set `STEP = 400` for the full-height Stream player.

Check the result object rather than eyeballing the text:

- `keyedBy` should be `"id"`. Stream tags each turn with a sequential DOM id
  (`entry-0`, `entry-1`, ...) and each speaker change with a matching
  `itemHeader-N`, which is what the harvester keys on. `"position"` means those
  ids were absent and it fell back to pixel measurement — that path can emit
  adjacent duplicate lines, so verify the output before trusting it.
- `missingIds` must be `[]`. The ids are contiguous, so an empty array is proof
  that every turn between `firstId` and `lastId` was captured. Any pair listed is
  a genuine gap: re-run with a smaller `STEP`.
- `entriesWithoutHeader` is expected to be large. Headers mark speaker changes,
  not entries, so a speaker holding the floor for several paragraphs produces
  one header and several bare entries. It is not an error.
- `recoveredFromLabel` should be `0`. Anything higher means a header was missed
  and the speaker was inferred from the group's aria-label, which is unreliable
  — see the note in the harvester.
- `entries` counts speaker turns, not lines — expect roughly 6 per minute
  (a 66-minute meeting yields ~400). If it is under ~50 the container was
  mis-detected: retarget the element whose class contains
  `focusZoneWithAutoScroll-`.

Do **not** use `browser_run_code_unsafe` to persist output: it cannot write files
(`require` is undefined, dynamic `import()` is unavailable, and its `filename`
argument throws ENOENT).

### 5. Locate the raw output

```powershell
Get-ChildItem -Path $env:USERPROFILE -Recurse -Filter 'transcript-raw.md' -ErrorAction SilentlyContinue -Depth 7 | Select-Object FullName,Length
```

It commonly lands in the working directory. Peek at the first ~400 characters
only, to confirm it is JSON with `scrollHeight`, `entries`, and `text`. **Do not
read the whole file into context** — transcripts run to tens of thousands of
characters.

### 6. Gather metadata from the page

- **Title** and **date** — shown under the video.
- **Owner** — named in the disabled Download tooltip, or the
  `/personal/<owner>_microsoft_com/` segment of the URL.
- **Duration** — take it from the **last transcript timestamp**, not the
  scheduled slot. Meetings routinely overrun.

### 7. Clean and write the .txt

```powershell
python <PLUGIN>/scripts/clean-transcript.py "<RAW JSON PATH>" `
  --out "<Short-Name>-<YYYYMMDD>-transcript.txt" `
  --title "<Recording title>" `
  --date "<25 August 2026>" `
  --start "<17:30 (BST)>" `
  --owner "<Owner name>" `
  --source "Microsoft Stream (SharePoint)"
```

The script prints a JSON summary — path, size, line count, entries, first and
last timestamp, and detected speakers. Use that for your report rather than
re-reading the transcript.

### 8. Filename and location

Save to the working directory as
`<Short-Recording-Name>-<YYYYMMDD>-transcript.txt`, using the **recording** date
rather than today's. Strip characters invalid in Windows filenames.

### 9. Verify, tidy, report

Verification is **self-contained** — it needs no reference copy of the
transcript, which is the whole point, since this skill exists precisely for
meetings where Stream will not give you one.

- Confirm `keyedBy` was `"id"`, `missingIds` was `[]`, and `recoveredFromLabel`
  was `0`. That trio is the guarantee: the ids are contiguous, so an empty gap
  list proves complete coverage, and a zero recovery count means every speaker
  came from a header rather than a guess. Nothing external is required.
- Confirm the last timestamp is plausible for the meeting length. If it stops
  far short, the scroll did not complete — re-run step 4 with a smaller `STEP`.
- Count long lines against distinct long lines; they should be equal. On the id
  path they always are, so any inequality means the fallback ran.
- View the first ~14 lines to confirm the header and structure.
- Delete `transcript-raw.md`.
- Report a compact table: path, size, line count, entries harvested, time span,
  and speakers detected.

### 10. If a .vtt happens to be available

Normally it will not be — a viewer who could download the transcript would not
need this skill. Treat a `.vtt` as a rare debugging aid, never a prerequisite:
do not ask the user for one, do not block on its absence, and do not present the
transcript as unverified without it. Step 9 is sufficient.

If the user volunteers one, compare as a **multiset of normalised words** —
lowercase, strip punctuation — rather than line by line:

- Every VTT word should appear in the transcript. Anything missing is real loss.
- A handful of extra words is expected: the file header, plus Stream's
  "started/stopped transcription" markers, which the VTT does not contain.

Do **not** treat a sequential diff as authoritative. The VTT interleaves cues
strictly by start time, whereas the panel groups each speaker's contiguous
speech into one turn. Where people talk over one another the two orderings
diverge legitimately, and a naive diff reports that as both a deletion and an
insertion despite no content being lost.

## Caveats to pass on to the user

- Transcripts are AI-generated and mangle proper nouns and names frequently.
  Say so, and cite an example from the file if you spot one.
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
