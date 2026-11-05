/* The only place that reads or writes data.
   Live (VITE_API_URL set): the orchestrator API in Backend/src (contract: Backend/src/contract/routes.ts).
     A guideline is a run: POST /runs gives a presigned S3 URL, the upload starts ingest -> extract -> fill_logic -> checks.
     The backend's officer agent then answers the program officer's questions and signs as program_officer; the
     review starts from its latest version. Approving saves the clinician's version, waits for the officer agent
     to sign it, then signs as the clinician (the backend refuses program_officer saves and signatures over HTTP).
   Without VITE_API_URL: an in-memory store seeded with sample data.
   Edits, the assistant and the checks run in the browser; nothing reaches the backend until approval. */
import { clone, fnv, loadSpec } from "../domain/data";
import * as wf from "../domain/workflow";
import { FALLBACK_TEXT } from "../domain/agent";
import { sampleScores } from "../domain/scores";
import { AUTH, currentUser, idToken, signIn } from "../auth";
import { item } from "../../../shared/pathway/index.ts";
import type { AuditRow, BackendGolden, BackendQuotes, CrossFlags, Escalation, Guideline, GuidelineType, ItemId, Model, Patch, QuoteScores, Spec, Workflow } from "../domain/types";

export const API_URL: string | undefined = import.meta.env.VITE_API_URL?.replace(/\/+$/, "") || undefined;
/** True when guidelines come from the backend pipeline rather than sample data. */
export const LIVE = !!API_URL;

/** PUT to a presigned URL with upload progress (fetch has no upload progress). */
function putFile(url: string, file: File, headers: Record<string, string>, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    Object.entries(headers).forEach(([k, v]) => x.setRequestHeader(k, v));
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error("Upload to S3 failed (" + x.status + ")")));
    x.onerror = () => reject(new Error("Upload to S3 failed (network error)"));
    x.send(file);
  });
}

/* ---------- Orchestrator API shapes (Backend/src/domain/types.ts, signoff/signoff.ts) ---------- */
type RunState = "created" | "ingesting" | "extracting" | "filling_logic" | "in_review" | "checking" | "awaiting_officer" | "awaiting_clinician" | "locked" | "failed";
interface Run { runId: string; state: RunState; pages?: number[]; currentStep?: string; createdAt: number }
interface StepRecord { step: string; attempt: number; status: "running" | "succeeded" | "failed"; startedAt: number; endedAt?: number; error?: string }
interface VersionRec { n: number; author: string; authorRole?: string; createdAt: number; status?: string }
interface FindingsView { modelSha: string; claimText: string; blocking: number; checksNotRun?: string[]; groups: { severity: "blocking" | "warning" | "info"; findings: { message: string; check: string }[] }[] }
interface StatusView { n: number; modelSha: string; status: string; runState: RunState; nextStep: string }
type ScoresView =
  | ({ runId: string; n: number; status: "scored"; modelSha: string } & Omit<Extract<QuoteScores, { status: "scored" }>, "status" | "n" | "modelSha" | "base">)
  | { runId: string; n: number; status: "not_scored" };

/** Who acts: the signed-in person's email with sign-in on (the backend takes it from the token anyway), else
    VITE_CLINICIAN_ID or "clinician" (sample mode, dev:local without sign-in). */
const me = (): string => (AUTH ? currentUser()?.email.toLowerCase() : undefined) || (import.meta.env.VITE_CLINICIAN_ID as string | undefined) || "clinician";

const WORK: [RunState, string][] = [["created", "Upload to S3"], ["ingesting", "Read pages"], ["extracting", "Extract"], ["filling_logic", "Draft logic model"], ["checking", "Backend checks"], ["awaiting_officer", "AI agent checks"]];
const READY: RunState[] = ["in_review", "awaiting_clinician", "locked"];
const names = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem("runNames") || "{}"); } catch { return {}; } };
const nameRun = (id: string, n: string) => { try { localStorage.setItem("runNames", JSON.stringify({ ...names(), [id]: n })); } catch { /* private mode */ } };

