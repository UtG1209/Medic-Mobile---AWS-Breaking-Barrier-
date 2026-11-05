import type { ExtractionOutput } from "../../steps/extractionSchema.js";
import type { Condition, ModelInput, Source } from "../schema.js";
import type { Draft, DraftCondition } from "./draftSchema.js";
import { looksLikeInstruction, normalizeForQuote } from "../../validation/text.js";

/**
 * Deterministic resolver: draft (ids and indexes only) + extraction -> a v1-shaped logic model.
 *
 * Code, not the model, writes every operator, number, quote, page and hash:
 *  - threshold operators and numbers come from extraction.thresholds (">=" -> at_least, "<" -> less_than;
 *    ">" and "<=" by a whole-number shift, which is exact because every compared answer is a whole number;
 *    anything else is not guessed: it is a problem when used and always an open question);
 *  - sources are copied from the extraction src entries (origin "guideline");
 *  - what the guideline does not say (entry limits, the out-of-age-range rule, the catch-all rule,
 *    placeholder actions) is origin "team" and listed in open_questions;
 *  - dose_by_age is parsed from the action dose_text; an open question when it does not parse;
 *  - action text is the booklet quote, never the extraction's own text field, and no medicine name is added in
 *    front of a quote that does not name it (the clinician is asked instead);
 *  - a danger sign counts as asked only through a question linked to it (danger_sign_id) or a cut-off taken from
 *    its own passage; a cite list never counts and never adds a danger sign's quote;
 *  - a calculated value or rule whose only support is the draft's cite list (no cut-off, no question source) is
 *    origin "team" and listed for the clinician;
 *  - extraction text is data: a string that looks like an instruction to a computer becomes a blocking open question.
 *
 * Problems with the draft itself (unknown ids, unresolved references, bad structure) make the result
 * {ok:false}; the step sends them back to the model once. Content findings are left to the checks.
 */

export interface ResolveOptions {
  pathwayId: string;
  /** ISO 8601 with offset. */
  createdAt: string;
  guideline: { title: string; publisher?: string; edition?: string; fileSha256?: string };
  changeNote?: string;
}

export type ResolvedModel = ModelInput & { schema_version: "1.0" };
export type ResolveResult = { ok: true; model: ResolvedModel } | { ok: false; problems: string[] };

type Ex = ExtractionOutput;
type ExSrc = Ex["nodes"][number]["src"][number];
type Band = { min: number; below: number };
type Dose = { age_months_min: number; age_months_below: number; dose: string; total?: string };

const MAX_SOURCES = 20;
const TEXT_MAX = 2000;
const MISSING_SHA = "0".repeat(64);

// ---------- small deterministic parsers ----------

export const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
export const clipText = (s: string, max = TEXT_MAX): string => {
  const one = collapse(s);
  return one.length <= max ? one : `${one.slice(0, max - 3).trimEnd()}...`;
};

export function normalizeUnit(u: string | null | undefined): string | undefined {
  if (u === null || u === undefined) return undefined;
  const s = u.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (s === "") return undefined;
  // Models spell the same unit several ways ("month", "mo", "age in months", "breaths/min"). The age variable is
  // found by unit "months" and entry limits are keyed by unit, so the spellings map to one name each.
  if (UNIT_MONTHS.test(s)) return "months";
  if (UNIT_DAYS.test(s)) return "days";
  if (UNIT_BREATHS.test(s)) return "breaths_per_minute";
  return s;
}
const UNIT_MONTHS = /^(?:age_(?:in_)?)?(?:months?|mos?|mths?)(?:_(?:of_)?age|_old)?$/;
const UNIT_DAYS = /^(?:number_of_)?days?$/;
const UNIT_BREATHS = /^(?:breaths?|bpm|breaths?_(?:per|a|in_1|in_one)_min(?:ute)?|breaths?_min)$/;

const AGE_UNIT = "(months?|mos?|mths?|years?|yrs?)";
const toMonths = (n: number, unit: string): number => (/^y/i.test(unit) ? n * 12 : n);

/**
 * The age band a text states, in months, as [min, below):
 * - "2 months up to 5 years", "age 2 months up to 12 months", "2 to 59 months", "2 months to under 5 yrs":
 *   the upper number is excluded, as the booklet means it ("up to 12 months" is below 12);
 * - "2-59 months" (a dash, in months): the upper number is included, so [2, 60); "2 months - 5 years" is [2, 60).
 * A unit given once at the end applies to both numbers. Undefined when it does not read cleanly.
 */
export function parseAgeBand(text: string | null | undefined): Band | undefined {
  if (text === null || text === undefined) return undefined;
  const words = new RegExp(`(\\d+)\\s*${AGE_UNIT}?\\s+(?:up\\s+to|to|until)\\s+(?:(?:but\\s+not\\s+including|under|below|less\\s+than)\\s+)?(\\d+)\\s*${AGE_UNIT}\\b`, "i").exec(text);
  const dash = words ? null : new RegExp(`(\\d+)\\s*${AGE_UNIT}?\\s*[-\u2013\u2014]\\s*(\\d+)\\s*${AGE_UNIT}\\b`, "i").exec(text);
  const m = words ?? dash;
  if (!m) return undefined;
  const upperUnit = m[4] as string;
  const min = toMonths(Number(m[1]), (m[2] as string | undefined) ?? upperUnit);
  // A dash range in months includes its upper end ("2-59 months" covers 59), so the first age outside it is one
  // month more. In years it means up to that birthday ("2 months - 5 years" is below 60), as "up to" does.
  const below = toMonths(Number(m[3]) + (dash && /^m/i.test(upperUnit) ? 1 : 0), upperUnit);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(below) || min >= below) return undefined;
  return { min, below };
}

/**
 * The form's age range when the age variable's range_hint is empty or unreadable, with the quotes that state
 * it (so the checks find both numbers in the cited text): first the age variable's own quotes, then the widest
 * age range written in any quote of the extraction (a booklet usually says "Use this chart for a child age
 * 2 months up to 5 years"), then the widest span of the age bands on thresholds and dose tables. Undefined when none read.
 */
