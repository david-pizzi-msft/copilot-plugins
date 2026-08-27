/**
 * Harvest a virtualised Microsoft Teams / Stream transcript panel from the DOM.
 *
 * This is a REFERENCE COPY of the function body to pass to the `browser_evaluate`
 * MCP tool. It is not executed from disk — paste it as the `function` argument.
 *
 * Two call shapes:
 *
 *   Recorded meeting (Stream player, top-level document)
 *     browser_evaluate:
 *       function: <this function, with `element` unused — see NOTE>
 *       filename: "transcript-raw.md"
 *
 *   Transcription-only meeting (Teams Recap, inside an iframe)
 *     browser_evaluate:
 *       target:   'iframe[name="RecapxPlatIframe"] >> internal:control=enter-frame >> body'
 *       element:  "transcript iframe body"
 *       function: <this function>
 *       filename: "transcript-raw.md"
 *
 * NOTE: when no `target` is passed, `element` is undefined — swap
 *       `element.ownerDocument` for `document` on the first line.
 *
 * STEP SIZE MATTERS. The list is virtualised: only ~50 entries exist in the DOM
 * at any moment. The scroll step must stay below the container's clientHeight or
 * rows are skipped entirely. Use 250 for the Teams Recap panel (~380px tall) and
 * 400 for the full-height Stream player.
 *
 * IDENTITY. Both surfaces render each transcript turn as a container with a
 * sequential DOM id (`entry-0`, `entry-1`, ...), and each speaker change as a
 * header with the matching id (`itemHeader-1`, ...). Entries are keyed on that
 * integer, so nothing depends on pixel measurement. Because the ids are
 * contiguous, `missingIds` proves coverage: an empty array means every turn
 * between the first and last was captured.
 *
 * Headers are sparse by design — one per speaker change, not one per entry — so
 * a high `entriesWithoutHeader` is normal and simply reflects grouping.
 *
 * SPEAKER AND TIMESTAMP. Take both from the header element, never from the
 * group's aria-label. The header holds the speaker in its own child node and
 * ends with the timestamp exactly as displayed, so neither needs parsing out of
 * prose. The aria-label is unreliable: the same panel emits both
 * "David Pizzi 53 minutes 19 seconds" and the bare "David Pizzi 0 50" depending
 * on whether the localisation bundle had loaded when the row rendered, and the
 * bare form is ambiguous when a speaker is literally named "Speaker 1". It is
 * used only to recover a speaker for an entry whose header was missed, which
 * should not happen while the ids are contiguous.
 *
 * FALLBACK. Older builds may expose neither id. If no `entry-N` is found the
 * harvester falls back to keying on rounded vertical position. That path is
 * approximate: positions are fractional CSS pixels which the browser snaps to
 * device pixels differently at different scroll offsets, so one node can measure
 * y at one step and y+1 at the next and survive as two rows, producing adjacent
 * duplicate lines. Adjacent identical rows within 3px are collapsed, but the
 * threshold cannot be widened without eating genuine repeats such as "Yeah.",
 * so drift beyond a few pixels still leaks through. Treat `keyedBy: "position"`
 * in the result as a warning to verify the output by hand.
 *
 * Fluent UI class suffixes (itemHeader-350, entryText-212, ...) change between
 * Microsoft builds, so they are matched by prefix and never hard-coded. The
 * element *ids* used for keying are plain `name-N` and carry no such suffix.
 */