function toGuideline(r: Run, steps?: StepRecord[], escalated = false): Guideline {
  // The officer agent gave up on this draft and left it for a person: the clinician can open it (and answer through chat, feedback or edits).
  const failed = r.state === "failed", ready = READY.includes(r.state) || (r.state === "awaiting_officer" && escalated);
  const at = WORK.findIndex(([s]) => s === r.state);
  const err = steps?.filter(s => s.status === "failed").pop()?.error;
  return {
    id: r.runId, name: (names()[r.runId] ?? "Run " + r.runId.slice(0, 8)) + (uploadVer[r.runId] ?? ""), type: "PDF",
    meta: new Date(r.createdAt).toLocaleString() + " · " + (r.pages ? r.pages.length + " pages" : "all pages") + " · " + (escalated && r.state === "awaiting_officer" ? "needs your review (AI agent could not finish)" : r.state.replace(/_/g, " ")),
    status: failed ? "Failed" : ready ? "Indexed" : "Processing",
    pages: r.pages?.length ?? null,
    ...(r.state === "locked" ? { locked: true } : {}),
    steps: WORK.map(([s, label], i) => ({ key: s, label, state: ready || i < at ? "done" : i === at ? (failed ? "failed" : "running") : failed && at < 0 && i === WORK.findIndex(([x]) => x === r.currentStep) ? "failed" : "pending" })),
    ...(failed ? { error: "The backend run failed" + (r.currentStep ? " at " + r.currentStep : "") + (err ? ": " + err : "") + ". Resume it with POST /runs/" + r.runId + "/resume." } : {}),
  };
}
/** A backend refusal in plain words: the error code, its message, and any blockers it lists. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  const token = AUTH ? idToken() : null;
  if (AUTH && !token) { void signIn(); throw new Error("Your sign-in has expired. Taking you to the sign-in page..."); }
  try { r = await fetch(API_URL + path, { ...init, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...init?.headers } }); }
  catch { throw new Error("Can't reach the backend API at " + API_URL + ". Check VITE_API_URL and that the API allows this origin (CORS)."); }
  const body = await r.json().catch(() => null) as (T & { error?: string; message?: string; issues?: unknown[]; blockers?: { message?: string }[] }) | null;
  if (r.status === 401 && AUTH) { void signIn(); throw new Error("Please sign in again. Taking you to the sign-in page..."); }
  if (!r.ok) {
    const extra = [...(body?.issues ?? []).map(String), ...(body?.blockers ?? []).map(b => b.message ?? "")].filter(Boolean);
    throw new Error((body?.message || body?.error || "Backend returned " + r.status) + " (" + path + ")" + (extra.length ? ": " + extra.join(" | ") : ""));
  }
  return body as T;
}

export const ACCEPT = ".pdf,.doc,.docx,.odt,.rtf,.xlsx,.xls,.csv,.ods,.png,.jpg,.jpeg,.tif,.tiff,.webp,.html,.htm,.txt,.md";
const TYPE_BY_EXT: Record<string, GuidelineType> = {
  pdf: "PDF", doc: "Word", docx: "Word", odt: "Word", rtf: "Word",
  xlsx: "Spreadsheet", xls: "Spreadsheet", csv: "Spreadsheet", ods: "Spreadsheet",
  png: "Image", jpg: "Image", jpeg: "Image", tif: "Image", tiff: "Image", webp: "Image",
  html: "Web or text", htm: "Web or text", txt: "Web or text", md: "Web or text",
};

/* ---------- In-memory store (sample data) ---------- */
let guidelines: Guideline[] = [
  { id: "g-imci", name: "IMCI chart booklet (sample).pdf", type: "PDF", meta: "80 pages · 6.1 MB · Textract", status: "Indexed", pages: 80 },
  { id: "g-nat", name: "National child health guideline 2025 (sample).pdf", type: "PDF", meta: "142 pages · 11.4 MB · Textract + model", status: "Indexed", pages: 142 },
  { id: "g-dak", name: "Child health DAK decision tables (sample).xlsx", type: "Spreadsheet", meta: "6 sheets · cells read directly", status: "Indexed", pages: null },
  { id: "g-memo", name: "District cough protocol memo (sample).docx", type: "Word", meta: "12 pages · converted to PDF, then Textract", status: "Uploaded", pages: 12 },
];
const workflows: Record<string, Workflow> = {};
let seq = 1;

/** Uploads of the same file are versions of it, numbered in upload order: "cough.pdf · v1", "cough.pdf · v2".
    Guideline id -> the label suffix ("" for a file uploaded once). */
const uploadVer: Record<string, string> = {};
function numberUploads(xs: { id: string; name: string }[]) {
  const total: Record<string, number> = {}, seen: Record<string, number> = {};
  xs.forEach(x => { total[x.name] = (total[x.name] ?? 0) + 1; });
  xs.forEach(x => { seen[x.name] = (seen[x.name] ?? 0) + 1; uploadVer[x.id] = total[x.name] > 1 ? " · v" + seen[x.name] : ""; });
}
const withVer = (g: Guideline): Guideline => ({ ...g, name: g.name + (uploadVer[g.id] ?? "") });

/** The newest workflow started for this guideline in this browser, or null. Every guideline (every upload) has its own. */
const latestFor = (guidelineId: string): Workflow | undefined =>
  Object.values(workflows).filter(x => x.guideline?.id === guidelineId && x.state !== "none").pop();