export function inferScope(
  ex: ExtractionOutput,
  ageVariable: { src: readonly ExSrc[] },
): { band: Band; from: string; src: ExSrc[] } | undefined {
  for (const s of ageVariable.src) {
    const b = parseAgeBand(s.quote);
    if (b !== undefined) return { band: b, from: "the age variable's own wording", src: [s] };
  }
  const all: ExSrc[] = [
    ...ex.nodes.flatMap((n) => n.src),
    ...ex.variables.flatMap((v) => v.src),
    ...ex.thresholds.flatMap((t) => t.src),
    ...ex.actions.flatMap((a) => a.src),
  ];
  let best: { band: Band; src: ExSrc } | undefined;
  for (const s of all) {
    const b = parseAgeBand(s.quote);
    if (b !== undefined && (best === undefined || b.below - b.min > best.band.below - best.band.min)) best = { band: b, src: s };
  }
  if (best !== undefined) return { band: best.band, from: "the guideline's own statement of the ages it covers", src: [best.src] };
  const bands: { band: Band; src: ExSrc[] }[] = [];
  for (const t of ex.thresholds) {
    const b = t.age_band === null ? undefined : parseAgeBand(t.age_band);
    if (b !== undefined) bands.push({ band: b, src: t.src });
  }
  for (const a of ex.actions) {
    const d = a.dose_text !== null ? parseDoseText(a.dose_text) : undefined;
    if (d !== undefined) for (const x of d) bands.push({ band: { min: x.age_months_min, below: x.age_months_below }, src: a.src });
  }
  if (bands.length === 0) return undefined;
  const lo = bands.reduce((m, b) => (b.band.min < m.band.min ? b : m));
  const hi = bands.reduce((m, b) => (b.band.below > m.band.below ? b : m));
  if (lo.band.min >= hi.band.below) return undefined;
  return { band: { min: lo.band.min, below: hi.band.below }, from: "the age bands of the guideline's cut-offs and doses", src: [...new Set([...lo.src, ...hi.src])] };
}

/**
 * "Age 2 months up to 12 months—1 tablet; Age 12 months up to 5 years—2 tablets", optionally with
 * "(total 10 tabs)" after a dose. Every segment must parse, or the result is undefined.
 */
export function parseDoseText(text: string | null | undefined): Dose[] | undefined {
  if (text === null || text === undefined) return undefined;
  const parts = text.split(/[;\n]/).map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) return undefined;
  const out: Dose[] = [];
  const re = /^age\s+(\d+)\s*(months?|years?)\s+up\s+to\s+(\d+)\s*(months?|years?)\s*[—–-]\s*(.+?)\s*(?:\(\s*total\s+([^)]+?)\s*\))?\s*$/i;
  for (const p of parts) {
    const m = re.exec(p);
    if (!m) return undefined;
    const min = toMonths(Number(m[1]), m[2] as string);
    const below = toMonths(Number(m[3]), m[4] as string);
    const dose = collapse(m[5] as string);
    if (min >= below || dose === "" || dose.length > 200) return undefined;
    const total = m[6] !== undefined ? collapse(m[6]) : undefined;
    out.push({ age_months_min: min, age_months_below: below, dose, ...(total !== undefined && total !== "" ? { total } : {}) });
  }
  return out;
}

/** "in 3 days" -> scheduled 3; "on return" -> on_return. Undefined when neither reads. */
export function parseFollowup(text: string, dueText: string | null): { kind: "on_return" | "scheduled"; due: number | null } | undefined {
  const all = `${text} ${dueText ?? ""}`;
  const m = /\bin\s+(\d+)\s+days?\b/i.exec(all);
  if (m) return { kind: "scheduled", due: Number(m[1]) };
  if (/\bon\s+return\b/i.test(all)) return { kind: "on_return", due: null };
  return undefined;
}

/** Entry limits are a team choice, never the guideline's. */
const ENTRY_LIMITS: Record<string, { min: number; max: number; message: string }> = {
  months: { min: 0, max: 120, message: "Enter age in whole months." },
  days: { min: 0, max: 365, message: "Enter a number of days." },
  breaths_per_minute: { min: 10, max: 120, message: "Recount. Enter breaths in one full minute." },
};
const DEFAULT_LIMIT = { min: 0, max: 999, message: "Enter a whole number." };

