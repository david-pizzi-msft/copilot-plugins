// Extension: transcript-workbench
//
// A Canvas dashboard over the two Teams transcript skills, rendered in the
// GitHub Copilot app. Two cards — one per skill — a link to paste, a folder to
// pick, and the transcripts that came out, each with Open and Reveal.
//
// Clicking a card injects that skill's prompt into the live Copilot session, so
// the app is the backend and there is nothing to host. All the state, folder
// browsing and HTTP logic lives in workbench-core.mjs.

import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { join } from "node:path";
import {
    JOBS, jobById, defaultOutputFolder, ensureFolder,
    startServer, ensureStateFile, loadState, mutate,
    opSetInputs, opQueueRun, opStartRun, opFinishRun, opClearRuns,
    buildPrompt, snapshotOutputs, newOutputsSince,
    listTranscripts, previewTranscript, openPath, fileUrl,
} from "./workbench-core.mjs";

// instanceId -> { server, url, stateFile }
const instances = new Map();

// runId -> { instanceId, before: Set<string>, outputFolder }
const inFlight = new Map();

let session; // assigned below; the dispatcher closes over it

const ctxOf = (ctx) => instances.get(ctx.instanceId) || null;

async function readState(ctx) {
    const entry = ctxOf(ctx);
    return entry ? await loadState(entry.stateFile) : null;
}

async function act(ctx, fn) {
    const entry = ctxOf(ctx);
    if (!entry) return { error: "Workbench is not open" };
    return await mutate(entry.stateFile, fn);
}

/**
 * Send a queued run's prompt into the session and mark it running. Completion is
 * detected by the `session.idle` listener below.
 */
async function dispatchRun(instanceId, runId) {
    const entry = instances.get(instanceId);
    if (!entry) return;

    const doc = await loadState(entry.stateFile);
    const run = doc.runs.find((r) => r.id === runId);
    if (!run || run.status !== "queued") return;

    const job = jobById(run.jobId);
    if (!job) {
        await mutate(entry.stateFile, (d) =>
            opFinishRun(d, runId, { status: "failed", error: `Unknown job: ${run.jobId}` }));
        return;
    }

    // Create the destination before snapshotting, so the diff afterwards sees
    // only what this run wrote.
    await ensureFolder(run.outputFolder);
    inFlight.set(runId, {
        instanceId,
        before: await snapshotOutputs(run.outputFolder),
        outputFolder: run.outputFolder,
    });

    await mutate(entry.stateFile, (d) => opStartRun(d, runId));

    try {
        await session.send({ prompt: buildPrompt(job, { url: run.url, outputFolder: run.outputFolder }) });
    } catch (err) {
        inFlight.delete(runId);
        await mutate(entry.stateFile, (d) =>
            opFinishRun(d, runId, { status: "failed", error: err?.message || String(err) }));
    }
}

async function queueFromAgent(ctx, jobId) {
    const entry = ctxOf(ctx);
    if (!entry) return { error: "Workbench is not open" };
    const result = await mutate(entry.stateFile, (doc) => opQueueRun(doc, jobId));
    if (result.error) return result;
    const queued = result.state.runs.find((r) => r.status === "queued");
    if (queued) dispatchRun(ctx.instanceId, queued.id).catch(() => {});
    return result;
}

