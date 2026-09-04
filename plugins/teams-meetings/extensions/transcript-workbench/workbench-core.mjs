// transcript-workbench core
//
// Everything the Transcript Workbench canvas does apart from the SDK wiring:
// state, the folder browser, prompt building, reading the transcripts that were
// produced, and serving all of it over loopback HTTP.
//
// Why the canvas exists: the two extraction skills wrote into the agent's
// working directory, which in the GitHub Copilot app is a per-chat scratch
// folder under ~/.copilot/chats/<date>/<slug>. Correct, but opaque — and thrown
// away with the chat. Worse, a markdown file:// link to it does not reliably
// open from the transcript. So the workbench takes the output folder as an
// explicit input, remembers it, and shows each transcript in the panel itself.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep, parse, isAbsolute } from "node:path";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_HTML_PATH = join(HERE, "assets", "workbench.html");
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/** Files produced by clean-transcript.py. */
const TRANSCRIPT_SUFFIX = "-transcript.txt";

/**
 * The two things the workbench can run, mirroring the two skills.
 *
 * `needsUrl` is what makes the UI honest: the from-recording job is unattended
 * and takes a Stream link, while the transcription-only job cannot be given one
 * — it opens a browser and waits for the user to navigate. Presenting them as
 * two cards rather than one button avoids pretending they behave alike.
 */
export const JOBS = [
    {
        id: "from-recording",
        name: "From a recording",
        skill: "teams-transcript-from-recording",
        needsUrl: true,
        blurb: "Paste a Stream or SharePoint recording link. Runs unattended.",
        hint: "https://….sharepoint.com/…/stream.aspx?id=…",
    },
    {
        id: "transcription-only",
        name: "Transcription only",
        skill: "teams-transcript-transcription-only",
        needsUrl: false,
        blurb: "No link — for meetings transcribed but never recorded. Opens a browser for you to reach Recap → Transcript.",
        hint: "",
    },
];

export const jobById = (id) => JOBS.find((j) => j.id === id) || null;

/**
 * Where transcripts are saved by default.
 *
 * ~/Documents/Teams Transcripts exists on every Windows profile and is somewhere
 * a person would actually think to look — unlike a chat scratch folder.
 * TEAMS_TRANSCRIPT_DIR overrides it for anyone who keeps notes elsewhere.
 */
export function defaultOutputFolder() {
    const override = process.env.TEAMS_TRANSCRIPT_DIR;
    if (override && override.trim()) return resolve(override.trim());
    return join(homedir(), "Documents", "Teams Transcripts");
}

export async function ensureFolder(dir) {
    await mkdir(dir, { recursive: true });
    return dir;
}

// --- state -------------------------------------------------------------------

export function emptyState() {
    return {
        version: 1,
        createdAt: new Date().toISOString(),
        inputs: { url: "", outputFolder: defaultOutputFolder() },
        runs: [],
    };
}

export async function loadState(stateFile) {
    try {
        const doc = JSON.parse(await readFile(stateFile, "utf-8"));
        if (!doc || typeof doc !== "object") return emptyState();
        doc.inputs = doc.inputs || {};
        if (!doc.inputs.outputFolder) doc.inputs.outputFolder = defaultOutputFolder();
        doc.runs = Array.isArray(doc.runs) ? doc.runs : [];
        return doc;
    } catch {
        return emptyState();
    }
}

export async function saveState(stateFile, doc) {
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify(doc, null, 2), "utf-8");
    return doc;
}

/** Read-modify-write, so the UI and the agent cannot half-overwrite each other. */
export async function mutate(stateFile, fn) {
    const doc = await loadState(stateFile);
    const result = fn(doc);
    if (result && result.error) return result;
    await saveState(stateFile, doc);
    return { ok: true, state: doc };
}

export async function ensureStateFile(stateFile) {
    if (!existsSync(stateFile)) await saveState(stateFile, emptyState());
    return stateFile;
}

// --- run history -------------------------------------------------------------

export function opSetInputs(doc, { url, outputFolder }) {
    if (typeof url === "string") doc.inputs.url = url.trim();
    if (typeof outputFolder === "string" && outputFolder.trim()) {
        doc.inputs.outputFolder = outputFolder.trim();
    }
    return doc;
}

export function activeRun(doc) {
    return doc.runs.find((r) => r.status === "queued" || r.status === "running" || r.status === "waiting") || null;
}