/** Read-only: whether this guideline has a workflow, and where it stands. */
export const workflowFor = (guidelineId: string): Workflow | null => latestFor(guidelineId) ?? null;
/** Switch to this guideline's workflow. */
export async function openWorkflow(guidelineId: string): Promise<Workflow> {
  const w = latestFor(guidelineId);
  if (!w) throw new Error("This guideline has no workflow yet.");
  return respond(w);
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function respond<T>(v: T, ms = 60): Promise<T> { await wait(ms); return clone(v); }
function load(id: string): Workflow {
  const w = workflows[id];
  if (!w) throw new Error("Workflow " + id + " not found");
  return w;
}
async function mutate(id: string, fn: (w: Workflow) => Workflow): Promise<Workflow> {
  const next = fn(load(id));
  workflows[id] = next;
  return respond(next);
}

/* ---------- Guidelines ---------- */
/** Live: get a presigned URL, PUT the file to S3. The S3 event starts the pipeline; poll getGuideline for progress. */
export async function uploadGuideline(file: File, onProgress?: (pct: number) => void): Promise<Guideline> {
  if (LIVE) {
    // pages omitted: the backend reads every page. The presigned URL is signed for application/pdf.
    const r = await call<{ runId: string; uploadUrl: string }>("/runs", { method: "POST", body: JSON.stringify({ filename: file.name }) });
    nameRun(r.runId, file.name);
    await putFile(r.uploadUrl, file, { "Content-Type": "application/pdf" }, onProgress);
    return toGuideline({ runId: r.runId, state: "created", createdAt: Date.now() });
  }
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const type = TYPE_BY_EXT[ext] || "Other";
  const size = Math.max(1, Math.round(file.size / 1024)) + " KB";
  await wait(900);
  const g: Guideline = {
    id: "g-" + fnv(file.name + Date.now()), name: file.name, type, pages: null,
    meta: size + (type === "Other" ? " · in S3 · this file type can't be read" : " · in S3 · indexed just now"),
    status: type === "Other" ? "Unsupported" : "Indexed",
  };
  guidelines = guidelines.concat(g);
  return respond(g);
}
/** True when the officer agent has escalated this run (backend activity feed). */
const agentEscalated = async (runId: string): Promise<boolean> => {
  try { return (await call<{ items: { kind: string }[] }>("/runs/" + runId + "/activity")).items.some(e => e.kind === "agent_escalated"); } catch { return false; }
};
export const listGuidelines = async (): Promise<Guideline[]> => {
  if (!LIVE) { numberUploads(guidelines); return respond(guidelines.map(withVer)); }
  const runs = await call<Run[]>("/runs");
  numberUploads([...runs].sort((a, b) => a.createdAt - b.createdAt).map(r => ({ id: r.runId, name: names()[r.runId] ?? r.runId })));
  const esc = await Promise.all(runs.map(r => (r.state === "awaiting_officer" ? agentEscalated(r.runId) : Promise.resolve(false))));
  return runs.map((r, i) => toGuideline(r, undefined, esc[i])).reverse();
};
export const getGuideline = async (id: string): Promise<Guideline> => {
  if (!LIVE) return respond(withVer(guidelines.find(g => g.id === id)!));
  const r = await call<{ run: Run; steps: StepRecord[] }>("/runs/" + id);
  return toGuideline(r.run, r.steps, r.run.state === "awaiting_officer" && (await agentEscalated(id)));
};

/* ---------- Quote-support scores (advisory) ---------- */
/** Scores for version n, or for version 1 when n is a later version (only the AI draft is scored today).
    Never throws: a missing route or a network error leaves the review without scores, nothing else. */
async function loadScores(runId: string, n: number, model: Model): Promise<QuoteScores | null> {
  try {
    const at = async (k: number) => call<ScoresView>("/runs/" + runId + "/versions/" + k + "/scores");
    let s = await at(n), base = model;
    if (s.status !== "scored" && n > 1) {
      const s1 = await at(1);
      if (s1.status === "scored") {
        const v1 = await call<{ body: unknown }>("/runs/" + runId + "/versions/1");
        s = s1; base = loadSpec(v1.body, "The backend's logic model (version 1)");
      }
    }
    if (s.status === "scored") {
      const { runId: _r, status: _s, ...rest } = s;
      void _r; void _s;
      return { ...rest, status: "scored", base };
    }
    // Not scored: say "failed" when the checks step recorded a scoring failure, so the panel can tell them apart.
    const r = await call<{ steps: { artifactRefs?: Record<string, string> }[] }>("/runs/" + runId);
    const refs = r.steps.map(x => x.artifactRefs ?? {}).filter(a => a.scoresStatus).pop();
    return refs?.scoresStatus === "failed" ? { status: "failed", n, error: refs.scoresError } : { status: "not_scored", n };
  } catch {
    return null;
  }
}

/* ---------- Golden cases (the backend runs them; the card shows its result) ---------- */
/** The backend's golden-case result of version n, read from its findings (both audiences carry the same ones). Null when it reported none. */
export function goldenFrom(n: number, findings: readonly { severity: string; message: string; check: string }[]): BackendGolden | null {
  const own = findings.filter(f => f.check === "goldenCases");
  if (!own.length) return null;
  const seen = new Set<string>();
  const uniq = own.filter(f => (seen.has(f.message) ? false : (seen.add(f.message), true)));
  const count = uniq.map(f => /(\d+) test cases? (?:was|were) run through the draft: (\d+) give the expected result/.exec(f.message)).find(Boolean);
  const issues = uniq
    .filter(f => f.severity !== "info")
    .map(f => ({ sev: (f.severity === "blocking" ? "blocking" : "warning") as "blocking" | "warning", text: f.message }));
  return { n, ...(count ? { run: Number(count[1]), passed: Number(count[2]) } : {}), issues };
}

/* ---------- Quotes (the backend checks them against the guideline text; the card shows its result) ---------- */
/** The backend's quote check of version n. Null when it did not run (the guideline text of the run is missing). */
export function quotesFrom(n: number, findings: readonly { severity: string; message: string; check: string }[], notRun: readonly string[] | undefined): BackendQuotes | null {
  if ((notRun ?? []).some(x => /quote and number checks against the booklet/.test(x))) return null;
  const seen = new Set<string>();
  const issues = findings
    .filter(f => f.check === "quoteGrounding" && f.severity !== "info" && !seen.has(f.message) && !!seen.add(f.message))
    .map(f => ({ sev: (f.severity === "blocking" ? "blocking" : "warning") as "blocking" | "warning", text: f.message }));
  return { n, issues };
}

/* ---------- Cross check (advisory) ---------- */
/** The backend's cross-check flags of version n. Never throws: null leaves the stage saying it could not load. */
async function loadCross(runId: string, n: number): Promise<CrossFlags | null> {
  try {
    return await call<CrossFlags>("/runs/" + runId + "/versions/" + n + "/flags");
  } catch {
    return null;
  }
}

/* ---------- Officer agent escalation ---------- */
const SUBJECT_ITEM: Record<string, (id: string) => ItemId> = {
  scope: () => item.scope, question: item.q, derived: item.d, rule: item.rule,
  outcome: item.out, action: id => item.out(id.split("/")[0]), follow_up: item.fu,
};
/** The officer agent's escalation on the newest version, or null. Never throws: without it the review still works. */
async function loadEscalation(runId: string): Promise<Escalation | null> {
  try {
    const vs = await call<VersionRec[]>("/runs/" + runId + "/versions");
    const n = vs[vs.length - 1]?.n;
    if (n === undefined) return null;
    const base = "/runs/" + runId + "/versions/" + n;
    const cs = await call<{ itemRef: string; text: string; createdAt: number }[]>(base + "/comments");
    const c = cs.filter(x => x.itemRef === "agent:escalation").pop();
    if (!c) return null;
    const fo = await call<{ groups: { severity: string; findings: { message: string; yours?: boolean; subjects?: { kind: string; id: string }[] }[] }[] }>(base + "/findings?audience=program_officer");
    const items = fo.groups.filter(g => g.severity === "blocking").flatMap(g => g.findings).filter(f => f.yours !== false).map(f => {
      const s = f.subjects?.find(x => SUBJECT_ITEM[x.kind]);
      return { message: f.message, about: s ? SUBJECT_ITEM[s.kind](s.id) : null };
    });
    return { n, text: c.text, items };
  } catch {
    return null;
  }
}
/** The workflow with the cross check of a newly loaded backend version. */
const withCross = (w: Workflow, cross: CrossFlags | null): Workflow => ({ ...w, evidence: { ...w.evidence, cross, golden: w.remote ? goldenFrom(w.remote.n, w.remote.findings) : null, quotes: w.remote ? quotesFrom(w.remote.n, w.remote.findings, w.remote.notRun) : null } });
class OfficerNotSigned extends Error {}

/* ---------- Workflow ---------- */
export async function createDraft(args: { guidelineId: string; pathway: string; pages: number[] }): Promise<Workflow> {
  const id = "wf-" + seq++;
  if (LIVE) {
    const g = await getGuideline(args.guidelineId);
    const vs = await call<VersionRec[]>("/runs/" + g.id + "/versions");
    const last = vs[vs.length - 1];
    if (!last) throw new Error("This run has no logic model version yet. Wait for the pipeline to finish.");
    const v = await call<{ body: unknown }>("/runs/" + g.id + "/versions/" + last.n);
    const model = loadSpec(v.body, "The backend's logic model (version " + last.n + ")");
    const [[fc, fo], scores, escalation, cross] = await Promise.all([
      Promise.all(["clinician", "program_officer"].map(a => call<FindingsView>("/runs/" + g.id + "/versions/" + last.n + "/findings?audience=" + a))),
      loadScores(g.id, last.n, model),
      loadEscalation(g.id),
      loadCross(g.id, last.n),
    ]);
    const flat = (f: FindingsView, role: "clinician" | "program_officer") => f.groups.flatMap(gr => gr.findings.map(x => ({ severity: gr.severity, message: x.message, check: x.check, role })));
    const remote = { runId: g.id, n: last.n, modelSha: fc.modelSha, base: clone(model), claimText: fc.claimText, findings: [...flat(fc, "clinician"), ...flat(fo, "program_officer")], notRun: fc.checksNotRun ?? [] };
    const evidence = { pages: null, pagesFrom: "Guideline text stays in the backend; its own quote check is in the backend findings", draftB: null, draftBFrom: "The backend runs the cross check itself", cross, golden: goldenFrom(last.n, remote.findings), quotes: quotesFrom(last.n, remote.findings, remote.notRun) };
    workflows[id] = wf.createDraft(wf.initialWorkflow(id), { id: g.id, name: g.name, pathway: args.pathway, pages: args.pages }, {
      model, evidence, remote,
      event: "Loaded logic model version " + last.n + " from the backend (run " + g.id + ")",
      note: "modelSha " + fc.modelSha.slice(0, 12) + " · " + fc.claimText,
    });
    workflows[id] = { ...workflows[id], scores, escalation };
    return clone(workflows[id]);
  }
  const g = guidelines.find(x => x.id === args.guidelineId);
  if (!g) throw new Error("Guideline not found");
  const w0 = wf.createDraft(wf.initialWorkflow(id), { id: g.id, name: g.name, pathway: args.pathway, pages: args.pages });
  workflows[id] = { ...w0, scores: sampleScores(w0.draft) };
  return respond(workflows[id], 400);
}
export const getWorkflow = async (id: string) => respond(load(id));

/** IT approver, in their own browser: open a run the clinician approved (locked on the backend) straight at
    Release. Loads the newest locked version; nothing on the backend changes. */
export async function openForRelease(args: { guidelineId: string; pathway: string }): Promise<Workflow> {
  if (!LIVE) throw new Error("Opening an approved run needs the backend. In sample mode, approve in this browser first.");
  const g = await getGuideline(args.guidelineId);
  const base = "/runs/" + g.id;
  const vs = await call<VersionRec[]>(base + "/versions");
  const lockedV = [...vs].reverse().find(v => v.status === "locked");
  if (!lockedV) throw new Error("This run has no approved version yet. The clinician approves it first.");
  const n = lockedV.n;
  const [v, st] = await Promise.all([call<{ body: unknown }>(base + "/versions/" + n), call<StatusView>(base + "/versions/" + n + "/status")]);
  const model = loadSpec(v.body, "The approved logic model (version " + n + ")");
  const id = "wf-" + seq++;
  const remote = { runId: g.id, n, modelSha: st.modelSha, base: clone(model), claimText: "", findings: [] };
  const evidence = { pages: null, pagesFrom: "Guideline text stays in the backend", draftB: null, draftBFrom: "The backend does not return a second draft" };
  const x = wf.createDraft(wf.initialWorkflow(id), { id: g.id, name: g.name, pathway: args.pathway, pages: [] }, {
    model, evidence, remote,
    event: "Opened approved version " + n + " for release (run " + g.id + ")",
    note: "modelSha " + st.modelSha.slice(0, 12) + " · approved by " + lockedV.author,
  });
  workflows[id] = { ...x, state: "verify", approved: { ver: "v" + n, hash: st.modelSha.slice(0, 12), locked: { n, modelSha: st.modelSha } } };
  return respond(workflows[id]);
}
export const saveEdit = (id: string, patch: { item: ItemId; field: string; patch: Patch }) => mutate(id, w => wf.applyEdit(w, patch.item, patch.field, patch.patch));
export const undo = (id: string) => mutate(id, wf.undoEdit);
/* ---------- Live mode: the backend assistant and the feedback loop (Backend/src/chat, Backend/src/revision) ---------- */
interface ChatReply { reply: string; citations: { kind: string; ref: string; quote?: string }[]; kept?: { version: number; ids: string[]; skipped: string[] } }
interface RevisionRec { id: string; status: "instruction_ready" | "applying" | "applied" | "no_change" | "failed" | string; instruction: string; error?: string; toVersion?: number; applied?: unknown[]; refused?: { reason?: string; detail?: string }[]; questionsAdded?: string[] }

/** The newest logic model version of a run, as the review screen needs it. */
async function fetchLatest(runId: string): Promise<{ model: Spec; remote: NonNullable<Workflow["remote"]>; cross: CrossFlags | null }> {
  const vs = await call<VersionRec[]>("/runs/" + runId + "/versions");
  const last = vs[vs.length - 1];
  if (!last) throw new Error("This run has no logic model version yet.");
  const v = await call<{ body: unknown }>("/runs/" + runId + "/versions/" + last.n);
  const model = loadSpec(v.body, "The backend's logic model (version " + last.n + ")");
  const [[fc, fo], cross] = await Promise.all([
    Promise.all(["clinician", "program_officer"].map(a => call<FindingsView>("/runs/" + runId + "/versions/" + last.n + "/findings?audience=" + a))),
    loadCross(runId, last.n),
  ]);
  const flat = (f: FindingsView, role: "clinician" | "program_officer") => f.groups.flatMap(gr => gr.findings.map(x => ({ severity: gr.severity, message: x.message, check: x.check, role })));
  return { model, cross, remote: { runId, n: last.n, modelSha: fc.modelSha, base: clone(model), claimText: fc.claimText, findings: [...flat(fc, "clinician"), ...flat(fo, "program_officer")], notRun: fc.checksNotRun ?? [] } };
}

/** The selected rule, question, result or value as loaded on the page (unsaved edits included), for the assistant. */
function selectedItemJson(m: Spec, sel?: string): string | undefined {
  const i = sel?.indexOf(":") ?? -1;
  if (!sel || i < 1) return undefined;
  const id = sel.slice(i + 1), rec = m as unknown as Record<string, unknown>;
  for (const k of ["rules", "questions", "outcomes", "derived"]) {
    const list = rec[k];
    const hit = Array.isArray(list) ? (list as { id?: unknown }[]).find(x => x?.id === id) : undefined;
    if (hit) return JSON.stringify(hit).slice(0, 8000);
  }
  return undefined;
}
/** Everything on the review page the assistant answers from: the version, the selected item, the open questions and the checks. */
function pageContext(w: Workflow, sel?: string) {
  const r = w.remote!, item = selectedItemJson(w.model, sel);
  return {
    version: r.n,
    ...(w.undo.length ? { unsavedEdits: true } : {}),
    ...(sel ? { selected: sel } : {}),
    ...(item ? { selectedItem: item } : {}),
    openQuestions: w.flags.slice(0, 60).map((f, i) => ({ n: i + 1, id: f.id, title: f.title.slice(0, 500), answered: !!f.res })),
    findings: r.findings.slice(0, 80).map(f => ({ severity: f.severity, message: f.message.slice(0, 600) })),
  };
}
/** A chat line that tells the assistant to keep or accept something; the backend assistant decides which questions, so the local rules must not swallow it. */
const KEEP_INTENT = /\b(keep|accept|agree)\b/i;

/** A message to the assistant. Live: what the local rules understand stays local (what-if patients, explain a rule,
    propose a change, undo); everything else (and any keep or accept instruction) is answered by the backend assistant (Claude on Bedrock, grounded in
    the guideline pages, with citations). */
export async function chat(id: string, text: string, sel?: string): Promise<Workflow> {
  const w = load(id);
  if (!LIVE || !w.remote) return mutate(id, x => wf.chat(x, text));
  const t = text.trim();
  // A keep/accept instruction goes straight to the assistant; the rest tries the local rules first.
  const local = KEEP_INTENT.test(t) && t ? wf.addMsgs(w, { from: "clinician", text: t }, { from: "agent", text: FALLBACK_TEXT }) : wf.chat(w, text);
  const last = local.chat[local.chat.length - 1];
  if (!last || last.from !== "agent" || last.text !== FALLBACK_TEXT) { workflows[id] = local; return respond(local); }
  // The page is the context (below); the history is only the last few turns, for follow-ups.
  const history = local.chat.slice(0, -1).slice(-3).map(m => ({ from: m.from === "clinician" ? "user" : "assistant", text: m.text.slice(0, 1500) }));
  try {
    const r = await call<ChatReply>("/runs/" + w.remote.runId + "/chat", { method: "POST", body: JSON.stringify({ userId: me(), role: "clinician", messages: history, context: pageContext(local, sel) }) });
    const src = [...new Set(r.citations.map(c => (c.kind === "page" ? "page " : c.kind + " ") + c.ref))];
    let next = wf.replaceLastMsg(local, { from: "agent", text: r.reply + (src.length ? "\n\nSources: " + src.join(", ") : "") });
    if (r.kept) {
      // The backend saved the keep as a new version (what the Keep button does, done there). Load it, so the questions show as closed.
      const keptIds = r.kept.ids.map(q => "F-" + q);
      const closed = { ...next, flags: next.flags.map(f => keptIds.includes(f.id) ? { ...f, res: { choice: "keep" as const, note: "", by: "Clinician" } } : f) };
      try {
        const latest = await fetchLatest(w.remote.runId);
        next = wf.replaceFromBackend(closed, latest.model, latest.remote, "Kept as drafted in the chat: " + r.kept.ids.join(", ") + "; version " + latest.remote.n);
      } catch (e) {
        next = wf.addMsgs(closed, { from: "agent", text: "Saved on the backend, but I could not reload the new version: " + (e instanceof Error ? e.message : String(e)) + " Reload the review." });
      }
    }
    workflows[id] = next;
    return respond(next);
  } catch (e) {
    const next = wf.replaceLastMsg(local, { from: "agent", text: chatFailure(e) });
    workflows[id] = next;
    return respond(next);
  }
}
/** One plain sentence for a chat failure. Off-topic questions are not failures: the backend answers them itself. */
export function chatFailure(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/rate_limited|429/.test(m) && /budget/.test(m)) return "The chat budget for this run is used up.";
  if (/rate_limited/.test(m)) return "You are sending messages too fast. Wait a few seconds and try again.";
  if (/budget/.test(m)) return "The chat budget for this run is used up.";
  if (/chat_unavailable|503/.test(m)) return "The assistant is not available on this backend.";
  if (/Can't reach the backend/.test(m)) return "I can't reach the backend right now. Check that it is running.";
  return "I couldn't answer that just now. Please try again.";
}

/** Feedback for the AI (live only): saved as a comment on the current version, then the backend turns it into a
    plan (revision step 1). Only the clinician's own feedback goes into the plan (itemRefs), not the officer agent's
    escalation notes. Nothing changes until the clinician confirms the plan. */
/** The backend's item reference for what the feedback is about: a rule named in the text ("R3"), else the item selected in the review. */
export function feedbackRef(text: string, selected?: string): string {
  const m = /\bR(\d+)\b/.exec(text);
  if (m) return "rules.R" + m[1];
  const i = selected?.indexOf(":") ?? -1;
  if (selected && i > 0) {
    const kind = ({ rule: "rules", d: "derived", q: "questions", out: "outcomes" } as Record<string, string>)[selected.slice(0, i)];
    if (kind) return kind + "." + selected.slice(i + 1);
  }
  return "general";
}
export async function feedback(id: string, text: string, selected?: string): Promise<Workflow> {
  const w = load(id);
  if (!LIVE || !w.remote) throw new Error("Sending feedback to the AI needs the backend (set VITE_API_URL).");
  const t = text.trim();
  if (!t) return respond(w);
  // The AI works from the saved backend version and its new version replaces the one on screen, so unsaved edits would be lost.
  if (w.undo.length) throw new Error("You have edits that are not saved yet. Undo them, or approve first, before sending feedback to the AI: it works from the saved version and its answer would replace your edits.");
  const base = "/runs/" + w.remote.runId, ref = feedbackRef(t, selected);
  await call(base + "/versions/" + w.remote.n + "/comments", { method: "POST", body: JSON.stringify({ itemRef: ref, author: me(), text: t }) });
  const rev = await call<RevisionRec>(base + "/versions/" + w.remote.n + "/revisions", { method: "POST", body: JSON.stringify({ role: "clinician", userId: me(), itemRefs: [ref] }) });
  const next = wf.addMsgs(w,
    { from: "clinician", text: "Feedback for the AI: " + t },
    { from: "agent", text: "I read your feedback and plan to do this:\n\n" + rev.instruction + "\n\nNothing changes until you confirm.", revision: { rid: rev.id, state: "ready" } });
  workflows[id] = next;
  return respond(next);
}

/** Confirm a plan: the backend proposes edits (step 2, in the background), saves a new version, and the officer
    agent checks it. `onUpdate` shows progress; the returned workflow has the new version loaded. */
export async function confirmRevision(id: string, msgId: number, onUpdate: (w: Workflow) => void): Promise<Workflow> {
  let w = load(id);
  const msg = w.chat.find(c => c.id === msgId);
  if (!LIVE || !w.remote || !msg?.revision || msg.revision.state !== "ready") throw new Error("Nothing to confirm.");
  const { rid } = msg.revision, runId = w.remote.runId, was = w.remote.n;
  const push = (x: Workflow) => { w = x; workflows[id] = x; onUpdate(clone(x)); };
  push(wf.setRevisionState(w, msgId, "applying"));
  try {
    await call("/runs/" + runId + "/revisions/" + rid + "/confirm", { method: "POST", body: JSON.stringify({ role: "clinician", userId: me() }) });
    let rev: RevisionRec | undefined;
    for (let i = 0; i < 90; i++) {
      await wait(2000);
      rev = await call<RevisionRec>("/runs/" + runId + "/revisions/" + rid);
      if (rev.status !== "applying") break;
    }
    if (!rev || rev.status === "applying") throw new Error("The AI is still working after 3 minutes. Check back in a moment.");
    if (rev.status === "failed") throw new Error(rev.error || "The revision failed.");
    // Let the officer agent look at the new version before loading it (it may save a fix of its own).
    await wait(rev.status === "applied" ? 6000 : 0);
    const latest = await fetchLatest(runId);
    const changed = latest.remote.n > was;
    const why = (rev.refused ?? []).map(r => r.detail || r.reason).filter(Boolean).join("; ");
    let next = wf.setRevisionState(w, msgId, changed ? "applied" : "no_change");
    if (changed) next = withCross(wf.replaceFromBackend(next, latest.model, latest.remote, "AI revision of your feedback; version " + was + " -> " + latest.remote.n), latest.cross);
    next = wf.addMsgs(next, { from: "agent", text: changed
      ? "Done. The backend saved version " + latest.remote.n + " and the review shows it now (" + (rev.applied?.length ?? 0) + " edit" + (rev.applied?.length === 1 ? "" : "s") + " by the AI" + (rev.questionsAdded?.length ? ", " + rev.questionsAdded.length + " new open question" + (rev.questionsAdded.length === 1 ? "" : "s") : "") + ")."
      : "I did not change the model." + (why ? " My proposed edit was refused by the safety check: " + why + "." : " Nothing needed changing.") });
    workflows[id] = next;
    return respond(next);
  } catch (e) {
    const next = wf.addMsgs(wf.setRevisionState(w, msgId, "failed"), { from: "agent", text: revisionFailure(e) });
    workflows[id] = next;
    return respond(next);
  }
}
/** Plain words for a revision that did not finish. A 409 means a newer version was saved after this plan was made. */
export function revisionFailure(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/conflict|superseded|409/i.test(m)) return "The draft changed while you were reviewing (a newer version was saved), so this plan is out of date. Send your feedback again and I will plan from the latest version.";
  return "The revision did not finish: " + m;
}
export const cancelRevision = (id: string, msgId: number) => mutate(id, w => wf.setRevisionState(w, msgId, "cancelled"));
export const applyProposal = (id: string, msgId: number, i: number) => mutate(id, w => wf.applyProposal(w, msgId, i));
export const dismissProposal = (id: string, msgId: number) => mutate(id, w => wf.dismissProposal(w, msgId));
export const answer = (id: string, flagId: string, choice: "keep" | "change") => mutate(id, w => wf.answerFlag(w, flagId, choice));
export async function approve(id: string): Promise<Workflow> {
  const w = load(id);
  if (!LIVE || !w.remote) return mutate(id, x => wf.approveAll(x));
  wf.approveAll(w); // the same local gate first: no blocking checks, every question answered
  let locked: { n: number; modelSha: string };
  try {
    locked = await signOnBackend(w);
  } catch (e) {
    if (!(e instanceof OfficerNotSigned)) throw e;
    // The agent gave up and left its reasons: show them on the review screen instead of a dead-end error.
    const esc = await loadEscalation(w.remote.runId);
    if (!esc) throw new Error(e.message.replace(/ It may have left.*$/, "") + " It may still be working: try Approve again in a minute.");
    return mutate(id, x => ({ ...x, escalation: esc }));
  }
  if (locked.n > w.remote.n + 1) {
    // The officer agent saved a fix of its own on top of the clinician's version; that is the version that was signed.
    const latest = await fetchLatest(w.remote.runId);
    await mutate(id, x => withCross(wf.replaceFromBackend(x, latest.model, latest.remote, "Officer agent saved version " + latest.remote.n + " after your review"), latest.cross));
  }
  return mutate(id, x => wf.approveAll(x, locked));
}

