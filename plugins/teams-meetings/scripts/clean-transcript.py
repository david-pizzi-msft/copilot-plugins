#!/usr/bin/env python3
"""Turn a raw harvested Teams/Stream transcript into a clean, headed .txt file.

Input is the JSON blob written by `browser_evaluate` when harvesting the
transcript panel (see scripts/harvest-transcript.js) — an object with
`scrollHeight`, `entries`, and `text` keys.

Usage:
    python clean-transcript.py RAW_JSON --out FILE.txt --title "..." \
        [--date "25 August 2026"] [--start "17:30 (BST)"] \
        [--owner "Jane Doe"] [--source "Microsoft Teams Recap"]

Prints a short JSON summary to stdout so the calling agent can report and
verify without reading the whole transcript back into its context. The summary
carries both the absolute ``path`` and a ``url``/``folder_url`` pair as
``file://`` URIs, so the agent can surface a clickable link rather than leaving
the reader to hunt for where the file landed.

Two artefacts in the raw text are corrected here:

  * Empty ``[] :`` headers, produced when a header row renders before its
    timestamp is populated.
  * Speaker names carrying a trailing hour count (``Ada Lovelace 2 hours``).
    The harvest-side regex strips only minutes and seconds, so meetings that
    run past the hour leak the unit into the name.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
from datetime import date

HEADER_RE = re.compile(r"^\[(.*?)\]\s*(.*?):$")
TRAILING_HOURS_RE = re.compile(r"\s+\d+\s+hours?$")
SPEAKER_RE = re.compile(r"^\[[\d:]+\] (.+?):$", re.M)
STAMP_RE = re.compile(r"^\[([\d:]+)\]", re.M)

RULE = "=" * 78


def clean(raw_text: str) -> str:
    out: list[str] = []
    for line in raw_text.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        match = HEADER_RE.match(stripped)
        if match:
            timestamp = match.group(1)
            speaker = TRAILING_HOURS_RE.sub("", match.group(2).strip()).strip()
            if not timestamp and not speaker:
                continue
            out.append("")
            out.append(f"[{timestamp}] {speaker}:")
        else:
            out.append(stripped)

    while out and not out[0]:
        out.pop(0)
    return "\n".join(out).strip() + "\n"


def build_header(args: argparse.Namespace, duration: str) -> str:
    when = " | ".join(
        part
        for part in (
            args.source,
            args.date,
            f"from {args.start}" if args.start else None,
            f"Duration ~{duration}" if duration else None,
        )
        if part
    )
    lines = [args.title]
    if when:
        lines.append(when)
    if args.owner:
        lines.append(f"Owner: {args.owner}")
    lines.append(
        f"Transcript extracted {date.today():%d %B %Y} | "
        "AI-generated content may be incorrect"
    )
    return "\n".join(lines) + "\n" + RULE + "\n\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("raw", help="path to the raw JSON written by browser_evaluate")
    parser.add_argument("--out", required=True, help="output .txt path")
    parser.add_argument("--title", required=True, help="meeting or recording title")
    parser.add_argument("--date", help='e.g. "25 August 2026"')
    parser.add_argument("--start", help='e.g. "17:30 (BST)"')
    parser.add_argument("--owner", help="recording owner")
    parser.add_argument(
        "--source",
        default="Microsoft Teams",
        help='e.g. "Microsoft Teams Recap" or "Microsoft Stream (SharePoint)"',
    )
    args = parser.parse_args()

    # utf-8-sig tolerates a BOM, which some editors and shells prepend when the
    # raw file is round-tripped by hand; plain utf-8 would reject it outright.
    with open(args.raw, encoding="utf-8-sig") as handle:
        payload = json.load(handle)

    if "text" not in payload:
        print(
            f"error: {args.raw} has no 'text' key - harvest likely failed "
            f"({payload.get('error', 'unknown reason')})",
            file=sys.stderr,
        )
        return 1

    text = clean(payload["text"])
    stamps = STAMP_RE.findall(text)
    duration = stamps[-1] if stamps else ""

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(build_header(args, duration) + text)

    out_path = os.path.abspath(args.out)
    folder = os.path.dirname(out_path)

    print(
        json.dumps(
            {
                "path": out_path,
                "folder": folder,
                "url": pathlib.Path(out_path).as_uri(),
                "folder_url": pathlib.Path(folder).as_uri(),
                "bytes": os.path.getsize(args.out),
                "lines": len(text.split("\n")),
                "entries_harvested": payload.get("entries"),
                "first_timestamp": stamps[0] if stamps else None,
                "last_timestamp": duration or None,
                "speakers": sorted(set(SPEAKER_RE.findall(text))),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