export function opQueueRun(doc, jobId) {
    const job = jobById(jobId);
    if (!job) return { error: `Unknown job: ${jobId}` };
    if (activeRun(doc)) return { error: "A run is already in flight" };

    const url = (doc.inputs.url || "").trim();
    if (job.needsUrl && !url) return { error: "Paste a recording link first" };
    if (job.needsUrl && !/^https?:\/\//i.test(url)) return { error: "That does not look like a link" };

    const outputFolder = (doc.inputs.outputFolder || "").trim() || defaultOutputFolder();

    doc.runs.unshift({
        id: randomUUID(),
        jobId,
        jobName: job.name,
        url: job.needsUrl ? url : "",
        outputFolder,
        status: "queued",
        queuedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        note: "",
        summary: "",
        error: "",
        outputs: [],
    });
    return doc;
}

export function opStartRun(doc, runId) {
    const run = doc.runs.find((r) => r.id === runId);
    if (run) { run.status = "running"; run.startedAt = new Date().toISOString(); }
    return doc;
}

/**
 * Mark a run as waiting on the user.
 *
 * The guided capture pauses to have the reader sign in and navigate to
 * Recap → Transcript. From the session's point of view that pause is
 * indistinguishable from the turn ending, so a run must not be judged on the
 * first idle — it is waiting, not finished.
 */
export function opWaitRun(doc, runId, note) {
    const run = doc.runs.find((r) => r.id === runId);
    if (run && (run.status === "running" || run.status === "waiting")) {
        run.status = "waiting";
        run.note = note || "Waiting for you in the browser";
    }
    return doc;
}

export function opFinishRun(doc, runId, { status, summary, error, outputs }) {
    const run = doc.runs.find((r) => r.id === runId);
    if (!run) return doc;
    run.status = status || "complete";
    run.finishedAt = new Date().toISOString();
    run.note = "";
    if (summary) run.summary = summary;
    if (error) run.error = error;
    if (Array.isArray(outputs)) run.outputs = outputs;
    return doc;
}

export function opClearRuns(doc) {
    doc.runs = doc.runs.filter((r) => r.status === "queued" || r.status === "running" || r.status === "waiting");
    return doc;
}

/**
 * The prompt a button press sends into the live session.
 *
 * Naming the skill and pinning --out to an absolute path is the whole trick:
 * without it the skill saves relative to the chat's scratch cwd, which is the
 * behaviour this canvas exists to fix.
 */
export function buildPrompt(job, { url, outputFolder }) {
    const lines = [
        `Use the ${job.skill} skill.`,
        "",
    ];
    if (job.needsUrl) lines.push(`Recording URL: ${url}`, "");
    lines.push(
        `Save the transcript into this folder: ${outputFolder}`,
        `Pass --out as an absolute path inside that folder — do not save to the working directory.`,
        "",
    );
    if (!job.needsUrl) {
        // The guided capture pauses for the reader to sign in and navigate. Point
        // them at the panel's Go button rather than asking them to type, so the
        // whole job stays in one surface.
        lines.push(
            "When the browser is open and you need me to sign in and navigate,",
            "say so and stop. I will press **Go** in the Transcript Workbench panel",
            "when the Recap → Transcript tab is showing — do not wait for me to type.",
            "",
        );
    }
    lines.push("When you are done, state the full path of the file you wrote.");
    return lines.join("\n");
}

/** What the Go button sends back into the session to resume a waiting run. */
export function goPrompt() {
    return "go — the Recap → Transcript tab is open, please harvest it now.";
}

// --- transcripts on disk -----------------------------------------------------

export function fileUrl(p) {
    // Not string concatenation: the default folder contains a space, and an
    // unencoded space silently breaks a file:// URL.
    return new URL(`file:///${resolve(p).split(sep).map(encodeURIComponent).join("/")}`).href;
}

/**
 * Parse the five-line header clean-transcript.py writes. Best-effort throughout:
 * a file that does not match still lists, just with fewer fields, because a
 * half-described transcript is more useful than a hidden one.
 */
export function parseHeader(text) {
    const lines = text.split(/\r?\n/, 8);
    const meta = { title: null, source: null, date: null, duration: null, owner: null };
    if (lines[0]?.trim()) meta.title = lines[0].trim();
    if (lines[1]) {
        for (const part of lines[1].split("|").map((s) => s.trim()).filter(Boolean)) {
            if (/^Duration/i.test(part)) meta.duration = part.replace(/^Duration\s*~?/i, "").trim();
            else if (/^from /i.test(part)) continue;
            else if (/\d{4}$/.test(part)) meta.date = part;
            else if (!meta.source) meta.source = part;
        }
    }
    const owner = lines.find((l) => /^Owner:/i.test(l || ""));
    if (owner) meta.owner = owner.replace(/^Owner:\s*/i, "").trim();
    return meta;
}

export function parseSpeakers(text, limit = 40) {
    const out = new Set();
    const re = /^\[[\d:]*\]\s+(.+?):\s*$/gm;
    let m;
    while ((m = re.exec(text)) && out.size < limit) out.add(m[1].trim());
    return [...out];
}

async function describe(dir, name) {
    const full = join(dir, name);
    const info = await stat(full);
    try {
        const whole = await readFile(full, "utf-8");
        return {
            name, path: full, url: fileUrl(full),
            bytes: info.size,
            modified: info.mtime.toISOString(),
            lines: whole.split("\n").length,
            speakers: parseSpeakers(whole),
            ...parseHeader(whole),
        };
    } catch {
        return { name, path: full, url: fileUrl(full), bytes: info.size, modified: info.mtime.toISOString() };
    }
}

/** Every transcript in `dir`, newest first. */
export async function listTranscripts(dir) {
    if (!dir) return [];
    try {
        await ensureFolder(dir);
        const names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(TRANSCRIPT_SUFFIX));
        const items = await Promise.all(names.map((n) => describe(dir, n).catch(() => null)));
        return items.filter(Boolean).sort((a, b) => (a.modified < b.modified ? 1 : -1));
    } catch {
        return [];
    }
}

