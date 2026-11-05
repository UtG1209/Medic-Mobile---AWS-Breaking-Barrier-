import type { Condition, Model, Source } from "../logic/index.js";
import { parseModel } from "../logic/schema.js";
import { clipText, collapse, mapThresholdOp, parseAgeBand, parseDoseText, parseFollowup, sources, variableUnit } from "../logic/fill/resolve.js";
import type { ExtractionOutput } from "../steps/extractionSchema.js";
import { looksLikeInstruction } from "../validation/text.js";
import type { TargetSet } from "./targets.js";
import { parseItemRef } from "./targets.js";
import type { AppliedEdit, EditOp, Proposal, RefusedEdit, RevisionComment } from "./types.js";

type Reason = RefusedEdit["reason"];
type Ex = ExtractionOutput;
type Origin = "guideline" | "team" | "clinician";
type Sourced = { origin: Origin; source?: Source[] | undefined };

const MAX_SOURCES = 20;
const MAX_NEW_QUESTIONS = 10;
const SAFE_REF = /^[A-Za-z0-9_.]{1,120}$/;
const REASON_PHRASE: Record<string, string> = {
  not_in_extraction: "the booklet extraction does not contain what is needed",
  needs_clinical_decision: "it needs a clinical decision",
  ambiguous: "the request is ambiguous",
  other: "another reason",
};
const TEXT_MAX = 2000;

class Refuse extends Error {
  constructor(public readonly reason: Reason, public readonly detail: string) {
    super(detail);
  }
}
const refuse = (reason: Reason, detail: string): never => {
  throw new Refuse(reason, detail);
};

/** A new open question the code wants to add; the id is assigned when the model is updated. */
interface NewQuestion {
  question: string;
  affects: string[];
  route_to: "clinician" | "program_officer";
}