async (element) => {
  const doc = element.ownerDocument;   // top-level document: use `document`
  const STEP = 250;                    // 250 = Teams Recap, 400 = Stream player

  const c = Array.from(doc.querySelectorAll('div'))
    .filter(e => e.clientHeight > 100 && e.scrollHeight > e.clientHeight + 500)
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (!c) return { error: 'no scroll container found' };

  const BODY = '[class*="entryText-"], [class*="eventText-"]';
  const SEL = '[class*="itemHeader-"], ' + BODY;
  const TS = /(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
  const TRAILING_TIME = /(\s+\d+(\s+(hours?|minutes?|seconds?))?)+$/;

  const heads = new Map();
  const entries = new Map();
  const byPos = new Map();

  const harvest = () => {
    doc.querySelectorAll('[id^="itemHeader-"]').forEach(h => {
      const n = parseInt(h.id.slice(11), 10);
      if (!Number.isFinite(n)) return;
      const full = h.innerText.replace(/\s+/g, ' ').trim();
      const speaker = h.children.length
        ? h.children[0].innerText.replace(/\s+/g, ' ').trim()
        : full.replace(TRAILING_TIME, '').trim();
      const m = full.match(TS);
      if (speaker) heads.set(n, { speaker, ts: m ? m[1] : '' });
    });

    doc.querySelectorAll('[id^="entry-"]').forEach(g => {
      const n = parseInt(g.id.slice(6), 10);
      if (!Number.isFinite(n)) return;
      const body = Array.from(g.querySelectorAll(BODY))
        .map(e => e.innerText.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (!body.length) return;
      const label = (g.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      entries.set(n, { n, body, label });
    });

    const base = c.getBoundingClientRect().top - c.scrollTop;
    c.querySelectorAll(SEL).forEach(n => {
      const y = Math.round(n.getBoundingClientRect().top - base);
      const isHdr = /itemHeader-/.test(n.className);
      byPos.set(y + '|' + (isHdr ? 'h' : 't'), {
        y,
        type: isHdr ? 'h' : 't',
        text: n.innerText.replace(/\s+/g, ' ').trim()
      });
    });
  };

  c.scrollTop = 0;
  await new Promise(r => setTimeout(r, 400));
  harvest();

  for (let pos = 0; pos < c.scrollHeight; pos += STEP) {
    c.scrollTop = pos;
    await new Promise(r => setTimeout(r, 120));
    harvest();
  }

  c.scrollTop = c.scrollHeight;
  await new Promise(r => setTimeout(r, 500));
  harvest();

  // Preferred path: sequential DOM ids.
  if (entries.size) {
    const rows = Array.from(entries.values()).sort((a, b) => a.n - b.n);
    const ids = rows.map(r => r.n);
    const missingIds = [];
    for (let i = 1; i < ids.length; i++) {
      if (ids[i] !== ids[i - 1] + 1) missingIds.push([ids[i - 1], ids[i]]);
    }

    const lines = [];
    const speakers = new Set();
    let lastSpeaker = null;
    let entriesWithoutHeader = 0;
    let recoveredFromLabel = 0;

    for (const r of rows) {
      let h = heads.get(r.n);
      if (!h) {
        entriesWithoutHeader++;
        // Recover a speaker only if the run appears to change hands here.
        const guess = r.label ? r.label.replace(TRAILING_TIME, '').trim() : '';
        if (guess && lastSpeaker !== null && guess !== lastSpeaker) {
          h = { speaker: guess, ts: '' };
          recoveredFromLabel++;
        }
      }
      if (h && h.speaker !== lastSpeaker) {
        lines.push('\n[' + h.ts + '] ' + h.speaker + ':');
        lastSpeaker = h.speaker;
        speakers.add(h.speaker);
      }
      r.body.forEach(b => lines.push(b));
    }

    return {
      keyedBy: 'id',
      scrollHeight: c.scrollHeight,
      entries: rows.length,
      headers: heads.size,
      entriesWithoutHeader,
      recoveredFromLabel,
      firstId: ids[0],
      lastId: ids[ids.length - 1],
      missingIds,
      speakers: Array.from(speakers),
      text: lines.join('\n')
    };
  }

  // Fallback: vertical position. Approximate — see FALLBACK note above.
  const sorted = Array.from(byPos.values()).sort((a, b) => a.y - b.y);
  const rows = sorted.filter((r, i) => {
    const prev = sorted[i - 1];
    return !(prev && prev.type === r.type && prev.text === r.text && r.y - prev.y <= 3);
  });

  const lines = rows.map(r => {
    if (r.type !== 'h') return r.text;
    const m = r.text.match(TS);
    return '\n[' + (m ? m[1] : '') + '] ' + r.text.replace(TS, '').replace(TRAILING_TIME, '').trim() + ':';
  });

  return {
    keyedBy: 'position',
    scrollHeight: c.scrollHeight,
    rawRows: sorted.length,
    entries: rows.length,
    collapsed: sorted.length - rows.length,
    text: lines.join('\n')
  };
}
