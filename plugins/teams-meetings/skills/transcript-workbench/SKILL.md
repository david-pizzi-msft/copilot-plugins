---
name: transcript-workbench
description: Open the Transcript Workbench canvas — a dashboard in the GitHub Copilot app for pulling Microsoft Teams meeting transcripts, with a card for each extraction mode, a box to paste a recording link, a folder picker for where the file is saved, and a viewer for every transcript produced. Use when the user asks for a UI for transcripts, says "transcript workbench", "open the workbench", wants buttons instead of prompts, asks where a transcript was saved, or wants to see or open transcripts pulled earlier.
---

# Transcript Workbench

Opens the **Transcript Workbench** canvas: a dashboard over the two transcript skills, so they can be
run from buttons rather than prompts — and, more to the point, so the finished file is somewhere the
reader can actually open.

## What to do

Open the canvas extension whose id is **`transcript-workbench`**. That is the whole task. Do not run
either extraction skill yourself first, and do not ask for a link; the canvas has a field for it.

If the user already gave a recording link or a destination folder, pass them through when opening:

- `url` — a Stream / SharePoint recording link, prefilled into the **From a recording** card
- `outputFolder` — absolute folder for transcripts; defaults to `~/Documents/Teams Transcripts`

Then say in one line that the workbench is open, and that they can paste a link and press **Extract**,
or press **Start guided capture** for a meeting that was never recorded.

## Why it exists

Both extraction skills used to save into the agent's working directory. In the GitHub Copilot app that
is a per-chat scratch folder under `~/.copilot/chats/<date>/<slug>` — correct, but effectively
undiscoverable, and discarded with the chat. Reporting a `file://` link did not reliably help either.

The workbench fixes the cause rather than the symptom: the destination is an explicit, remembered
input, and every transcript can be read in the panel or revealed in Explorer with one click.

## What the canvas can do once open

These are callable from chat as well as from the buttons, so the conversation and the UI stay in step:

| Capability | Does |
|---|---|
| `get_state` | Everything: inputs, both jobs, every run, transcripts on disk |
| `list_transcripts` | Title, date, duration, owner, speakers, size and path of each transcript |
| `get_output_folder` | The absolute folder transcripts are saved to |
| `set_inputs` | Set the recording link and/or the output folder |
| `extract_from_recording` | Run the unattended extraction against the current link |
| `extract_transcription_only` | Run the guided capture for a meeting that was never recorded |
| `resume_run` | Press Go: resume a run paused waiting for you in the browser |
| `reveal_transcript` | Show one in Explorer with the file selected |
| `preview_transcript` | First 200 lines, for summarising without loading the whole file |
| `clear_run_history` | Drop finished runs, keep anything in flight |

So "set the folder to D:\Notes and extract that link" is a valid instruction once it is open.

## Answering "where was it saved?"

Call `list_transcripts` and give the absolute path, then offer `reveal_transcript` — Explorer opening
with the file selected answers the question better than a path in prose does.

## If the canvas does not open

Almost always one of two things:

1. **Wrong surface.** The canvas renders only in the **GitHub Copilot app**. Copilot CLI and Microsoft
   Scout can run the skills but cannot draw the UI — use the skills directly there.
2. **Plugin not reloaded.** The app reads `plugin.json` and the extension at start-up, so a freshly
   installed or updated plugin needs the app restarting.

## Note

The buttons run the real skills, so everything they need still applies: Microsoft Edge for the
Playwright browser, Python 3 on `PATH`, and being signed in to Microsoft 365 in the browser the
extraction opens.
