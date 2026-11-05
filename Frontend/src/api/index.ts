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
import type { AuditRow, Guideline, GuidelineType, ItemId, Patch, Spec, Workflow } from "../domain/types";

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
interface FindingsView { modelSha: string; claimText: string; blocking: number; groups: { severity: "blocking" | "warning" | "info"; findings: { message: string; check: string }[] }[] }
interface StatusView { n: number; modelSha: string; status: string; runState: RunState; nextStep: string }

const CLINICIAN_ID = (import.meta.env.VITE_CLINICIAN_ID as string | undefined) || "clinician";

const WORK: [RunState, string][] = [["created", "Upload to S3"], ["ingesting", "Read pages"], ["extracting", "Extract"], ["filling_logic", "Draft logic model"], ["checking", "Backend checks"], ["awaiting_officer", "AI agent checks"]];
const READY: RunState[] = ["in_review", "awaiting_clinician", "locked"];
const ABANDONED_MS = 10 * 60 * 1000;
const names = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem("runNames") || "{}"); } catch { return {}; } };
const nameRun = (id: string, n: string) => { try { localStorage.setItem("runNames", JSON.stringify({ ...names(), [id]: n })); } catch { /* private mode */ } };

function toGuideline(r: Run, steps?: StepRecord[], escalated = false): Guideline {
  // The officer agent gave up on this draft and left it for a person: the clinician can open it (and answer through chat, feedback or edits).
  // A run still at "created" long after it was made never got its file (the tab closed or the PUT was blocked mid-upload).
  const abandoned = r.state === "created" && Date.now() - r.createdAt > ABANDONED_MS;
  if (abandoned) {
    return {
      id: r.runId, name: names()[r.runId] ?? "Run " + r.runId.slice(0, 8), type: "PDF",
      meta: new Date(r.createdAt).toLocaleString() + " · upload did not finish", status: "Failed", pages: r.pages?.length ?? null,
      steps: WORK.map(([s, label], i) => ({ key: s, label, state: i === 0 ? "failed" : "pending" })),
      error: "The file never reached S3, so processing did not start. Upload the PDF again.",
    };
  }
  const failed = r.state === "failed", ready = READY.includes(r.state) || (r.state === "awaiting_officer" && escalated);
  const at = WORK.findIndex(([s]) => s === r.state);
  const err = steps?.filter(s => s.status === "failed").pop()?.error;
  return {
    id: r.runId, name: names()[r.runId] ?? "Run " + r.runId.slice(0, 8), type: "PDF",
    meta: new Date(r.createdAt).toLocaleString() + " · " + (r.pages ? r.pages.length + " pages" : "all pages") + " · " + (escalated && r.state === "awaiting_officer" ? "needs your review (AI agent could not finish)" : r.state.replace(/_/g, " ")),
    status: failed ? "Failed" : ready ? "Indexed" : "Processing",
    pages: r.pages?.length ?? null,
    steps: WORK.map(([s, label], i) => ({ key: s, label, state: ready || i < at ? "done" : i === at ? (failed ? "failed" : "running") : failed && at < 0 && i === WORK.findIndex(([x]) => x === r.currentStep) ? "failed" : "pending" })),
    ...(failed ? { error: "The backend run failed" + (r.currentStep ? " at " + r.currentStep : "") + (err ? ": " + err : "") + ". Resume it with POST /runs/" + r.runId + "/resume." } : {}),
  };
}
/** A backend refusal in plain words: the error code, its message, and any blockers it lists. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try { r = await fetch(API_URL + path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } }); }
  catch { throw new Error("Can't reach the backend API at " + API_URL + ". Check VITE_API_URL and that the API allows this origin (CORS)."); }
  const body = await r.json().catch(() => null) as (T & { error?: string; message?: string; issues?: unknown[]; blockers?: { message?: string }[] }) | null;
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
  if (!LIVE) return respond(guidelines);
  const runs = await call<Run[]>("/runs");
  const esc = await Promise.all(runs.map(r => (r.state === "awaiting_officer" ? agentEscalated(r.runId) : Promise.resolve(false))));
  return runs.map((r, i) => toGuideline(r, undefined, esc[i])).reverse();
};
export const getGuideline = async (id: string): Promise<Guideline> => {
  if (!LIVE) return respond(guidelines.find(g => g.id === id)!);
  const r = await call<{ run: Run; steps: StepRecord[] }>("/runs/" + id);
  return toGuideline(r.run, r.steps, r.run.state === "awaiting_officer" && (await agentEscalated(id)));
};

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
    const [fc, fo] = await Promise.all(["clinician", "program_officer"].map(a => call<FindingsView>("/runs/" + g.id + "/versions/" + last.n + "/findings?audience=" + a)));
    const flat = (f: FindingsView, role: "clinician" | "program_officer") => f.groups.flatMap(gr => gr.findings.map(x => ({ severity: gr.severity, message: x.message, check: x.check, role })));
    const remote = { runId: g.id, n: last.n, modelSha: fc.modelSha, base: clone(model), claimText: fc.claimText, findings: [...flat(fc, "clinician"), ...flat(fo, "program_officer")] };
    const evidence = { pages: null, pagesFrom: "Guideline text stays in the backend; its own quote check is in the backend findings", draftB: null, draftBFrom: "The backend does not return a second draft" };
    workflows[id] = wf.createDraft(wf.initialWorkflow(id), { id: g.id, name: g.name, pathway: args.pathway, pages: args.pages }, {
      model, evidence, remote,
      event: "Loaded logic model version " + last.n + " from the backend (run " + g.id + ")",
      note: "modelSha " + fc.modelSha.slice(0, 12) + " · " + fc.claimText,
    });
    return clone(workflows[id]);
  }
  const g = guidelines.find(x => x.id === args.guidelineId);
  if (!g) throw new Error("Guideline not found");
  workflows[id] = wf.createDraft(wf.initialWorkflow(id), { id: g.id, name: g.name, pathway: args.pathway, pages: args.pages });
  return respond(workflows[id], 400);
}
export const getWorkflow = async (id: string) => respond(load(id));
export const saveEdit = (id: string, patch: { item: ItemId; field: string; patch: Patch }) => mutate(id, w => wf.applyEdit(w, patch.item, patch.field, patch.patch));
export const undo = (id: string) => mutate(id, wf.undoEdit);
/* ---------- Live mode: the backend assistant and the feedback loop (Backend/src/chat, Backend/src/revision) ---------- */
interface ChatReply { reply: string; citations: { kind: string; ref: string; quote?: string }[] }
interface RevisionRec { id: string; status: "instruction_ready" | "applying" | "applied" | "no_change" | "failed" | string; instruction: string; error?: string; toVersion?: number; applied?: unknown[]; refused?: { reason?: string; detail?: string }[]; questionsAdded?: string[] }