/** True once the officer agent has given up on version n (it leaves an escalation comment): nothing more will happen, so do not wait. */
async function agentGaveUp(base: string, n: number): Promise<boolean> {
  try {
    const cs = await call<{ itemRef: string }[]>(base + "/versions/" + n + "/comments");
    return cs.some(c => c.itemRef === "agent:escalation");
  } catch {
    return false;
  }
}

/** Poll until the version is no longer waiting for the officer: up to 60 s, but stop as soon as the agent has given up (it takes seconds, not a minute). */
async function waitForOfficer(base: string, n: number, first: StatusView): Promise<StatusView> {
  let st = first;
  for (let i = 0; i < 60 && st.status === "awaiting_officer"; i++) {
    await wait(1000);
    st = await call<StatusView>(base + "/versions/" + n + "/status");
    if (st.status === "awaiting_officer" && i % 2 === 1 && (await agentGaveUp(base, n))) break;
  }
  return st;
}

/** Save the clinician's version, wait for the backend's officer agent to sign it, then sign as the clinician. */
async function signOnBackend(w: Workflow): Promise<{ n: number; modelSha: string }> {
  const r = w.remote!, base = "/runs/" + r.runId;
  const vs = await call<VersionRec[]>(base + "/versions");
  const parent = vs[vs.length - 1].n;
  const edits = w.versions.filter(v => v.event.startsWith("Edited")).length;
  const note = "Clinician review in the app: " + edits + " edit" + (edits === 1 ? "" : "s") + " to the rules, open questions answered, checks reviewed.";
  const body: Spec = { ...w.model, meta: { ...w.model.meta, version: parent + 1, parent_version: parent, created_at: new Date().toISOString(), created_by: me(), change_note: note } };
  let { n } = await call<{ n: number }>(base + "/versions", { method: "POST", body: JSON.stringify({ parentVersion: parent, body, author: me(), authorRole: "clinician" }) });
  let st = await waitForOfficer(base, n, await call<StatusView>(base + "/versions/" + n + "/status"));
  // The officer agent may save a newer version of its own (a fix) and sign that one: follow the chain to the newest version.
  for (let hop = 0; hop < 5 && st.status === "superseded"; hop++) {
    const all = await call<VersionRec[]>(base + "/versions");
    n = all[all.length - 1].n;
    st = await waitForOfficer(base, n, await call<StatusView>(base + "/versions/" + n + "/status"));
  }
  if (st.status !== "awaiting_clinician") {
    throw new OfficerNotSigned("Version " + n + " was saved, but the officer agent has not signed it (status: " + st.status.replace(/_/g, " ") + "). It may have left a comment on the version; check its findings.");
  }
  // The clinician has reviewed everything and kept it: findings only the clinician decides stop blocking, recorded with their name and reason.
  const fv = await call<{ gates: { canClinicianSign: boolean }; groups: { findings: { id: string; severity: string; yours: boolean }[] }[] }>(base + "/versions/" + n + "/findings?audience=clinician");
  if (!fv.gates.canClinicianSign) {
    const ids = fv.groups.flatMap(g => g.findings).filter(f => f.severity === "blocking" && f.yours).map(f => f.id);
    if (ids.length) await call(base + "/versions/" + n + "/acknowledge", { method: "POST", body: JSON.stringify({ role: "clinician", userId: me(), findingIds: ids, note: "Kept as correct: the clinician reviewed this item and agreed with the draft when approving." }) });
  }
  await call(base + "/versions/" + n + "/signatures/clinician", { method: "POST", body: JSON.stringify({ role: "clinician", userId: me(), modelSha: st.modelSha }) });
  return { n, modelSha: st.modelSha };
}
export const runVerify = (id: string) => mutate(id, wf.runVerify);
export const approveDeploy = (id: string) => mutate(id, wf.approveDeploy);
export const getAudit = async (id: string): Promise<AuditRow[]> => respond(load(id).audit);
