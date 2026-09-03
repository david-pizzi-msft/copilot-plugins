// Serve the workbench against a temp folder so the click path can be exercised
// in a real browser. Prints the URL, then stays up until killed.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, ensureStateFile, mutate, opSetInputs } from "../workbench-core.mjs";

const SAMPLE = `VBD Sync - Real-Time Analytics
Microsoft Teams Recap | 3 September 2026 | from 17:30 (BST) | Duration ~32:00
Owner: Ada Lovelace
Transcript extracted 3 September 2026 | AI-generated content may be incorrect
==============================================================================

[0:50] Ada Lovelace:
Hello.
`;

const dir = await mkdtemp(join(tmpdir(), "tw-live-"));
const stateFile = join(dir, ".workbench", "state.json");
await ensureStateFile(stateFile);
await mutate(stateFile, (d) => opSetInputs(d, { outputFolder: dir }));
await writeFile(join(dir, "VBD-Sync-Real-Time-Analytics-20260903-transcript.txt"), SAMPLE, "utf-8");

const calls = [];
const { url, token } = await startServer({
    stateFile,
    dispatch: async () => {},
    resume: async () => ({ ok: true }),
});

console.log("URL:   " + url + "?token=" + token);
console.log("TOKEN: " + token);
console.log("DIR:   " + dir);
console.log("serving — ctrl-c to stop");