/**
 * Snapshot the output folder as name -> modified time.
 *
 * Names alone are not enough. Re-extracting the same meeting overwrites the same
 * file, so a name-only diff sees nothing new and reads a successful re-run as a
 * failure. The mtime distinguishes "already there" from "just written".
 */
export async function snapshotOutputs(dir) {
    const out = new Map();
    try {
        for (const name of await readdir(dir)) {
            if (!name.toLowerCase().endsWith(TRANSCRIPT_SUFFIX)) continue;
            try { out.set(name, (await stat(join(dir, name))).mtimeMs); } catch { /* vanished */ }
        }
    } catch { /* folder not there yet */ }
    return out;
}

/** Transcripts written or rewritten since the snapshot. */
export async function newOutputsSince(dir, before) {
    const now = await snapshotOutputs(dir);
    const changed = [];
    for (const [name, mtime] of now) {
        const was = before.get(name);
        if (was === undefined || mtime > was) changed.push(name);
    }
    return changed;
}

export async function previewTranscript(dir, name, maxLines = 200) {
    const full = safeJoin(dir, name);
    if (!full) return { error: "path_outside_folder" };
    const text = await readFile(full, "utf-8");
    const lines = text.split(/\r?\n/);
    return {
        name, path: full,
        truncated: lines.length > maxLines,
        totalLines: lines.length,
        text: lines.slice(0, maxLines).join("\n"),
    };
}

/** Resolve `name` inside `dir`, refusing anything that escapes it. */
export function safeJoin(dir, name) {
    if (typeof name !== "string" || !name || name.includes("\0")) return null;
    const root = resolve(dir);
    const full = resolve(root, name);
    if (full !== root && !full.startsWith(root + sep)) return null;
    return full;
}

/**
 * Open a path in the OS file manager.
 *
 * Two details matter, both learned from the vbd-content-agent panel, which does
 * this successfully from the same extension host:
 *
 *   - No `windowsHide`. That flag sets CREATE_NO_WINDOW, and explorer.exe
 *     inherits it, so the window it would have shown never appears — the call
 *     "succeeds" and nothing happens.
 *   - Always resolve true. explorer.exe exits non-zero even on success, and
 *     inspecting the error only produces false failures.
 *
 * The path always comes from server-side state, never from the client, so this
 * cannot be pointed at an arbitrary location by a page that reaches the socket.
 */
function launch(cmd, args) {
    return new Promise((res) => {
        execFile(cmd, args, () => res({ ok: true }));
    });
}

