// Smoke-test the workbench server without the Copilot app: start it, exercise
// every route, and check the HTML asset renders with the token substituted.
//
//   node scripts/smoke-test.mjs
//
// Nothing here touches the SDK, so it runs anywhere Node does. Uses a temporary
// output folder so it never disturbs a real transcript library.

import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    startServer, ensureStateFile, loadState, mutate,
    opSetInputs, opQueueRun, opStartRun, opFinishRun, opClearRuns,
    buildPrompt, jobById, listTranscripts, parseHeader, parseSpeakers, safeJoin, fileUrl, openPath,
} from "../workbench-core.mjs";

let failures = 0;
const check = (name, cond, detail = "") => {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.log(`  FAIL  ${name}${detail ? " -> " + detail : ""}`); }
};

const SAMPLE = `Weekly Sync
Microsoft Teams Recap | 25 August 2026 | from 17:30 (BST) | Duration ~53:28
Owner: Ada Lovelace
Transcript extracted 27 August 2026 | AI-generated content may be incorrect
==============================================================================

[0:50] Ada Lovelace:
Hello, Dave.

[0:53] Dave Pizzi:
Hi, Ada.
`;

const dir = await mkdtemp(join(tmpdir(), "tw-smoke-"));
const stateFile = join(dir, ".workbench", "state.json");

try {
    console.log("header parsing");
    const meta = parseHeader(SAMPLE);
    check("title", meta.title === "Weekly Sync", meta.title);
    check("source", meta.source === "Microsoft Teams Recap", meta.source);
    check("date", meta.date === "25 August 2026", meta.date);
    check("duration", meta.duration === "53:28", meta.duration);
    check("owner", meta.owner === "Ada Lovelace", meta.owner);
    const speakers = parseSpeakers(SAMPLE);
    check("speakers", speakers.length === 2 && speakers[0] === "Ada Lovelace", speakers.join(","));

    console.log("path safety");
    check("rejects traversal", safeJoin(dir, "..\\..\\evil.txt") === null);
    check("rejects absolute", safeJoin(dir, "C:\\Windows\\win.ini") === null);
    check("accepts plain name", safeJoin(dir, "a-transcript.txt") !== null);
    check("url encodes spaces", fileUrl("C:\\a b\\c.txt").includes("a%20b"));

    // The success path is not checked here because it opens real windows — see
    // scripts/open-probe.mjs. These two cases must still be reported as errors.
    const missing = await openPath(dir, "nope-transcript.txt", { reveal: true });
    check("missing file reported", !missing.ok && missing.error === "not_found", JSON.stringify(missing));
    const escaped = await openPath(dir, "..\\..\\evil.txt", {});
    check("open blocks traversal", !escaped.ok, JSON.stringify(escaped));

    console.log("state and runs");
    await ensureStateFile(stateFile);
    await mutate(stateFile, (d) => opSetInputs(d, { url: "https://example.com/x", outputFolder: dir }));
    let doc = await loadState(stateFile);
    check("inputs persisted", doc.inputs.outputFolder === dir && doc.inputs.url === "https://example.com/x");

    const bad = await mutate(stateFile, (d) => opQueueRun(d, "nope"));
    check("unknown job rejected", !!bad.error, bad.error);

    await mutate(stateFile, (d) => opSetInputs(d, { url: "" }));
    const noUrl = await mutate(stateFile, (d) => opQueueRun(d, "from-recording"));
    check("missing link rejected", !!noUrl.error, noUrl.error);

    await mutate(stateFile, (d) => opSetInputs(d, { url: "https://example.com/x" }));
    const queued = await mutate(stateFile, (d) => opQueueRun(d, "from-recording"));
    check("run queued", !queued.error && queued.state.runs.length === 1);

    const second = await mutate(stateFile, (d) => opQueueRun(d, "transcription-only"));
    check("concurrent run rejected", !!second.error, second.error);

    doc = await loadState(stateFile);
    const runId = doc.runs[0].id;
    await mutate(stateFile, (d) => opStartRun(d, runId));
    await mutate(stateFile, (d) => opFinishRun(d, runId, { status: "complete", outputs: ["x-transcript.txt"] }));
    doc = await loadState(stateFile);
    check("run completed", doc.runs[0].status === "complete" && !!doc.runs[0].finishedAt);

    console.log("prompt");
    const prompt = buildPrompt(jobById("from-recording"), { url: "https://example.com/x", outputFolder: dir });
    check("names the skill", prompt.includes("teams-transcript-from-recording"));
    check("carries the url", prompt.includes("https://example.com/x"));
    check("pins the folder", prompt.includes(dir));
    const guided = buildPrompt(jobById("transcription-only"), { url: "", outputFolder: dir });
    check("guided omits url line", !guided.includes("Recording URL"));

    console.log("listing");
    await writeFile(join(dir, "Weekly-Sync-20260825-transcript.txt"), SAMPLE, "utf-8");
    await writeFile(join(dir, "notes.txt"), "ignore me", "utf-8");
    const items = await listTranscripts(dir);
    check("finds one transcript", items.length === 1, String(items.length));
    check("ignores other files", !items.some((i) => i.name === "notes.txt"));
    check("describes it", items[0]?.title === "Weekly Sync" && items[0]?.duration === "53:28");

    console.log("http");
    let dispatched = null;
    const { server, token, url } = await startServer({ stateFile, dispatch: async (id) => { dispatched = id; } });
    const base = url.replace(/\/$/, "");
    const call = (p, opts = {}) => fetch(base + p, {
        ...opts,
        headers: { "x-workbench-token": token, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    });

    const html = await (await fetch(url)).text();
    check("serves html", html.includes("Transcript Workbench"));
    check("token substituted", html.includes(token) && !html.includes("__WORKBENCH_TOKEN__"));

    const noToken = await fetch(base + "/api/state");
    check("api rejects missing token", noToken.status === 403, String(noToken.status));

    const state = await (await call("/api/state")).json();
    check("state route", state.ok && state.jobs.length === 2 && state.transcripts.length === 1);

    const browse = await (await call("/api/browse?path=" + encodeURIComponent(dir))).json();
    check("browse route", browse.ok && Array.isArray(browse.entries) && Array.isArray(browse.drives));

    await mutate(stateFile, (d) => opClearRuns(d));
    const runRes = await (await call("/api/run", { method: "POST", body: JSON.stringify({ jobId: "from-recording" }) })).json();
    check("run route queues", !runRes.error, runRes.error);
    await new Promise((r) => setTimeout(r, 50));
    check("dispatch fired", dispatched !== null);

    const preview = await (await call("/api/preview?name=Weekly-Sync-20260825-transcript.txt")).json();
    check("preview route", preview.ok && preview.text.includes("Hello, Dave"));

    const escape = await (await call("/api/preview?name=" + encodeURIComponent("..\\..\\secret.txt"))).json();
    check("preview blocks traversal", !escape.ok, JSON.stringify(escape).slice(0, 60));

    const bogus = await (await call("/api/nope")).json();
    check("unknown route 404s", !bogus.ok);

    await new Promise((r) => server.close(r));

    console.log("assets");
    const asset = await readFile(new URL("../assets/workbench.html", import.meta.url), "utf-8");
    check("html has cards region", asset.includes('id="cards"'));
    check("html has folder picker", asset.includes('id="picker"'));
    check("html has token placeholder", asset.includes("__WORKBENCH_TOKEN__"));
} finally {
    await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
