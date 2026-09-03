// Verify openPath reports success for explorer.exe, which exits non-zero even
// when it works. Opens two real windows — close them afterwards.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPath } from "../workbench-core.mjs";

const dir = await mkdtemp(join(tmpdir(), "tw-open-"));
const name = "Probe-20260903-transcript.txt";
await writeFile(join(dir, name), "Probe\nx | 3 September 2026 | Duration ~1:00\n", "utf-8");

const folder = await openPath(dir, null, {});
console.log("open folder :", JSON.stringify(folder));

const revealed = await openPath(dir, name, { reveal: true });
console.log("reveal file :", JSON.stringify(revealed));

const missing = await openPath(dir, "does-not-exist-transcript.txt", { reveal: true });
console.log("missing file:", JSON.stringify(missing), missing.ok ? "<-- WRONG" : "(correctly reported)");

const escape = await openPath(dir, "..\\..\\evil.txt", {});
console.log("traversal   :", JSON.stringify(escape), escape.ok ? "<-- WRONG" : "(correctly blocked)");

await rm(dir, { recursive: true, force: true });

const pass = folder.ok && revealed.ok && !missing.ok && !escape.ok;
console.log(pass ? "\nPASS" : "\nFAIL");
process.exit(pass ? 0 : 1);
