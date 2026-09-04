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
    opSetInputs, opQueueRun, opStartRun, opWaitRun, opFinishRun, opClearRuns, activeRun,
    buildPrompt, goPrompt, jobById, listTranscripts, parseHeader, parseSpeakers, safeJoin, fileUrl, openPath,
    snapshotOutputs, newOutputsSince,
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

    // A guided run that pauses for the user must not read as finished.
    await mutate(stateFile, (d) => opWaitRun(d, runId, "Sign in, then press Go"));
    doc = await loadState(stateFile);
    check("waiting status set", doc.runs[0].status === "waiting" && doc.runs[0].note === "Sign in, then press Go");
    check("waiting counts as active", !!activeRun(doc));
    const whileWaiting = await mutate(stateFile, (d) => opQueueRun(d, "from-recording"));
    check("waiting blocks a new run", !!whileWaiting.error, whileWaiting.error);
    await mutate(stateFile, (d) => opClearRuns(d));
    doc = await loadState(stateFile);
    check("clear keeps a waiting run", doc.runs.length === 1);

    await mutate(stateFile, (d) => opFinishRun(d, runId, { status: "complete", outputs: ["x-transcript.txt"] }));
    doc = await loadState(stateFile);
    check("run completed", doc.runs[0].status === "complete" && !!doc.runs[0].finishedAt);
    check("note cleared on finish", !doc.runs[0].note);

    console.log("prompt");
    const prompt = buildPrompt(jobById("from-recording"), { url: "https://example.com/x", outputFolder: dir });
    check("names the skill", prompt.includes("teams-transcript-from-recording"));
    check("carries the url", prompt.includes("https://example.com/x"));
    check("pins the folder", prompt.includes(dir));
    const guided = buildPrompt(jobById("transcription-only"), { url: "", outputFolder: dir });
    check("guided omits url line", !guided.includes("Recording URL"));
    check("guided points at the Go button", /press \*\*Go\*\*/.test(guided));
    check("guided says not to wait for typing", guided.includes("do not wait for me to type"));
    check("go prompt is a resume", goPrompt().toLowerCase().startsWith("go"));

    console.log("listing");
    await writeFile(join(dir, "Weekly-Sync-20260825-transcript.txt"), SAMPLE, "utf-8");
    await writeFile(join(dir, "notes.txt"), "ignore me", "utf-8");
    const items = await listTranscripts(dir);
    check("finds one transcript", items.length === 1, String(items.length));
    check("ignores other files", !items.some((i) => i.name === "notes.txt"));
    check("describes it", items[0]?.title === "Weekly Sync" && items[0]?.duration === "53:28");

    console.log("output detection");
    // Re-extracting a meeting overwrites the same filename, so a name-only diff
    // reads a successful re-run as a failure. This is the case that broke.
    const snap = await snapshotOutputs(dir);
    check("snapshot carries mtimes", snap.get("Weekly-Sync-20260825-transcript.txt") > 0);
    check("nothing new yet", (await newOutputsSince(dir, snap)).length === 0);

    await new Promise((r) => setTimeout(r, 15));
    await writeFile(join(dir, "Weekly-Sync-20260825-transcript.txt"), SAMPLE + "\nmore\n", "utf-8");
    const rewritten = await newOutputsSince(dir, snap);
    check("overwrite counts as output", rewritten.length === 1, JSON.stringify(rewritten));

    await writeFile(join(dir, "Other-20260825-transcript.txt"), SAMPLE, "utf-8");
    const both = await newOutputsSince(dir, snap);
    check("new file counts too", both.length === 2, JSON.stringify(both));
    await rm(join(dir, "Other-20260825-transcript.txt"));

    console.log("http");
    let dispatched = null, resumed = null;
    const { server, token, url } = await startServer({
        stateFile,
        dispatch: async (id) => { dispatched = id; },
        resume: async (id) => { resumed = id; return { ok: true }; },
    });
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

    // The Go button: only valid while something is actually in flight. The stub
    // dispatcher above does not start the run, so do it here — opWaitRun rightly
    // refuses to park a run that has not begun.
    doc = await loadState(stateFile);
    await mutate(stateFile, (d) => opStartRun(d, doc.runs[0].id));
    const notWaitingYet = await mutate(stateFile, (d) => opWaitRun(d, "no-such-run", "x"));
    check("wait ignores unknown run", !notWaitingYet.error);
    await mutate(stateFile, (d) => opWaitRun(d, doc.runs[0].id, "waiting"));
    doc = await loadState(stateFile);
    check("run is waiting", doc.runs[0].status === "waiting", doc.runs[0].status);

    const goRes = await (await call("/api/go", { method: "POST" })).json();
    check("go route resumes", goRes.ok !== false, JSON.stringify(goRes));
    check("resume fired", resumed !== null);

    const cancelRes = await (await call("/api/cancel", { method: "POST" })).json();
    check("cancel route", !cancelRes.error, cancelRes.error);
    doc = await loadState(stateFile);
    check("cancel marks failed", doc.runs[0].status === "failed" && doc.runs[0].error === "Cancelled");

    const goIdle = await (await call("/api/go", { method: "POST" })).json();
    check("go with nothing waiting", !goIdle.ok && goIdle.error === "nothing_waiting", JSON.stringify(goIdle));

    // The canvas cannot hand a file to the OS, so View reads it back over HTTP.
    const read = await (await call("/api/read?name=Weekly-Sync-20260825-transcript.txt")).json();
    check("read route returns whole file", read.ok && read.text.includes("Hi, Ada") && read.path.includes("Weekly-Sync"));
    const readEscape = await (await call("/api/read?name=" + encodeURIComponent("..\\..\\secret.txt"))).json();
    check("read blocks traversal", !readEscape.ok);

    const preview = await (await call("/api/preview?name=Weekly-Sync-20260825-transcript.txt")).json();
    check("preview route", preview.ok && preview.text.includes("Hello, Dave"));

    const escape = await (await call("/api/preview?name=" + encodeURIComponent("..\\..\\secret.txt"))).json();
    check("preview blocks traversal", !escape.ok, JSON.stringify(escape).slice(0, 60));

    const bogus = await (await call("/api/nope")).json();
    check("unknown route 404s", !bogus.ok);

    await new Promise((r) => server.close(r));

    console.log("assets");
    const asset = await readFile(new URL("../assets/workbench.html", import.meta.url), "utf-8");

    // The panel's script is inline, so nothing type-checks it. A stray brace
    // silently disables every button, which is indistinguishable from a dead
    // server — parse it here so that can never ship.
    const inline = asset.slice(asset.indexOf("<script>") + 8, asset.lastIndexOf("</script>"));
    let parses = true, parseErr = "";
    try { new Function(inline); } catch (e) { parses = false; parseErr = e.message; }
    check("panel script parses", parses, parseErr);

    check("card per job", asset.includes('id="card-from-recording"') && asset.includes('id="card-transcription-only"'));
    check("url input inside its card", asset.indexOf('id="url"') > asset.indexOf('id="card-from-recording"')
        && asset.indexOf('id="url"') < asset.indexOf('id="card-transcription-only"'));
    check("go button wired", asset.includes('/api/go'));
    check("cancel wired", asset.includes('/api/cancel'));
    // Re-rendering on every poll destroyed the buttons mid-click. Both guards
    // must stay: delegation survives a rebuild, the signature avoids one.
    check("actions delegated", /addEventListener\("click"/.test(asset) && asset.includes('closest("[data-view]")'));
    check("transcripts render guarded", asset.includes("renderTranscripts._sig"));
    check("runs render guarded", asset.includes("renderRuns._sig"));
    // The extension host has no desktop session, so nothing may depend on the
    // OS opening a window — the panel has to show the file itself.
    check("viewer present", asset.includes('id="viewerBody"') && asset.includes("/api/read"));
    check("no OS-open dependency in UI", !asset.includes("/api/open"));
    check("copy fallback present", asset.includes("execCommand"));
    check("html has folder picker", asset.includes('id="picker"'));
    check("html has token placeholder", asset.includes("__WORKBENCH_TOKEN__"));
} finally {
    await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