function nextQuestionId(model: Model): string {
  let max = 0;
  for (const q of model.open_questions) {
    const m = /^Q(\d+)$/.exec(q.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Q${max + 1}`;
}

function appendQuestion(model: Model, q: NewQuestion): string {
  const id = nextQuestionId(model);
  model.open_questions.push({ id, question: q.question, affects: q.affects, route_to: q.route_to, status: "open" });
  return id;
}

/** Add sources without duplicates. The row's origin is never upgraded (a "team" row stays "team"); a guideline row left without a source becomes "team". */
function mergeSources(row: Sourced, add: Source[]): void {
  const have = new Map<string, Source>((row.source ?? []).map((s) => [`${s.page}\u0000${s.quote}`, s]));
  for (const s of add) if (have.size < MAX_SOURCES) have.set(`${s.page}\u0000${s.quote}`, s);
  if (have.size > 0) {
    row.source = [...have.values()];
  } else {
    delete row.source;
    if (row.origin === "guideline") row.origin = "team";
  }
}

// ---------- conditions ----------

type Located = { cond: Condition | "otherwise"; row: Sourced; set: (c: Condition) => void; label: string };

function locateOwner(model: Model, owner: string): Located {
  const ref = parseItemRef(owner);
  if (ref === undefined) return refuse("unknown_target", `"${owner}" is not an item reference`);
  if (ref.kind === "derived") {
    const d = model.derived.find((x) => x.id === ref.id);
    if (!d) return refuse("unknown_target", `there is no derived item "${ref.id}"`);
    return { cond: d.definition, row: d, set: (c) => void (d.definition = c), label: `derived.${d.id}` };
  }
  if (ref.kind === "rules") {
    const r = model.rules.find((x) => x.id === ref.id);
    if (!r) return refuse("unknown_target", `there is no rule "${ref.id}"`);
    return { cond: r.when, row: r, set: (c) => void (r.when = c), label: `rules.${r.id}` };
  }
  if (ref.kind === "questions") {
    const q = model.questions.find((x) => x.id === ref.id);
    if (!q) return refuse("unknown_target", `there is no question "${ref.id}"`);
    return { cond: q.shown_when ?? "otherwise", row: q, set: (c) => void (q.shown_when = c), label: `questions.${q.id}` };
  }
  return refuse("unknown_target", `"${owner}" cannot own a condition`);
}

function childrenOf(c: Condition): Condition[] | undefined {
  return "all" in c ? c.all : "any" in c ? c.any : undefined;
}

/** Walk an index path into the all/any lists. Returns the leaf and the list that holds it. */
function leafAt(root: Condition, path: number[]): { leaf: Condition; siblings?: Condition[]; index?: number } | undefined {
  let node = root;
  let siblings: Condition[] | undefined;
  let index: number | undefined;
  for (const i of path) {
    const kids = childrenOf(node);
    if (kids === undefined || i >= kids.length) return undefined;
    siblings = kids;
    index = i;
    node = kids[i] as Condition;
  }
  return { leaf: node, ...(siblings !== undefined ? { siblings } : {}), ...(index !== undefined ? { index } : {}) };
}

function describeLeaf(c: Condition): string {
  if (!("field" in c)) return "a group";
  return c.op === "is_yes" ? `${c.field} is yes` : `${c.field} ${c.op === "at_least" ? "at least" : "less than"} ${c.value}`;
}

/** Questions of the model that the extraction threshold's variable is asked by: same id, or same unit. */
function questionsForVariable(model: Model, ex: Ex, variable: string): Set<string> {
  const v = ex.variables.find((x) => x.id === variable);
  const unit = v === undefined ? undefined : variableUnit(v);
  const out = new Set<string>();
  for (const q of model.questions) {
    if (q.answer_type !== "integer") continue;
    if (q.id === variable || (unit !== undefined && q.unit !== undefined && q.unit === unit)) out.add(q.id);
  }
  return out;
}

function applySetThreshold(model: Model, ex: Ex, e: Extract<EditOp, { op: "set_threshold" }>, targets: TargetSet): { summary: string } {
  const t = ex.thresholds[e.threshold];
  const loc = locateOwner(model, e.owner);
  if (t === undefined) return refuse("unknown_target", `threshold index ${e.threshold} does not exist (0 to ${ex.thresholds.length - 1})`);
  const ref = parseItemRef(e.owner) as NonNullable<ReturnType<typeof parseItemRef>>;
  const inScope =
    (ref.kind === "derived" && targets.derived.includes(ref.id)) ||
    (ref.kind === "rules" && targets.rules.includes(ref.id)) ||
    (ref.kind === "questions" && targets.questions.includes(ref.id));
  if (!inScope) return refuse("outside_comment_scope", `${loc.label} is not an item the comments point at`);
  if (loc.row.origin === "clinician") return refuse("clinician_decided", `${loc.label} was decided by a clinician`);

  if (loc.cond === "otherwise") return refuse("not_grounded", `${loc.label} has no condition to change`);
  const found = leafAt(loc.cond, e.path);
  if (found === undefined) return refuse("unknown_target", `path [${e.path.join(",")}] does not exist in ${loc.label}`);
  const leaf = found.leaf;
  if (!("field" in leaf) || leaf.op === "is_yes") return refuse("not_grounded", `the item at path [${e.path.join(",")}] of ${loc.label} is not a number comparison`);

  const op = mapThresholdOp(t.op, t.value);
  if (op === undefined) return refuse("not_grounded", `threshold ${e.threshold} (${t.variable} ${t.op} ${t.value}) cannot be written exactly in the form`);
  const right = questionsForVariable(model, ex, t.variable);
  if (!right.has(leaf.field)) return refuse("not_grounded", `threshold ${e.threshold} reads "${t.variable}", which is not what "${leaf.field}" asks`);

  if (t.age_band !== null) {
    const band = parseAgeBand(t.age_band);
    if (band === undefined) return refuse("not_grounded", `threshold ${e.threshold} age band "${t.age_band}" cannot be read exactly`);
    const sib = found.siblings;
    const ages = (sib ?? []).filter((c): c is Extract<Condition, { value: number }> => "field" in c && c.op !== "is_yes" && model.questions.some((q) => q.id === c.field && q.unit === "months"));
    const hasMin = band.min === 0 || ages.some((c) => c.op === "at_least" && c.value === band.min);
    const hasBelow = ages.some((c) => c.op === "less_than" && c.value === band.below);
    if (!hasMin || !hasBelow) return refuse("not_grounded", `threshold ${e.threshold} applies to ${t.age_band}, but the condition around the item is not that age group`);
  }

  if (leaf.op === op.op && leaf.value === op.value) return refuse("not_grounded", `the item already reads ${describeLeaf(leaf)}; nothing to change`);
  const before = describeLeaf(leaf);
  const next: Condition = { field: leaf.field, op: op.op, value: op.value };
  if (found.siblings !== undefined && found.index !== undefined) found.siblings[found.index] = next;
  else loc.set(next);
  mergeSources(loc.row, sources(t.src));
  return { summary: `${loc.label}: changed "${before}" to "${describeLeaf(next)}" (guideline threshold ${e.threshold}).` };
}

// ---------- outcomes ----------

function outcomeFor(model: Model, id: string, targets: TargetSet): Model["outcomes"][number] {
  const o = model.outcomes.find((x) => x.id === id);
  if (!o) return refuse("unknown_target", `there is no outcome "${id}"`);
  if (!targets.outcomes.includes(o.id)) return refuse("outside_comment_scope", `outcomes.${o.id} is not an item the comments point at`);
  if (o.origin === "clinician") return refuse("clinician_decided", `outcomes.${o.id} was decided by a clinician`);
  return o;
}

function guidelineText(src: readonly { block_id: string; pdf_page: number; quote: string }[]): string {
  const first = src.find((x) => x.quote.trim() !== "");
  if (first === undefined) return "";
  return collapse(src.filter((x) => x.block_id === first.block_id && x.pdf_page === first.pdf_page).map((x) => x.quote).join(" "));
}

function applyReplaceAction(model: Model, ex: Ex, e: Extract<EditOp, { op: "replace_action" }>, targets: TargetSet, pending: NewQuestion[]): { summary: string } {
  const o = outcomeFor(model, e.outcome, targets);
  const old = o.actions[e.actionIndex];
  if (old === undefined) return refuse("unknown_target", `outcomes.${o.id} has no action at index ${e.actionIndex}`);
  if (old.origin === "clinician") return refuse("clinician_decided", `action ${e.actionIndex} of outcomes.${o.id} was decided by a clinician`);

  let text: string;
  let src: Source[];
  let doses: ReturnType<typeof parseDoseText>;
  const a = ex.actions.find((x) => x.id === e.extractionId);
  if (a !== undefined) {
    text = collapse(a.src.find((x) => x.quote.trim() !== "")?.quote ?? "");
    src = sources(a.src);
    doses = a.dose_text !== null ? parseDoseText(a.dose_text) : undefined;
    if (a.dose_text !== null && doses === undefined) return refuse("not_grounded", `the dose text of "${a.id}" cannot be read exactly`);
    if (a.drug !== null && collapse(a.drug) !== "" && text !== "" && !text.toLowerCase().includes(collapse(a.drug).toLowerCase())) {
      pending.push({
        question: clipText(`The booklet wording used for step ${a.id} does not name the medicine "${collapse(a.drug)}" (outcome ${o.id}). Which medicine should the health worker be told to give?`),
        affects: [o.id],
        route_to: "clinician",
      });
    }
  } else {
    const n = ex.nodes.find((x) => x.id === e.extractionId);
    if (n === undefined) return refuse("unknown_target", `"${e.extractionId}" is not an extraction action or action/advice node`);
    if (n.kind !== "action" && n.kind !== "advice") return refuse("not_grounded", `"${n.id}" is a ${n.kind} node, not an action or advice`);
    text = guidelineText(n.src);
    src = sources(n.src);
  }
  if (text === "" || src.length === 0) return refuse("not_grounded", `"${e.extractionId}" has no booklet wording or source to copy`);
  if (looksLikeInstruction(text)) return refuse("not_grounded", `the booklet text of "${e.extractionId}" reads like an instruction to a computer`);

  const next = { text: clipText(text, TEXT_MAX), origin: "guideline" as const, source: src, ...(doses !== undefined ? { dose_by_age: doses } : {}) };
  o.actions[e.actionIndex] = next;
  return { summary: `outcomes.${o.id}: action ${e.actionIndex + 1} replaced with the booklet step ${e.extractionId}.` };
}

function applySetFollowUp(model: Model, ex: Ex, e: Extract<EditOp, { op: "set_follow_up" }>, targets: TargetSet, pending: NewQuestion[]): { summary: string } {
  const o = outcomeFor(model, e.outcome, targets);
  if (o.follow_up !== null && o.follow_up.origin === "clinician") return refuse("clinician_decided", `the follow-up of outcomes.${o.id} was decided by a clinician`);
  if (e.followupId === null) {
    if (o.follow_up === null) return refuse("not_grounded", `outcomes.${o.id} already has no follow-up`);
    o.follow_up = null;
    pending.push({ question: clipText(`Follow-up removed from ${o.id}; please confirm.`), affects: [o.id], route_to: "clinician" });
    return { summary: `outcomes.${o.id}: follow-up removed.` };
  }
  const f = ex.followups.find((x) => x.id === e.followupId);
  if (f === undefined) return refuse("unknown_target", `"${e.followupId}" is not an extraction follow-up`);
  const p = parseFollowup(f.text, f.due_text);
  if (p === undefined) return refuse("not_grounded", `follow-up "${f.id}" gives no number of days or "on return" the form can schedule`);
  const src = sources(f.src);
  const next = {
    kind: p.kind,
    due_in_days: p.due,
    task_window_days_after_due: null,
    ...(src.length > 0 ? { origin: "guideline" as const, source: src } : { origin: "team" as const }),
  };
  o.follow_up = next;
  return { summary: `outcomes.${o.id}: follow-up set from the booklet (${p.kind === "on_return" ? "on return" : `in ${p.due} days`}).` };
}

// ---------- main ----------

function summarizeNote(applied: AppliedEdit[], questions: string[], revision: { id: string; fromVersion: number }, nComments: number): string {
  const lines = applied.map((a) => a.summary);
  if (questions.length > 0) lines.push(`added open question(s) ${questions.join(", ")}`);
  const note = `Revision ${revision.id} of version ${revision.fromVersion} from ${nComments} comment(s): ${lines.join(" | ")}`;
  return note.length <= TEXT_MAX ? note : `${note.slice(0, TEXT_MAX - 3)}...`;
}

const safeSummary = (s: string): string => clipText(s, 300);

export function applyProposal(a: {
  model: Model;
  extraction: Ex;
  proposal: Proposal;
  targets: TargetSet;
  revision: { id: string; fromVersion: number; nowIso: string; instruction: string };
  comments: RevisionComment[];
}): { model: Model | undefined; applied: AppliedEdit[]; refused: RefusedEdit[]; questionsAdded: string[] } {
  const work: Model = structuredClone(a.model);
  const applied: AppliedEdit[] = [];
  const refused: RefusedEdit[] = [];
  const pending: NewQuestion[] = [];
  const knownIds = new Set<string>([
    ...a.model.rules.map((r) => r.id),
    ...a.model.outcomes.map((o) => o.id),
    ...a.model.questions.map((q) => q.id),
    ...a.model.derived.map((d) => d.id),
  ]);
  const commentRefs = new Set(a.comments.map((c) => c.itemRef));

  for (const edit of a.proposal.edits) {
    const snapshot = structuredClone(work);
    const pendingLen = pending.length;
    try {
      let r: { summary: string };
      switch (edit.op) {
        case "set_threshold":
          r = applySetThreshold(work, a.extraction, edit, a.targets);
          break;
        case "set_rule_outcome": {
          const rule = work.rules.find((x) => x.id === edit.rule);
          if (!rule) throw new Refuse("unknown_target", `there is no rule "${edit.rule}"`);
          if (!work.outcomes.some((o) => o.id === edit.outcome)) throw new Refuse("unknown_target", `there is no outcome "${edit.outcome}"`);
          if (!a.targets.rules.includes(rule.id)) {
            throw new Refuse("outside_comment_scope", `rules.${rule.id} is not an item the comments point at`);
          }
          if (rule.origin === "clinician") throw new Refuse("clinician_decided", `rules.${rule.id} was decided by a clinician`);
          if (rule.outcome === edit.outcome) throw new Refuse("not_grounded", `rules.${rule.id} already goes to ${edit.outcome}`);
          const was = rule.outcome;
          rule.outcome = edit.outcome;
          // Routing changed without a booklet quote: the row is now a team decision (existing sources are kept, none invented).
          rule.origin = "team";
          r = { summary: `rules.${rule.id}: result changed from ${was} to ${edit.outcome}.` };
          break;
        }
        case "replace_action":
          r = applyReplaceAction(work, a.extraction, edit, a.targets, pending);
          break;
        case "set_follow_up":
          r = applySetFollowUp(work, a.extraction, edit, a.targets, pending);
          break;
      }
      applied.push({ edit, summary: safeSummary(r.summary) });
    } catch (err) {
      if (!(err instanceof Refuse)) throw err;
      // An edit that is refused changes nothing, even if it had started to.
      Object.assign(work, snapshot);
      pending.length = pendingLen;
      refused.push({ edit, reason: err.reason, detail: safeSummary(err.detail) });
    }
  }

  // unsupported asks -> open questions built entirely by code from fixed phrases (no model or comment text)
  for (const u of a.proposal.unsupported) {
    const parsed = commentRefs.has(u.itemRef) && SAFE_REF.test(u.itemRef) ? parseItemRef(u.itemRef) : undefined;
    const where = parsed !== undefined ? u.itemRef : "the version";
    const phrase = REASON_PHRASE[u.reason] ?? REASON_PHRASE["other"];
    pending.push({
      question: `A reviewer commented on ${where} and asked for a change the booklet extraction cannot support or that needs a clinical decision (${phrase}). Please decide.`,
      affects: parsed !== undefined && knownIds.has(parsed.id) ? [parsed.id] : [],
      route_to: "clinician",
    });
  }
  // identical questions once, at most MAX_NEW_QUESTIONS per revision
  const seen = new Set<string>();
  const unique = pending.filter((q) => (seen.has(q.question) ? false : (seen.add(q.question), true)));
  pending.length = 0;
  pending.push(...unique.slice(0, MAX_NEW_QUESTIONS));

  if (applied.length === 0 && pending.length === 0) {
    return { model: undefined, applied: [], refused, questionsAdded: [] };
  }

  const questionsAdded = pending.map((q) => appendQuestion(work, q));
  work.meta = {
    ...work.meta,
    version: a.model.meta.version + 1,
    parent_version: a.model.meta.version,
    created_at: a.revision.nowIso,
    created_by: "ai_draft",
    change_note: summarizeNote(applied, questionsAdded, a.revision, a.comments.length),
  };

  const parsed = parseModel(work);
  if (!parsed.ok) {
    const detail = safeSummary(parsed.issues.slice(0, 5).join("; "));
    return {
      model: undefined,
      applied: [],
      refused: [...refused, ...applied.map((x) => ({ edit: x.edit, reason: "invalid_result" as const, detail }))],
      questionsAdded: [],
    };
  }
  return { model: parsed.value, applied, refused, questionsAdded };
}