export function sources(srcs: readonly ExSrc[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of srcs) {
    if (s.quote.trim() === "" || !Number.isInteger(s.pdf_page) || s.pdf_page < 1) continue;
    const k = `${s.pdf_page}\u0000${s.quote}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ page: s.pdf_page, quote: s.quote });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

const sourced = (src: Source[]): { origin: "guideline"; source: Source[] } | { origin: "team" } =>
  src.length > 0 ? { origin: "guideline", source: src } : { origin: "team" };

function describeThreshold(t: Ex["thresholds"][number]): string {
  return `${t.variable} ${t.op} ${t.value}${t.unit ? " " + t.unit : ""}${t.age_band ? ` (${t.age_band})` : ""}`;
}

type OpResult = { op: "at_least" | "less_than"; value: number } | undefined;

/** Exact only: whole-number cut-offs, compared with whole-number answers. */
export function mapThresholdOp(op: string, value: number): OpResult {
  if (!Number.isSafeInteger(value)) return undefined;
  switch (op.trim()) {
    case ">=":
    case "≥":
      return { op: "at_least", value };
    case "<":
      return { op: "less_than", value };
    case ">":
      return { op: "at_least", value: value + 1 };
    case "<=":
    case "≤":
      return { op: "less_than", value: value + 1 };
    default:
      return undefined;
  }
}

/** Words of 4 letters or more, cut to 5 letters, so "vomit" and "vomits" meet. */
const stems = (t: string): Set<string> => new Set((t.toLowerCase().match(/\p{L}{4,}/gu) ?? []).map((w) => w.slice(0, 5)));
const sharesWord = (a: string, b: string): boolean => {
  const sb = stems(b);
  return [...stems(a)].some((w) => sb.has(w));
};

/** Every string of the extraction with where it is, to look for planted instructions. */
function extractionStrings(ex: ExtractionOutput): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  const walk = (id: string, x: unknown): void => {
    if (typeof x === "string") out.push({ id, text: x });
    else if (Array.isArray(x)) x.forEach((y) => walk(id, y));
    else if (x !== null && typeof x === "object") for (const v of Object.values(x)) walk(id, v);
  };
  for (const list of [ex.nodes, ex.variables, ex.danger_signs, ex.actions, ex.followups, ex.unclear_items]) for (const it of list) walk(it.id, it);
  ex.thresholds.forEach((t, i) => walk(`threshold ${i}`, t));
  return out;
}

// ---------- the resolver ----------

type OQ = { question: string; affects: string[]; route_to: "clinician" | "program_officer"; source?: Source[] };

export function resolveDraft(draft: Draft, ex: Ex, opts: ResolveOptions): ResolveResult {
  const problems: string[] = [];
  const problem = (s: string): void => {
    if (!problems.includes(s)) problems.push(s);
  };

  const variables = new Map(ex.variables.map((v) => [v.id, v]));
  const dangerSigns = new Map(ex.danger_signs.map((d) => [d.id, d]));
  const nodes = new Map(ex.nodes.map((n) => [n.id, n]));
  const actions = new Map(ex.actions.map((a) => [a.id, a]));
  const followups = new Map(ex.followups.map((f) => [f.id, f]));
  const unclear = new Map(ex.unclear_items.map((u) => [u.id, u]));
  const exSrc = new Map<string, readonly ExSrc[]>();
  for (const list of [ex.variables, ex.danger_signs, ex.nodes, ex.actions, ex.followups]) {
    for (const it of list) if (!exSrc.has(it.id)) exSrc.set(it.id, it.src);
  }
  for (const u of ex.unclear_items) if (!exSrc.has(u.id)) exSrc.set(u.id, unclearSrc(u, ex));

  // ---- draft ids ----
  const draftIds = new Map<string, string>();
  const claim = (id: string, what: string): void => {
    const prev = draftIds.get(id);
    if (prev !== undefined) problem(`The id "${id}" is used twice (${prev} and ${what}); every question, derived item and outcome needs its own id.`);
    else draftIds.set(id, what);
  };
  draft.questions.forEach((q) => claim(q.id, "question"));
  draft.derived.forEach((d) => claim(d.id, "derived item"));
  draft.outcomes.forEach((o) => claim(o.id, "outcome"));
  const AGE_OUTCOME = "refer_outside_age_range";
  const AGE_URGENT_OUTCOME = "refer_urgent_outside_age_range";
  const AGE_DERIVED = "outside_age_range";
  for (const reserved of [AGE_OUTCOME, AGE_URGENT_OUTCOME, AGE_DERIVED]) {
    if (draftIds.has(reserved)) problem(`The id "${reserved}" is reserved for the rule code adds; use another id.`);
  }

  const citeSources = (ids: readonly string[] | undefined, where: string): ExSrc[] => {
    const out: ExSrc[] = [];
    for (const id of ids ?? []) {
      const s = exSrc.get(id);
      if (s === undefined) problem(`${where} cites "${id}", which is not an id in the extraction.`);
      // A danger sign is asked by a question, never by a cite: its quote is not added here.
      else if (!dangerSigns.has(id)) out.push(...s);
    }
    return out;
  };

  // ---- questions ----
  type QInfo = { index: number; id: string; integer: boolean; variableId?: string; unit?: string };
  const qById = new Map<string, QInfo>();
  const qByVariable = new Map<string, string>();
  const linkedDangerSigns = new Set<string>();
  const questionSrc: ExSrc[][] = [];
  draft.questions.forEach((q, index) => {
    const src: ExSrc[] = [];
    let unit: string | undefined;
    if (q.variable_id !== undefined) {
      const v = variables.get(q.variable_id);
      if (v === undefined) problem(`Question "${q.id}": variable_id "${q.variable_id}" is not in extraction.variables.`);
      else {
        src.push(...v.src);
        unit = normalizeUnit(v.unit);
        const hint = v.type_hint.toLowerCase();
        const expected = hint === "boolean" ? "yes_no" : hint === "integer" ? "integer" : undefined;
        if (expected !== undefined && expected !== q.answer_type) {
          problem(`Question "${q.id}": answer_type is "${q.answer_type}" but variable "${v.id}" is ${hint}; use "${expected}".`);
        }
        const other = qByVariable.get(v.id);
        if (other !== undefined) problem(`Questions "${other}" and "${q.id}" both ask variable "${v.id}"; ask it once.`);
        else qByVariable.set(v.id, q.id);
      }
    }
    if (q.danger_sign_id !== undefined) {
      const d = dangerSigns.get(q.danger_sign_id);
      if (d === undefined) problem(`Question "${q.id}": danger_sign_id "${q.danger_sign_id}" is not in extraction.danger_signs.`);
      else {
        // The question's own variable or node must describe this sign (a cough question cannot carry "blood in stool").
        const own = [
          q.variable_id !== undefined ? variables.get(q.variable_id)?.label : undefined,
          q.node_id !== undefined ? nodes.get(q.node_id)?.text : undefined,
        ].filter((x): x is string => x !== undefined);
        if (own.length > 0 && !own.some((t) => sharesWord(t, d.text))) {
          problem(`Question "${q.id}": danger_sign_id "${d.id}" ("${collapse(d.text)}") is not what its variable or node is about ("${collapse(own.join("; "))}"); link the question to the matching danger sign or remove danger_sign_id.`);
        } else {
          src.push(...d.src);
          linkedDangerSigns.add(d.id);
        }
      }
    }
    if (q.node_id !== undefined) {
      const n = nodes.get(q.node_id);
      if (n === undefined) problem(`Question "${q.id}": node_id "${q.node_id}" is not in extraction.nodes.`);
      else src.push(...n.src);
    }
    questionSrc.push(src);
    qById.set(q.id, { index, id: q.id, integer: q.answer_type === "integer", ...(q.variable_id !== undefined ? { variableId: q.variable_id } : {}), ...(unit !== undefined ? { unit } : {}) });
  });

  // ---- age question and scope ----
  const ageVariables = ex.variables.filter((v) => normalizeUnit(v.unit) === "months");
  const ageVariable = ageVariables.find((v) => /age/i.test(`${v.id} ${v.label}`)) ?? ageVariables[0];
  const ageQuestionId = ageVariable !== undefined ? qByVariable.get(ageVariable.id) : undefined;
  const ageQuestion = ageQuestionId !== undefined ? qById.get(ageQuestionId) : undefined;
  let scope: Band | undefined;
  let scopeInferredFrom: string | undefined;
  /** The quotes the age range rests on: the age variable's, or those it was inferred from. */
  let scopeSrc: ExSrc[] = ageVariable?.src ?? [];
  if (ageVariable === undefined) {
    problem("The extraction has no child age variable (unit months), so the age range the form covers cannot be set.");
  } else {
    if (ageQuestion === undefined || !ageQuestion.integer) {
      problem(`Add an integer question with variable_id "${ageVariable.id}" (the child's age); the age range and age bands need it.`);
    }
    scope = parseAgeBand(ageVariable.range_hint);
    if (scope === undefined) {
      // The draft cannot change the extraction, so a repair call can never fix an empty or unreadable
      // range_hint. Infer the range from the extraction's own text instead and ask the clinician to confirm.
      const inferred = inferScope(ex, ageVariable);
      if (inferred === undefined) {
        problem(`The age range of variable "${ageVariable.id}" ("${ageVariable.range_hint ?? ""}") cannot be read as "X months up to Y months/years".`);
      } else {
        scope = inferred.band;
        scopeInferredFrom = inferred.from;
        scopeSrc = inferred.src;
      }
    }
  }

  // ---- thresholds: which can be written exactly ----
  const thresholdRep = ex.thresholds.map((t) => {
    const op = mapThresholdOp(t.op, t.value);
    const band = t.age_band === null ? null : parseAgeBand(t.age_band);
    return { op, band };
  });

  // ---- condition resolution ----
  type Mode = { kind: "shown_when"; before: number } | { kind: "definition"; before: number } | { kind: "rule" };
  const derivedIndex = new Map(draft.derived.map((d, i) => [d.id, i]));
  const usedBands = new Map<string, Set<string>>(); // band text -> model item ids
  const allUsedThresholds = new Set<number>();
  const resolveCond = (c: DraftCondition, where: string, mode: Mode, used: Set<number>, owner: string): Condition | undefined => {
    if ("all" in c || "any" in c) {
      const kids = "all" in c ? c.all : c.any;
      const out: Condition[] = [];
      let ok = true;
      for (const k of kids) {
        const r = resolveCond(k, where, mode, used, owner);
        if (r === undefined) ok = false;
        else out.push(r);
      }
      if (!ok) return undefined;
      return "all" in c ? { all: out } : { any: out };
    }
    if ("ref" in c) {
      const q = qById.get(c.ref);
      if (q !== undefined) {
        if (q.integer) {
          problem(`${where}: "${c.ref}" is answered with a number, so it cannot be used as yes/no; use a threshold index on it instead.`);
          return undefined;
        }
        if (mode.kind === "shown_when" && q.index >= mode.before) {
          problem(`${where}: it reads "${c.ref}", which is asked later or is the question itself; a question may only depend on earlier questions.`);
          return undefined;
        }
        return { field: c.ref, op: "is_yes" };
      }
      const di = derivedIndex.get(c.ref);
      if (di !== undefined) {
        if (mode.kind === "shown_when") {
          problem(`${where}: it reads the derived item "${c.ref}"; when a question is asked may only depend on earlier questions.`);
          return undefined;
        }
        if (mode.kind === "definition" && di >= mode.before) {
          problem(`${where}: it reads the derived item "${c.ref}", which is defined later or is the item itself; a derived item may only read derived items listed before it.`);
          return undefined;
        }
        return { field: c.ref, op: "is_yes" };
      }
      problem(`${where}: "${c.ref}" is not a question or derived item of this draft.`);
      return undefined;
    }
    const idx = c.threshold;
    const t = ex.thresholds[idx];
    if (t === undefined) {
      problem(`${where}: threshold index ${idx} does not exist (the extraction has ${ex.thresholds.length} thresholds, 0 to ${ex.thresholds.length - 1}).`);
      return undefined;
    }
    const rep = thresholdRep[idx] as { op: OpResult; band: Band | null | undefined };
    const qid = qByVariable.get(t.variable);
    const q = qid !== undefined ? qById.get(qid) : undefined;
    if (q === undefined) {
      problem(`${where}: threshold ${idx} (${describeThreshold(t)}) reads variable "${t.variable}", but no question has variable_id "${t.variable}"; add that question.`);
      return undefined;
    }
    if (!q.integer) {
      problem(`${where}: threshold ${idx} compares "${q.id}" with a number, but "${q.id}" is a yes/no question.`);
      return undefined;
    }
    if (rep.op === undefined || rep.band === undefined) {
      problem(`${where}: threshold ${idx} (${describeThreshold(t)}) cannot be written exactly in the form, so do not use it in a condition; ask about it in open_questions instead.`);
      return undefined;
    }
    if (mode.kind === "shown_when" && q.index >= mode.before) {
      problem(`${where}: threshold ${idx} reads "${q.id}", which is asked later or is the question itself.`);
      return undefined;
    }
    used.add(idx);
    allUsedThresholds.add(idx);
    const leaf: Condition = { field: q.id, op: rep.op.op, value: rep.op.value };
    if (rep.band === null) return leaf;
    if (ageQuestion === undefined || !ageQuestion.integer) {
      problem(`${where}: threshold ${idx} applies to an age band ("${t.age_band}") but there is no age question.`);
      return undefined;
    }
    if (mode.kind === "shown_when" && ageQuestion.index >= mode.before) {
      problem(`${where}: threshold ${idx} needs the age, which is asked later.`);
      return undefined;
    }
    const bandText = t.age_band as string;
    const set = usedBands.get(bandText) ?? new Set<string>();
    set.add(owner);
    usedBands.set(bandText, set);
    const parts: Condition[] = [];
    if (rep.band.min > 0) parts.push({ field: ageQuestion.id, op: "at_least", value: rep.band.min });
    parts.push({ field: ageQuestion.id, op: "less_than", value: rep.band.below }, leaf);
    return { all: parts };
  };
  const thresholdSrc = (used: Set<number>): ExSrc[] => [...used].sort((a, b) => a - b).flatMap((i) => ex.thresholds[i]?.src ?? []);

  const oqs: OQ[] = [];
  const teamItems: string[] = [];

  // ---- questions (model shape) ----
  const integerQuestions: string[] = [];
  const questions = draft.questions.map((q, i) => {
    const info = qById.get(q.id) as QInfo;
    const used = new Set<number>();
    const shown = q.shown_when !== undefined ? resolveCond(q.shown_when, `Question "${q.id}" shown_when`, { kind: "shown_when", before: i }, used, q.id) : undefined;
    const src = sources([...(questionSrc[i] ?? []), ...thresholdSrc(used)]);
    let constraint: { min: number; max: number; message: string; origin: "team" } | undefined;
    if (q.answer_type === "integer") {
      const lim = (info.unit !== undefined ? ENTRY_LIMITS[info.unit] : undefined) ?? DEFAULT_LIMIT;
      const max = info.id === ageQuestionId && scope !== undefined ? Math.max(lim.max, scope.below + 12) : lim.max;
      constraint = { min: lim.min, max, message: lim.message, origin: "team" };
      integerQuestions.push(q.id);
    }
    return {
      id: q.id,
      order: i + 1,
      label: clipText(q.label),
      answer_type: q.answer_type,
      ...(q.answer_type === "integer" && info.unit !== undefined ? { unit: info.unit } : {}),
      required: true,
      ...(constraint !== undefined ? { constraint } : {}),
      ...(shown !== undefined ? { shown_when: shown } : {}),
      ...sourced(src),
    };
  });
  for (const q of questions) if (q.origin === "team") teamItems.push(q.id);

  // ---- derived ----
  /** Calculated values and rules whose only support is the draft's own cite list. */
  const citeOnly: string[] = [];
  const derived = draft.derived.map((d, i) => {
    const used = new Set<number>();
    const def = resolveCond(d.definition, `Derived "${d.id}" definition`, { kind: "definition", before: i }, used, d.id);
    const src = sources([...thresholdSrc(used), ...citeSources(d.cite, `Derived "${d.id}"`)]);
    if (src.length === 0) teamItems.push(d.id);
    const definition = def ?? { field: d.id, op: "is_yes" as const };
    if (used.size === 0 && src.length > 0) {
      citeOnly.push(d.id);
      return { id: d.id, label: clipText(d.label), definition, origin: "team" as const, source: src };
    }
    return { id: d.id, label: clipText(d.label), definition, ...sourced(src) };
  });

  // ---- outcomes ----
  const droppedRefs: string[] = [];
  const unparsedDoses: { outcome: string; action: string; text: string }[] = [];
  const unparsedFollowups: { outcome: string; followup: string; text: string }[] = [];
  const scheduledFollowups: string[] = [];
  const unnamedDrugs = new Map<string, { drug: string; text: string; outcomes: string[] }>();
  /** The quotes of a node that sit in the block of its first quote, in order: the booklet's wording of that step. */
  const quoteText = (src: readonly ExSrc[]): string => {
    const first = src.find((x) => x.quote.trim() !== "");
    if (first === undefined) return "";
    return collapse(src.filter((x) => x.block_id === first.block_id && x.pdf_page === first.pdf_page).map((x) => x.quote).join(" "));
  };
  const outcomes = draft.outcomes.map((o) => {
    const acts = o.action_ids.flatMap((aid) => {
      const a = actions.get(aid);
      if (a !== undefined) {
        const src = sources(a.src);
        // The booklet's words only: no medicine name is put in front of a quote that does not name it.
        const text = collapse(a.src.find((x) => x.quote.trim() !== "")?.quote ?? "");
        if (a.drug !== null && collapse(a.drug) !== "" && !text.toLowerCase().includes(collapse(a.drug).toLowerCase())) {
          const u = unnamedDrugs.get(aid) ?? { drug: collapse(a.drug), text, outcomes: [] };
          u.outcomes.push(o.id);
          unnamedDrugs.set(aid, u);
        }
        const doses = a.dose_text !== null ? parseDoseText(a.dose_text) : undefined;
        if (a.dose_text !== null && doses === undefined) unparsedDoses.push({ outcome: o.id, action: aid, text: collapse(a.dose_text) });
        if (text === "" || src.length === 0) {
          teamItems.push(o.id);
          return [{ text: `The guideline reading gave no booklet wording for step ${aid}. The team must write it before use.`, origin: "team" as const }];
        }
        return [{ text: clipText(text), ...sourced(src), ...(doses !== undefined ? { dose_by_age: doses } : {}) }];
      }
      const n = nodes.get(aid);
      if (n !== undefined && (n.kind === "action" || n.kind === "advice")) {
        // The node's quotes, never its text field (which the guideline reader wrote, and could carry anything).
        const text = quoteText(n.src);
        const src = sources(n.src);
        if (text === "" || src.length === 0) {
          teamItems.push(o.id);
          return [{ text: `The guideline reading gave no booklet wording for step ${aid}. The team must write it before use.`, origin: "team" as const }];
        }
        return [{ text: clipText(text), ...sourced(src) }];
      }
      // A non-action node (often the outcome's own node) carries no step to show: drop it. If nothing is left,
      // the outcome gets the team placeholder below, which the open questions list for the clinician.
      if (n !== undefined) droppedRefs.push(`${o.id} → ${aid} (${n.kind})`);
      else problem(`Outcome "${o.id}": action "${aid}" is not in extraction.actions or extraction.nodes.`);
      return [];
    });
    if (acts.length === 0) {
      acts.push({ text: "The guideline gives no action for this result. The team must write one before use.", origin: "team" });
      teamItems.push(o.id);
    }
    let follow_up: {
      kind: "on_return" | "scheduled";
      due_in_days: number | null;
      task_window_days_after_due: null;
      origin: "guideline" | "team";
      source?: Source[];
    } | null = null;
    if (o.followup_id !== undefined && o.followup_id !== null) {
      const f = followups.get(o.followup_id);
      if (f === undefined) problem(`Outcome "${o.id}": followup_id "${o.followup_id}" is not in extraction.followups.`);
      else {
        const p = parseFollowup(f.text, f.due_text);
        if (p === undefined) unparsedFollowups.push({ outcome: o.id, followup: f.id, text: collapse(f.text) });
        else {
          follow_up = { kind: p.kind, due_in_days: p.due, task_window_days_after_due: null, ...sourced(sources(f.src)) };
          if (p.kind === "scheduled") scheduledFollowups.push(o.id);
        }
      }
    }
    const src = sources(citeSources(o.cite, `Outcome "${o.id}"`));
    if (src.length === 0 && !teamItems.includes(o.id)) teamItems.push(o.id);
    return { id: o.id, severity: o.severity, title: clipText(o.title), actions: acts, follow_up, ...sourced(src) };
  });
  const outcomeById = new Map(outcomes.map((o) => [o.id, o]));

  // ---- rules ----
  const sortedRules = draft.rules.map((r, i) => ({ r, i })).sort((a, b) => a.r.priority - b.r.priority || a.i - b.i);
  const prios = new Set<number>();
  for (const { r } of sortedRules) {
    if (prios.has(r.priority)) problem(`Two rules have priority ${r.priority}; priorities must be unique.`);
    prios.add(r.priority);
    if (!outcomeById.has(r.outcome)) problem(`The rule with priority ${r.priority} goes to "${r.outcome}", which is not an outcome of this draft.`);
  }
  const otherwiseRules = sortedRules.filter(({ r }) => r.when === "otherwise");
  if (otherwiseRules.length > 1) problem(`There are ${otherwiseRules.length} "otherwise" rules; at most one is allowed.`);
  const mostUrgent = [...outcomes].sort((a, b) => a.severity - b.severity)[0];

  type RuleOut = { id: string; priority: number; when: Condition | "otherwise"; outcome: string; origin: "guideline" | "team"; source?: Source[] };
  const rules: RuleOut[] = [];
  const addRule = (when: Condition | "otherwise", outcome: string, src: Source[]): string => {
    const id = `R${rules.length + 1}`;
    rules.push({ id, priority: rules.length + 1, when, outcome, ...sourced(src) });
    return id;
  };

  // Out-of-range ages first: the guideline's cut-offs only hold inside its age range.
  let ageRuleId: string | undefined;
  let ageUrgentRuleId: string | undefined;
  const extraOutcomes: typeof outcomes = [];
  if (ageQuestion !== undefined && ageQuestion.integer && scope !== undefined && mostUrgent !== undefined) {
    const parts: Condition[] = [];
    if (scope.min > 0) parts.push({ field: ageQuestion.id, op: "less_than", value: scope.min });
    parts.push({ field: ageQuestion.id, op: "at_least", value: scope.below });
    const outsideCond: Condition = parts.length === 1 ? (parts[0] as Condition) : { any: parts };
    // Referral steps are quoted from the guideline when it has them (never drugs: doses are only
    // given for the covered ages); the choice to refer is the team's and is an open question.
    const referActs = ex.actions
      .filter((a) => a.type === "refer" || a.type === "referral_step")
      .map((a) => ({ text: clipText(a.src[0]?.quote ?? a.type), ...sourced(sources(a.src)) }))
      .filter((a) => a.origin === "guideline");
    const onReturn = ex.followups.find((f) => parseFollowup(f.text, f.due_text)?.kind === "on_return");
    const onReturnSrc = onReturn !== undefined ? sources(onReturn.src) : [];
    const followUp = (): (typeof outcomes)[number]["follow_up"] =>
      onReturnSrc.length > 0
        ? { kind: "on_return", due_in_days: null, task_window_days_after_due: null, origin: "guideline", source: onReturnSrc }
        : null;
    // The routine out-of-range outcome (the second of two) must not tell the worker to refer urgently:
    // referral steps whose words or quotes say "urgent" are left to the urgent outcome.
    const referOrTeam = (routine = false): (typeof outcomes)[number]["actions"] => {
      const acts = routine ? referActs.filter((a) => !/urgent/i.test(a.text) && !(a.source ?? []).some((x) => /urgent/i.test(x.quote))) : referActs;
      return acts.length > 0
        ? acts.map((a) => ({ ...a }))
        : [{ text: "Refer the child to a health facility. This form covers only the age range the guideline states.", origin: "team" as const }];
    };
    const withDanger = draft.derived.some((d) => d.id === "danger_sign");
    // The age check as a calculated value (read by the rules below), placed before the draft's own.
    const ageSrc = sources(scopeSrc).length > 0 ? sources(scopeSrc) : [{ page: 1, quote: ageVariable!.range_hint ?? "age" }];
    if (withDanger) derived.unshift({ id: AGE_DERIVED, label: "Outside the age range this guideline covers", definition: outsideCond, ...sourced(ageSrc) });
    const outsideIs: Condition = withDanger ? { field: AGE_DERIVED, op: "is_yes" } : outsideCond;
    if (withDanger) {
      extraOutcomes.push({
        id: AGE_URGENT_OUTCOME,
        severity: mostUrgent.severity,
        title: "Danger sign, outside this form's age range: refer urgently. Give no medicine from this form.",
        actions: [
          ...referOrTeam(),
          {
            text: "Do not give medicine from this form. The guideline gives no doses outside the age range this form covers.",
            origin: "team" as const,
          },
        ],
        follow_up: followUp(),
        origin: "team",
      });
      extraOutcomes.push({
        id: AGE_OUTCOME,
        severity: Math.min(9, mostUrgent.severity + 1),
        title: "Outside this form's age range, no danger sign: refer to health facility",
        actions: referOrTeam(true),
        follow_up: followUp(),
        origin: "team",
      });
      ageUrgentRuleId = addRule({ all: [outsideIs, { field: "danger_sign", op: "is_yes" }] }, AGE_URGENT_OUTCOME, []);
      ageRuleId = addRule(outsideIs, AGE_OUTCOME, []);
    } else {
      extraOutcomes.push({
        id: AGE_OUTCOME,
        severity: mostUrgent.severity,
        title: "Refer to health facility: the child's age is outside the range this form covers",
        actions: referOrTeam(),
        follow_up: followUp(),
        origin: "team",
      });
      ageRuleId = addRule(outsideIs, AGE_OUTCOME, []);
    }
  }

  const ruleOwner = new Map<number, string>();
  for (const { r } of sortedRules) {
    if (r.when === "otherwise") continue;
    const used = new Set<number>();
    const owner = `R${rules.length + 1}`;
    ruleOwner.set(r.priority, owner);
    const when = resolveCond(r.when, `The rule with priority ${r.priority}`, { kind: "rule" }, used, owner);
    const src = sources([...citeSources(r.cite, `The rule with priority ${r.priority}`), ...thresholdSrc(used)]);
    const id = addRule(when ?? "otherwise", r.outcome, src);
    if (src.length === 0) teamItems.push(id);
    else if (used.size === 0) {
      const rule = rules[rules.length - 1] as RuleOut;
      rule.origin = "team";
      citeOnly.push(id);
    }
  }
  const otherwise = otherwiseRules[0]?.r;
  const catchOutcome = otherwise?.outcome ?? mostUrgent?.id ?? "";
  const catchRuleId = addRule("otherwise", catchOutcome, []);

  // ---- scope.excluded ----
  const excluded: { item: string; reason: string }[] = [];
  // Asked: a question linked to the sign, or a cut-off (used in a condition) read from the sign's own passage.
  const usedThresholdSrc = [...allUsedThresholds].flatMap((i) => ex.thresholds[i]?.src ?? []);
  const askedByThreshold = (d: Ex["danger_signs"][number]): boolean =>
    d.src.some((x) =>
      usedThresholdSrc.some((t) => {
        if (t.pdf_page !== x.pdf_page || t.block_id !== x.block_id) return false;
        const a = normalizeForQuote(t.quote);
        const b = normalizeForQuote(x.quote);
        return a !== "" && b !== "" && (a.includes(b) || b.includes(a));
      }),
    );
  const leftOutSigns = ex.danger_signs.filter((d) => !linkedDangerSigns.has(d.id) && !askedByThreshold(d));
  for (const d of leftOutSigns) {
    excluded.push({ item: clipText(d.text), reason: "Danger sign not asked in this form. See the open question on danger signs." });
  }
  for (const n of ex.nodes.filter((x) => x.out_of_scope)) {
    excluded.push({ item: clipText(n.text), reason: "Marked out of scope when the guideline was read." });
  }

  // ---- open questions: the draft's, then every unclear item, then what code added ----
  const qIds = new Set(questions.map((q) => q.id));
  const modelIds = new Set<string>([...qIds, ...derived.map((d) => d.id), ...outcomes.map((o) => o.id)]);
  const affectsOf = (related: readonly string[], where: string, depth = 0): string[] => {
    const out: string[] = [];
    for (const id of related) {
      if (modelIds.has(id)) {
        out.push(id);
        continue;
      }
      if (!exSrc.has(id)) {
        problem(`${where}: related id "${id}" is not an extraction id or a draft item id.`);
        continue;
      }
      // An extraction id: the model items built from it.
      draft.questions.forEach((q) => {
        if (q.variable_id === id || q.danger_sign_id === id || q.node_id === id) out.push(q.id);
      });
      draft.derived.forEach((d) => {
        if (d.cite?.includes(id)) out.push(d.id);
      });
      draft.outcomes.forEach((o) => {
        if (o.action_ids.includes(id) || o.followup_id === id || o.cite?.includes(id)) out.push(o.id);
      });
      for (const { r } of sortedRules) {
        if (r.when !== "otherwise" && r.cite?.includes(id)) {
          const owner = ruleOwner.get(r.priority);
          if (owner !== undefined) out.push(owner);
        }
      }
      const u = unclear.get(id);
      if (u !== undefined && depth === 0) out.push(...affectsOf(u.related_ids.filter((x) => exSrc.has(x) || modelIds.has(x)), where, 1));
    }
    return [...new Set(out)];
  };
  const coveredUnclear = new Set<string>();
  draft.open_questions.forEach((q, i) => {
    const srcs: ExSrc[] = [];
    for (const id of q.related_ids) {
      const u = unclear.get(id);
      if (u !== undefined) {
        coveredUnclear.add(id);
        srcs.push(...unclearSrc(u, ex));
      }
    }
    const src = sources(srcs);
    oqs.push({ question: clipText(q.text), affects: affectsOf(q.related_ids, `Open question ${i + 1}`), route_to: q.route_to, ...(src.length > 0 ? { source: src } : {}) });
  });
  for (const u of ex.unclear_items) {
    if (coveredUnclear.has(u.id)) continue;
    const src = sources(unclearSrc(u, ex));
    oqs.push({
      question: clipText(`The guideline reader could not settle this (${u.id}): ${u.what_is_unclear}`),
      affects: affectsOf([u.id], `Unclear item ${u.id}`),
      // A passage the reader could not settle can carry clinical meaning, so a clinician decides it.
      route_to: "clinician",
      ...(src.length > 0 ? { source: src } : {}),
    });
  }

  if (problems.length > 0) return { ok: false, problems };

  for (const [band, owners] of usedBands) {
    const b = parseAgeBand(band) as Band;
    oqs.push({
      question: clipText(`The guideline says "${collapse(band)}". We read it as from ${b.min} months up to but not including ${b.below} months, so a child of exactly ${b.below} months is not in this group. Is that right?`),
      affects: [...owners],
      route_to: "clinician",
    });
  }
  ex.thresholds.forEach((t, i) => {
    const rep = thresholdRep[i] as { op: OpResult; band: Band | null | undefined };
    if (rep.op !== undefined && rep.band !== undefined) return;
    const src = sources(t.src);
    oqs.push({
      question: clipText(`The guideline gives the cut-off "${src[0]?.quote ?? describeThreshold(t)}", which the form cannot apply exactly as written, so it is not used. How should it be applied?`),
      affects: qByVariable.has(t.variable) ? [qByVariable.get(t.variable) as string] : [],
      route_to: "clinician",
      ...(src.length > 0 ? { source: src } : {}),
    });
  });
  for (const d of unparsedDoses) {
    oqs.push({
      question: clipText(`The dose "${d.text}" (${d.action}) could not be read as a dose for each age band, so the form shows it as text only. What dose should each age get?`),
      affects: [d.outcome],
      route_to: "clinician",
    });
  }
  for (const f of unparsedFollowups) {
    oqs.push({
      question: clipText(`The follow-up "${f.text}" (${f.followup}) gives no day or "on return" the form can schedule, so the result "${f.outcome}" has no follow-up. When should the follow-up happen?`),
      affects: [f.outcome],
      route_to: "clinician",
    });
  }
  if (leftOutSigns.length > 0) {
    oqs.push({
      question: clipText(
        `These danger signs from the guideline are not asked in this form: ${leftOutSigns.map((d) => collapse(d.text)).join("; ")}. Any general danger sign means urgent referral. Is it safe to use this form without them, or must they be added?`,
      ),
      affects: [],
      route_to: "clinician",
      source: sources(leftOutSigns.flatMap((d) => d.src.slice(0, 1))),
    });
  }
  if (scheduledFollowups.length > 0) {
    oqs.push({
      question: "How many days should the follow-up task stay open after it is due? The guideline gives the due day only.",
      affects: scheduledFollowups,
      // Task schedules go to a clinician (Medic's risk routing: relevance, calculations, constraints, task
      // conditions and schedules always go to a clinician).
      route_to: "clinician",
    });
  }
  if (integerQuestions.length > 0) {
    const limits = questions
      .filter((q) => q.constraint !== undefined)
      .map((q) => `${q.id} ${q.constraint!.min} to ${q.constraint!.max}`)
      .join(", ");
    oqs.push({
      question: clipText(`The entry limits (${limits}) and their messages are the team's choice, not the guideline's. Are they sensible?`),
      affects: integerQuestions,
      // Entry limits are constraints: a clinician decides them (same routing rule as above).
      route_to: "clinician",
    });
  }
  if (ageRuleId !== undefined && scope !== undefined) {
    const two = ageUrgentRuleId !== undefined;
    oqs.push({
      question: clipText(
        two
          ? `The guideline covers children from ${scope.min} months up to ${scope.below} months only. We refer out-of-range children urgently if they have a danger sign (${ageUrgentRuleId}) and routinely otherwise (${ageRuleId}), with no medicine. Is that right?`
          : `The guideline covers children from ${scope.min} months up to ${scope.below} months. Rule ${ageRuleId} (added by the team) refers every other child to a health facility as the most urgent result. Is that the right handling?`,
      ),
      affects: two ? [ageUrgentRuleId!, ageRuleId, AGE_URGENT_OUTCOME, AGE_OUTCOME] : [ageRuleId, AGE_OUTCOME],
      // Who gets referred, and how urgently, is a clinical call: the clinician decides it.
      route_to: "clinician",
    });
  }
  oqs.push({
    question: clipText(
      `When no other rule applies, the form shows "${catchOutcome}" (rule ${catchRuleId}, added by the team${otherwise === undefined ? "; the most urgent result was used because the draft gave none" : ""}). Is that the right result for those children?`,
    ),
    affects: [catchRuleId, catchOutcome].filter((x) => x !== ""),
    // What a child nobody else matched is told to do is a clinical call: the clinician decides it.
    route_to: "clinician",
  });
  for (const [aid, u] of unnamedDrugs) {
    oqs.push({
      question: clipText(`The booklet passage for the medicine step ${aid} ("${u.text}") does not name the medicine; the guideline reader linked it to "${u.drug}". The form shows the booklet's words only. Is it clear to the health worker which medicine this is, or must the wording be changed?`),
      affects: [...new Set(u.outcomes)],
      route_to: "clinician",
    });
  }
  if (citeOnly.length > 0) {
    oqs.push({
      question: clipText(
        `These items rest only on a passage the draft chose to cite, not on a cut-off or a question taken from the guideline, so they are marked as the team's: ${citeOnly.join(", ")}. Please check that each one does what the guideline says.`,
      ),
      affects: [...new Set(citeOnly)],
      route_to: "clinician",
    });
  }
  const planted = extractionStrings(ex).filter((x) => looksLikeInstruction(x.text));
  if (planted.length > 0) {
    oqs.push({
      question: clipText(
        `The guideline reading contains text that looks like an instruction to the computer rather than guideline content, in ${[...new Set(planted.map((x) => x.id))].join(", ")}: "${collapse(planted[0]!.text).slice(0, 160)}". It was treated as data and not followed. Check the guideline reading before going on.`,
      ),
      affects: [],
      route_to: "clinician",
    });
  }
  if (scopeInferredFrom !== undefined && scope !== undefined) {
    oqs.push({
      question: clipText(`The guideline reading did not record the age range the form covers, so it was taken from ${scopeInferredFrom}: ${scope.min} months up to ${scope.below} months. Is that the right age range?`),
      affects: ageQuestionId !== undefined ? [ageQuestionId] : [],
      route_to: "clinician",
    });
  }
  if (droppedRefs.length > 0) {
    oqs.push({
      question: clipText(`The draft listed steps that are not actions or advice, so they were left out of the results: ${droppedRefs.join("; ")}. Check that each result shows the right steps.`),
      affects: [...new Set(droppedRefs.map((r) => r.split(" → ")[0] as string))],
      route_to: "clinician",
    });
  }
  const teamOnly = [...new Set(teamItems)];
  if (teamOnly.length > 0) {
    oqs.push({
      question: clipText(`These items have no supporting quote from the guideline and are the team's wording or choice: ${teamOnly.join(", ")}. Please confirm or correct them.`),
      affects: teamOnly,
      route_to: "clinician",
    });
  }
  let fileSha = opts.guideline.fileSha256;
  if (fileSha === undefined || !/^[0-9a-f]{64}$/.test(fileSha)) {
    fileSha = MISSING_SHA;
    oqs.push({ question: "The fingerprint of the uploaded guideline file was not recorded for this run. Re-run ingest or record it before signing.", affects: [], route_to: "program_officer" });
  }
  const publisher = opts.guideline.publisher?.trim() || "Not recorded";
  const edition = opts.guideline.edition?.trim() || "Not recorded";
  if (publisher === "Not recorded" || edition === "Not recorded") {
    oqs.push({ question: "The guideline publisher and edition were not recorded. Please fill them in.", affects: [], route_to: "program_officer" });
  }

  const model: ResolvedModel = {
    schema_version: "1.0",
    meta: {
      pathway_id: opts.pathwayId,
      version: 1,
      parent_version: null,
      created_at: opts.createdAt,
      created_by: "ai_draft",
      change_note:
        opts.changeNote ??
        "First AI draft. The model chose items by id; code copied every number, operator and quote from the guideline extraction. Team-added items are listed in the open questions.",
      guideline: { title: clipText(opts.guideline.title, 200), publisher: clipText(publisher, 200), edition: clipText(edition, 200), file_sha256: fileSha },
    },
    scope: {
      age_months_min: (scope as Band).min,
      age_months_below: (scope as Band).below,
      source: sources(scopeSrc).length > 0 ? sources(scopeSrc) : [{ page: 1, quote: ageVariable!.range_hint?.trim() || ageVariable!.label?.trim() || "age" }],
      excluded,
    },
    questions,
    derived,
    outcomes: [...extraOutcomes, ...outcomes],
    hit_policy: "first_match_by_priority",
    rules,
    open_questions: oqs.map((q, i) => ({ id: `Q${i + 1}`, ...q, status: "open" as const })),
  };
  return { ok: true, model };
}

/** Where an unclear item sits: the page of its block (block ids look like "p7.b17"), with its quote. */
function unclearSrc(u: Ex["unclear_items"][number], ex: Ex): ExSrc[] {
  if (u.quote.trim() === "") return [];
  const m = /^p(\d+)\./.exec(u.block_id);
  let page = m ? Number(m[1]) : undefined;
  if (page === undefined) {
    for (const list of [ex.nodes, ex.variables, ex.danger_signs, ex.actions, ex.followups]) {
      for (const it of list) {
        const s = it.src.find((x) => x.block_id === u.block_id);
        if (s !== undefined) page = s.pdf_page;
      }
    }
  }
  return page === undefined ? [] : [{ block_id: u.block_id, pdf_page: page, quote: u.quote }];
}