/** Open a file's containing folder, or a folder itself, in the file manager. */
export async function openPath(dir, name, { reveal = false } = {}) {
    const full = name ? safeJoin(dir, name) : resolve(dir);
    if (!full) return { ok: false, error: "path_outside_folder" };
    try { await stat(full); } catch { return { ok: false, error: "not_found" }; }

    const isFile = Boolean(name);
    if (process.platform === "win32") {
        if (!isFile) return launch("explorer.exe", [full]);
        return reveal ? launch("explorer.exe", [`/select,${full}`])
                      : launch("cmd.exe", ["/c", "start", "", full]);
    }
    if (process.platform === "darwin") {
        return reveal && isFile ? launch("open", ["-R", full]) : launch("open", [full]);
    }
    return launch("xdg-open", [reveal && isFile ? dirname(full) : full]);
}

// --- folder browser ----------------------------------------------------------

async function listDrives() {
    if (process.platform !== "win32") return ["/"];
    const found = [];
    for (let c = 65; c <= 90; c++) {
        const root = `${String.fromCharCode(c)}:${sep}`;
        if (existsSync(root)) found.push(root);
    }
    return found;
}

/** Directory listing for the in-panel picker. Folders only — we pick a destination. */
export async function browseDir(dirPath) {
    const target = resolve(dirPath || defaultOutputFolder());
    const found = await readdir(target, { withFileTypes: true });
    const entries = [];
    for (const d of found) {
        if (d.name.startsWith(".")) continue;
        let isDir = d.isDirectory();
        if (d.isSymbolicLink()) {
            try { isDir = (await stat(join(target, d.name))).isDirectory(); } catch { continue; }
        }
        if (!isDir) continue;
        entries.push({ name: d.name, isDir: true });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    // At a filesystem root, parse().dir equals the path itself — nowhere further up.
    const parsed = parse(target);
    return { path: target, parent: parsed.dir === target ? null : dirname(target), entries };
}

// --- HTTP --------------------------------------------------------------------

function isCanonicalHost(req, canonical) {
    return String(req.headers.host || "").toLowerCase() === String(canonical || "").toLowerCase();
}

function hasToken(req, token) {
    const h = req.headers["x-workbench-token"];
    const v = Array.isArray(h) ? h[0] : h;
    return typeof v === "string" && v.length > 0 && v === token;
}

function isCrossSiteRequest(req) {
    const site = req.headers["sec-fetch-site"];
    const v = Array.isArray(site) ? site[0] : site;
    return typeof v === "string" && v !== "same-origin" && v !== "none";
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 256 * 1024) throw new Error("body_too_large");
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { return {}; }
}