/** The newest logic model version of a run, as the review screen needs it. */
async function fetchLatest(runId: string): Promise<{ model: Spec; remote: NonNullable<Workflow["remote"]> }> {
  const vs = await call<VersionRec[]>("/runs/" + runId + "/versions");
  const last = vs[vs.length - 1];
  if (!last) throw new Error("This run has no logic model version yet.");
  const v = await call<{ body: unknown }>("/runs/" + runId + "/versions/" + last.n);
  const model = loadSpec(v.body, "The backend's logic model (version " + last.n + ")");
  const [fc, fo] = await Promise.all(["clinician", "program_officer"].map(a => call<FindingsView>("/runs/" + runId + "/versions/" + last.n + "/findings?audience=" + a)));
  const flat = (f: FindingsView, role: "clinician" | "program_officer") => f.groups.flatMap(gr => gr.findings.map(x => ({ severity: gr.severity, message: x.message, check: x.check, role })));
  return { model, remote: { runId, n: last.n, modelSha: fc.modelSha, base: clone(model), claimText: fc.claimText, findings: [...flat(fc, "clinician"), ...flat(fo, "program_officer")] } };
}

/** A message to the assistant. Live: what the local rules understand stays local (what-if patients, explain a rule,
    propose a change, undo); everything else is answered by the backend assistant (Claude on Bedrock, grounded in
    the guideline pages, with citations). */