session = await joinSession({
    canvases: [
        createCanvas({
            id: "transcript-workbench",
            displayName: "Transcript Workbench",
            description:
                "A dashboard for extracting Microsoft Teams meeting transcripts. Paste a recording link or start a transcription-only capture, choose where the file is saved with a folder picker, and see every transcript produced with buttons to open it or reveal it in Explorer. Use when the user wants a UI for pulling transcripts, asks where a transcript was saved, or wants to see or open previous transcripts.",
            inputSchema: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "Recording link to prefill the From a recording card.",
                    },
                    outputFolder: {
                        type: "string",
                        description: "Absolute folder transcripts are saved to. Defaults to ~/Documents/Teams Transcripts.",
                    },
                },
            },
            actions: [
                {
                    name: "get_state",
                    description: "Return the full workbench state: current link and output folder, the two jobs, every run, and the transcripts currently in the output folder.",
                    handler: async (ctx) => {
                        const doc = await readState(ctx);
                        if (!doc) return { error: "Workbench is not open" };
                        return { ok: true, state: doc, jobs: JOBS, transcripts: await listTranscripts(doc.inputs.outputFolder) };
                    },
                },
                {
                    name: "list_transcripts",
                    description: "List the transcripts in the output folder, newest first, with title, meeting date, duration, owner, speakers, size and absolute path. Use this to answer 'where was it saved?' or 'what transcripts do I have?'.",
                    handler: async (ctx) => {
                        const doc = await readState(ctx);
                        const dir = doc?.inputs.outputFolder || defaultOutputFolder();
                        const items = await listTranscripts(dir);
                        return { ok: true, dir, dirUrl: fileUrl(dir), count: items.length, items };
                    },
                },
                {
                    name: "get_output_folder",
                    description: "Return the absolute path and file:// URL of the folder transcripts are saved to. Call this before running a skill by hand so the file lands somewhere durable rather than in the chat's scratch directory.",
                    handler: async (ctx) => {
                        const doc = await readState(ctx);
                        const dir = await ensureFolder(doc?.inputs.outputFolder || defaultOutputFolder());
                        return { ok: true, dir, dirUrl: fileUrl(dir) };
                    },
                },
                {
                    name: "set_inputs",
                    description: "Set the recording link and/or the output folder, so the canvas and the conversation stay in step when the user names either in chat.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            url: { type: "string", description: "Recording link" },
                            outputFolder: { type: "string", description: "Absolute folder for transcripts" },
                        },
                    },
                    handler: (ctx) => act(ctx, (doc) => opSetInputs(doc, ctx.input || {})),
                },
                {
                    name: "extract_from_recording",
                    description: "Queue and run the from-recording extraction against the current link, exactly as clicking that card would. Fails if a run is in flight or no link is set.",
                    handler: (ctx) => queueFromAgent(ctx, "from-recording"),
                },
                {
                    name: "extract_transcription_only",
                    description: "Queue and run the transcription-only extraction, which opens a browser for the user to reach Recap → Transcript. Fails if a run is already in flight.",
                    handler: (ctx) => queueFromAgent(ctx, "transcription-only"),
                },
                {
                    name: "open_transcript",
                    description: "Open one transcript in its default application. Takes the filename as listed by list_transcripts.",
                    inputSchema: {
                        type: "object",
                        properties: { name: { type: "string", description: "Filename within the output folder" } },
                        required: ["name"],
                    },
                    handler: async (ctx) => {
                        const doc = await readState(ctx);
                        return await openPath(doc?.inputs.outputFolder || defaultOutputFolder(), ctx.input?.name, { reveal: false });
                    },
                },
                {
                    name: "reveal_transcript",
                    description: "Show a transcript in the file manager with the file selected — the direct answer to 'where is it?'. Omit the name to open the output folder itself.",
                    inputSchema: {
                        type: "object",
                        properties: { name: { type: "string", description: "Filename; omit to open the folder" } },
                    },
                    handler: async (ctx) => {
                        const doc = await readState(ctx);
                        return await openPath(doc?.inputs.outputFolder || defaultOutputFolder(), ctx.input?.name, { reveal: true });
                    },
                },
                {
                    name: "preview_transcript",
                    description: "Return the first 200 lines of one transcript, so it can be discussed or summarised without reading the whole file into context.",
                    inputSchema: {
                        type: "object",
                        properties: { name: { type: "string", description: "Filename within the output folder" } },
                        required: ["name"],
                    },
                    handler: async (ctx) => {
                        const doc = await readState(ctx);
                        const result = await previewTranscript(doc?.inputs.outputFolder || defaultOutputFolder(), ctx.input?.name)
                            .catch((e) => ({ error: String(e?.message || e) }));
                        return result.error ? { ok: false, ...result } : { ok: true, ...result };
                    },
                },
                {
                    name: "clear_run_history",
                    description: "Remove finished runs from the history, keeping anything still in flight.",
                    handler: (ctx) => act(ctx, (doc) => opClearRuns(doc)),
                },
            ],
            open: async (ctx) => {
                let entry = instances.get(ctx.instanceId);
                if (!entry) {
                    const stateFile = join(defaultOutputFolder(), ".workbench", `state-${ctx.instanceId}.json`);
                    await ensureStateFile(stateFile);
                    const started = await startServer({
                        stateFile,
                        dispatch: (runId) => dispatchRun(ctx.instanceId, runId),
                    });
                    entry = { ...started, stateFile };
                    instances.set(ctx.instanceId, entry);
                }
                if (ctx.input?.url || ctx.input?.outputFolder) {
                    await mutate(entry.stateFile, (doc) => opSetInputs(doc, ctx.input));
                }
                return { title: "Transcript Workbench", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = instances.get(ctx.instanceId);
                if (!entry) return;
                instances.delete(ctx.instanceId);
                for (const [runId, meta] of inFlight) {
                    if (meta.instanceId === ctx.instanceId) inFlight.delete(runId);
                }
                await new Promise((res) => entry.server.close(() => res()));
            },
        }),
    ],
});

// Capture the agent's closing message as the run summary.
let lastAssistantMessage = "";
session.on("assistant.message", (event) => {
    const content = event?.data?.content;
    if (typeof content === "string" && content.trim()) lastAssistantMessage = content.trim();
});

// A turn finishing is the completion signal: diff the output folder to find what
// the run produced, then close the run out.
session.on("session.idle", async () => {
    for (const [runId, meta] of [...inFlight]) {
        const entry = instances.get(meta.instanceId);
        if (!entry) { inFlight.delete(runId); continue; }

        const doc = await loadState(entry.stateFile);
        const run = doc.runs.find((r) => r.id === runId);
        if (!run || run.status !== "running") { inFlight.delete(runId); continue; }

        inFlight.delete(runId);
        const outputs = await newOutputsSince(meta.outputFolder, meta.before);
        await mutate(entry.stateFile, (d) =>
            opFinishRun(d, runId, {
                // No new transcript means the skill bailed — a sign-in wall, a
                // dead link, or a meeting with no transcript at all.
                status: outputs.length ? "complete" : "failed",
                error: outputs.length ? "" : "No transcript file was produced",
                summary: lastAssistantMessage,
                outputs,
            }));
    }
});

await session.log("Transcript Workbench ready \u2014 say \u201Copen the transcript workbench\u201D.");