export async function startServer({ stateFile, dispatch, resume }) {
    const token = randomUUID();
    let html;
    try {
        html = (await readFile(UI_HTML_PATH, "utf-8")).replace(/__WORKBENCH_TOKEN__/g, token);
    } catch {
        html = "<!doctype html><meta charset=utf-8><p>workbench.html asset is missing.</p>";
    }
    let canonicalHost = null;

    const server = createServer(async (req, res) => {
        try {
            if (canonicalHost && !isCanonicalHost(req, canonicalHost)) {
                res.writeHead(403, JSON_HEADERS);
                res.end(JSON.stringify({ ok: false, error: "bad_host" }));
                return;
            }
            const url = new URL(req.url, `http://${req.headers.host}`);

            if (url.pathname.startsWith("/api/")) {
                if (!hasToken(req, token)) {
                    res.writeHead(403, JSON_HEADERS);
                    res.end(JSON.stringify({ ok: false, error: "missing_capability_token" }));
                    return;
                }
                if (req.method === "POST" && isCrossSiteRequest(req)) {
                    res.writeHead(403, JSON_HEADERS);
                    res.end(JSON.stringify({ ok: false, error: "cross_site_blocked" }));
                    return;
                }
            }

            if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(html);
                return;
            }

            if (req.method === "GET" && url.pathname === "/api/state") {
                const doc = await loadState(stateFile);
                const items = await listTranscripts(doc.inputs.outputFolder);
                res.writeHead(200, JSON_HEADERS);
                res.end(JSON.stringify({ ok: true, state: doc, jobs: JOBS, transcripts: items }));
                return;
            }

            if (req.method === "POST" && url.pathname === "/api/inputs") {
                const body = await readBody(req);
                const result = await mutate(stateFile, (doc) => opSetInputs(doc, body));
                res.writeHead(result.error ? 400 : 200, JSON_HEADERS);
                res.end(JSON.stringify(result));
                return;
            }

            if (req.method === "POST" && url.pathname === "/api/run") {
                const body = await readBody(req);
                const result = await mutate(stateFile, (doc) => opQueueRun(doc, body.jobId));
                if (!result.error) {
                    const queued = result.state.runs.find((r) => r.status === "queued");
                    if (queued) dispatch(queued.id).catch(() => {});
                }
                res.writeHead(result.error ? 400 : 200, JSON_HEADERS);
                res.end(JSON.stringify(result));
                return;
            }

            if (req.method === "POST" && url.pathname === "/api/go") {
                const doc = await loadState(stateFile);
                const run = doc.runs.find((r) => r.status === "waiting" || r.status === "running");
                if (!run) {
                    res.writeHead(400, JSON_HEADERS);
                    res.end(JSON.stringify({ ok: false, error: "nothing_waiting" }));
                    return;
                }
                const sent = await resume(run.id);
                res.writeHead(sent?.ok === false ? 400 : 200, JSON_HEADERS);
                res.end(JSON.stringify(sent || { ok: true }));
                return;
            }

            if (req.method === "POST" && url.pathname === "/api/cancel") {
                const doc = await loadState(stateFile);
                const run = doc.runs.find((r) => r.status === "waiting" || r.status === "running" || r.status === "queued");
                if (!run) {
                    res.writeHead(400, JSON_HEADERS);
                    res.end(JSON.stringify({ ok: false, error: "nothing_running" }));
                    return;
                }
                const result = await mutate(stateFile, (d) =>
                    opFinishRun(d, run.id, { status: "failed", error: "Cancelled" }));
                res.writeHead(200, JSON_HEADERS);
                res.end(JSON.stringify(result));
                return;
            }

            if (req.method === "POST" && url.pathname === "/api/clear") {
                const result = await mutate(stateFile, (doc) => opClearRuns(doc));
                res.writeHead(200, JSON_HEADERS);
                res.end(JSON.stringify(result));
                return;
            }

            if (req.method === "POST" && url.pathname === "/api/open") {
                const body = await readBody(req);
                const doc = await loadState(stateFile);
                const dir = body.dir || doc.inputs.outputFolder;
                const result = await openPath(dir, body.name, { reveal: !!body.reveal });
                res.writeHead(result.ok ? 200 : 400, JSON_HEADERS);
                res.end(JSON.stringify(result));
                return;
            }

            if (req.method === "GET" && url.pathname === "/api/preview") {
                const doc = await loadState(stateFile);
                const name = url.searchParams.get("name");
                const result = await previewTranscript(doc.inputs.outputFolder, name)
                    .catch((e) => ({ error: String(e?.message || e) }));
                res.writeHead(result.error ? 400 : 200, JSON_HEADERS);
                res.end(JSON.stringify(result.error ? { ok: false, ...result } : { ok: true, ...result }));
                return;
            }

            if (req.method === "POST" && url.pathname === "/api/open") {
                const body = await readBody(req);
                const doc = await loadState(stateFile);
                // A file reveals with itself selected; no name means the folder.
                const result = await openPath(doc.inputs.outputFolder, body.name, { reveal: true });
                res.writeHead(result.ok ? 200 : 400, JSON_HEADERS);
                res.end(JSON.stringify(result));
                return;
            }

            if (req.method === "GET" && url.pathname === "/api/browse") {
                const requested = url.searchParams.get("path");
                try {
                    const listing = await browseDir(requested || defaultOutputFolder());
                    listing.drives = await listDrives();
                    listing.home = homedir();
                    listing.defaultFolder = defaultOutputFolder();
                    res.writeHead(200, JSON_HEADERS);
                    res.end(JSON.stringify({ ok: true, ...listing }));
                } catch {
                    res.writeHead(400, JSON_HEADERS);
                    res.end(JSON.stringify({ ok: false, error: "cannot_read_directory" }));
                }
                return;
            }

            res.writeHead(404, JSON_HEADERS);
            res.end(JSON.stringify({ ok: false, error: "not_found" }));
        } catch (err) {
            if (!res.headersSent) {
                res.writeHead(500, JSON_HEADERS);
                res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
            }
        }
    });

    return await new Promise((res, rej) => {
        const onListening = () => {
            server.removeListener("error", onError);
            const { port } = server.address();
            canonicalHost = `127.0.0.1:${port}`;
            res({ server, token, url: `http://127.0.0.1:${port}/` });
        };
        const onError = (err) => { server.removeListener("listening", onListening); rej(err); };
        server.once("listening", onListening);
        server.once("error", onError);
        server.listen(0, "127.0.0.1");
    });
}

export { isAbsolute };
