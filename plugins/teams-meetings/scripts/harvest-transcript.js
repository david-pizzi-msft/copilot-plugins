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
 * IDENTITY. Stream renders each transcript turn as a container with a sequential
 * DOM id (`entry-0`, `entry-1`, ...) and an aria-label holding the speaker and
 * offset ("Bogdan Crivat 1 hour 3 minutes 21 seconds"). Both are stable across
 * scroll, so entries are keyed on that integer. Because the ids are contiguous,
 * `missingIds` proves coverage: an empty array means every turn between the
 * first and last was captured. Nothing depends on pixel measurement.
 *
 * FALLBACK. Older builds, and the Recap panel, may not expose `entry-N`. If no
 * such ids are found the harvester falls back to keying on rounded vertical
 * position. That path is approximate: positions are fractional CSS pixels which
 * the browser snaps to device pixels differently at different scroll offsets, so
 * one node can measure y at one step and y+1 at the next and survive as two
 * rows, producing adjacent duplicate lines. Adjacent identical rows within 3px
 * are collapsed to mitigate this, but the threshold cannot be made large without
 * eating genuine repeats such as "Yeah.", so drift beyond a few pixels still
 * leaks through. Prefer the id path; treat `keyedBy: "position"` in the result
 * as a warning to verify the output.
 *
 * Fluent UI class suffixes (itemHeader-350, entryText-212, ...) change between
 * Microsoft builds, so they are matched by prefix and never hard-coded.
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
  const byId = new Map();
  const byPos = new Map();

  const harvest = () => {
    c.querySelectorAll('[id^="entry-"]').forEach(g => {
      const n = parseInt(g.id.slice(6), 10);
      if (!Number.isFinite(n)) return;
      const body = Array.from(g.querySelectorAll(BODY))
        .map(e => e.innerText.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (!body.length) return;
      byId.set(n, { n, label: (g.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(), body });
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
  if (byId.size) {
    const rows = Array.from(byId.values()).sort((a, b) => a.n - b.n);
    const ids = rows.map(r => r.n);
    const missingIds = [];
    for (let i = 1; i < ids.length; i++) {
      if (ids[i] !== ids[i - 1] + 1) missingIds.push([ids[i - 1], ids[i]]);
    }

    // "Bogdan Crivat 1 hour 3 minutes 21 seconds" -> speaker + 1:03:21
    const RX = /^(.*?)\s+(?:(\d+)\s+hours?\s*)?(?:(\d+)\s+minutes?\s*)?(?:(\d+)\s+seconds?)?$/;
    const lines = [];
    let lastSpeaker = null;
    let unparsedLabels = 0;

    for (const r of rows) {
      const m = r.label ? r.label.match(RX) : null;
      if (m && m[1]) {
        const h = +(m[2] || 0), mi = +(m[3] || 0), s = +(m[4] || 0);
        const ts = h
          ? h + ':' + String(mi).padStart(2, '0') + ':' + String(s).padStart(2, '0')
          : mi + ':' + String(s).padStart(2, '0');
        if (m[1] !== lastSpeaker) {
          lines.push('\n[' + ts + '] ' + m[1] + ':');
          lastSpeaker = m[1];
        }
      } else if (r.label) {
        unparsedLabels++;   // transcription started/stopped events carry a blank label
      }
      r.body.forEach(b => lines.push(b));
    }

    return {
      keyedBy: 'id',
      scrollHeight: c.scrollHeight,
      entries: rows.length,
      firstId: ids[0],
      lastId: ids[ids.length - 1],
      missingIds,
      unparsedLabels,
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
    const m = r.text.match(/^(.*?)\s+\d+ (?:minutes?|seconds?|hours?).*?(\d+:\d+(?::\d+)?)$/);
    return '\n[' + (m ? m[2] : '') + '] ' + (m ? m[1] : r.text) + ':';
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
