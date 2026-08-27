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

Sanity check the returned `entries`: roughly 30,000px ≈ a 50-minute meeting
≈ ~900 entries; a 2-hour recording is around 54,000px and ~1,000 entries. If
`entries` is under ~50 the container was mis-detected — retarget the element
whose class contains `focusZoneWithAutoScroll-`.

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

- View the first ~14 lines to confirm the header and structure.
- Check the last timestamp is plausible for the meeting length. If it stops far
  short, the scroll did not complete — re-run step 4 with a smaller `STEP`.
- Delete `transcript-raw.md`.
- Report a compact table: path, size, line count, entries harvested, time span,
  and speakers detected.

## Caveats to pass on to the user

- Transcripts are AI-generated and mangle proper nouns and names frequently.
  Say so, and cite an example from the file if you spot one.
- Meeting content may be confidential. Writing it to local disk at the user's
  request is fine — never forward or upload it anywhere without explicit
  confirmation.

## Optional follow-up

Once the file is confirmed written, offer a structured summary or action-item
extraction.