export async function chat(id: string, text: string): Promise<Workflow> {
  const w = load(id);
  if (!LIVE || !w.remote) return mutate(id, x => wf.chat(x, text));
  const local = wf.chat(w, text);
  const last = local.chat[local.chat.length - 1];
  if (!last || last.from !== "agent" || last.text !== FALLBACK_TEXT) { workflows[id] = local; return respond(local); }
  // Not understood locally: ask the backend. History = the conversation so far, without the local fallback reply.
  const history = local.chat.slice(0, -1).slice(-12).map(m => ({ from: m.from === "clinician" ? "user" : "assistant", text: m.text.slice(0, 1500) }));
  try {
    const r = await call<ChatReply>("/runs/" + w.remote.runId + "/chat", { method: "POST", body: JSON.stringify({ userId: CLINICIAN_ID, role: "clinician", messages: history }) });
    const src = [...new Set(r.citations.map(c => (c.kind === "page" ? "page " : c.kind + " ") + c.ref))];
    const next = wf.replaceLastMsg(local, { from: "agent", text: r.reply + (src.length ? "\n\nSources: " + src.join(", ") : "") });
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
  await call(base + "/versions/" + w.remote.n + "/comments", { method: "POST", body: JSON.stringify({ itemRef: ref, author: CLINICIAN_ID, text: t }) });
  const rev = await call<RevisionRec>(base + "/versions/" + w.remote.n + "/revisions", { method: "POST", body: JSON.stringify({ role: "clinician", userId: CLINICIAN_ID, itemRefs: [ref] }) });
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
    await call("/runs/" + runId + "/revisions/" + rid + "/confirm", { method: "POST", body: JSON.stringify({ role: "clinician", userId: CLINICIAN_ID }) });
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
    if (changed) next = wf.replaceFromBackend(next, latest.model, latest.remote, "AI revision of your feedback; version " + was + " -> " + latest.remote.n);
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
  const locked = await signOnBackend(w);
  return mutate(id, x => wf.approveAll(x, locked));
}

/** Save the clinician's version, wait for the backend's officer agent to sign it, then sign as the clinician. */
async function signOnBackend(w: Workflow): Promise<{ n: number; modelSha: string }> {
  const r = w.remote!, base = "/runs/" + r.runId;
  const vs = await call<VersionRec[]>(base + "/versions");
  const parent = vs[vs.length - 1].n;
  const edits = w.versions.filter(v => v.event.startsWith("Edited")).length;
  const note = "Clinician review in the app: " + edits + " edit" + (edits === 1 ? "" : "s") + " to the rules, open questions answered, checks reviewed.";
  const body: Spec = { ...w.model, meta: { ...w.model.meta, version: parent + 1, parent_version: parent, created_at: new Date().toISOString(), created_by: CLINICIAN_ID, change_note: note } };
  const { n } = await call<{ n: number }>(base + "/versions", { method: "POST", body: JSON.stringify({ parentVersion: parent, body, author: CLINICIAN_ID, authorRole: "clinician" }) });
  let st = await call<StatusView>(base + "/versions/" + n + "/status");
  for (let i = 0; i < 60 && st.status === "awaiting_officer"; i++) {
    await wait(1000);
    st = await call<StatusView>(base + "/versions/" + n + "/status");
  }
  if (st.status !== "awaiting_clinician") {
    throw new Error("Version " + n + " was saved, but the officer agent has not signed it (status: " + st.status.replace(/_/g, " ") + "). It may have left a comment on the version; check its findings.");
  }
  await call(base + "/versions/" + n + "/signatures/clinician", { method: "POST", body: JSON.stringify({ role: "clinician", userId: CLINICIAN_ID, modelSha: st.modelSha }) });
  return { n, modelSha: st.modelSha };
}
export const runVerify = (id: string) => mutate(id, wf.runVerify);
export const approveDeploy = (id: string) => mutate(id, wf.approveDeploy);
export const getAudit = async (id: string): Promise<AuditRow[]> => respond(load(id).audit);
