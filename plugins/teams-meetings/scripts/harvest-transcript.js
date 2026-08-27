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
 * De-duplication is keyed on vertical document position rather than text, which
 * also yields correct ordering. A Set of strings would silently drop legitimate
 * repeats such as "Okay." or "Yeah".
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

  const SEL = '[class*="itemHeader-"], [class*="entryText-"], [class*="eventText-"]';
  const map = new Map();

  const harvest = () => {
    const base = c.getBoundingClientRect().top - c.scrollTop;
    c.querySelectorAll(SEL).forEach(n => {
      const y = Math.round(n.getBoundingClientRect().top - base);
      const isHdr = /itemHeader-/.test(n.className);
      map.set(y + '|' + (isHdr ? 'h' : 't'), {
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

  const rows = Array.from(map.values()).sort((a, b) => a.y - b.y);
  const lines = rows.map(r => {
    if (r.type !== 'h') return r.text;
    const m = r.text.match(/^(.*?)\s+\d+ (?:minutes?|seconds?).*?(\d+:\d+(?::\d+)?)$/);
    return '\n[' + (m ? m[2] : '') + '] ' + (m ? m[1] : r.text) + ':';
  });

  return { scrollHeight: c.scrollHeight, entries: rows.length, text: lines.join('\n') };
}
