import { describe, expect, it } from "vitest";
import { DraftSchema, type Draft } from "../../../src/logic/fill/draftSchema.js";
import {
  isAgeVariable,
  mapThresholdOp,
  normalizeUnit,
  variableUnit,
  parseAgeBand,
  parseDoseText,
  parseFollowup,
  resolveDraft,
  type ResolveOptions,
  type ResolvedModel,
} from "../../../src/logic/fill/resolve.js";
import { parseModel } from "../../../src/logic/schema.js";
import type { ExtractionOutput } from "../../../src/steps/extractionSchema.js";

// Synthetic extraction: invented wording, no patient data.
const src = (page: number, quote: string, block = `p${page}.b1`) => [{ block_id: block, pdf_page: page, quote }];

function extraction(mutate?: (e: ExtractionOutput) => void): ExtractionOutput {
  const e: ExtractionOutput = {
    nodes: [
      { id: "n_ask", kind: "ask", text: "Ask about wheeze", parent_id: null, order: 1, clinical: false, pdf_page: 2, printed_page: null, out_of_scope: false, goto_target: null, src: src(2, "Wheeze?") },
      { id: "n_advice", kind: "advice", text: "Keep the child warm.", parent_id: null, order: 2, clinical: true, pdf_page: 4, printed_page: null, out_of_scope: false, goto_target: null, src: src(4, "Keep the child warm.") },
      { id: "n_dec", kind: "decision", text: "Any warning sign?", parent_id: null, order: 3, clinical: false, pdf_page: 3, printed_page: null, out_of_scope: false, goto_target: null, src: src(3, "Any warning sign?") },
      { id: "n_other", kind: "goto", text: "See the rash chart", parent_id: null, order: 4, clinical: false, pdf_page: 3, printed_page: null, out_of_scope: true, goto_target: null, src: src(3, "See the rash chart") },
    ],
    edges: [],
    variables: [
      { id: "age_m", label: "Child age", type_hint: "integer", unit: "months", range_hint: "1 month up to 3 years", used_by: [], src: src(1, "child age 1 month up to 3 years") },
      { id: "wheeze", label: "Wheeze", type_hint: "boolean", unit: null, range_hint: null, used_by: [], src: src(2, "Wheeze?") },
      { id: "rate", label: "Breaths", type_hint: "integer", unit: "breaths per minute", range_hint: null, used_by: [], src: src(2, "count breaths") },
      { id: "days", label: "Days ill", type_hint: "integer", unit: "days", range_hint: null, used_by: [], src: src(2, "how many days") },
    ],
    danger_signs: [
      { id: "ds_wheeze", text: "Wheeze", condition_text: null, cough_relevant: true, src: src(3, "Wheeze") },
      { id: "ds_rash", text: "Spreading rash", condition_text: null, cough_relevant: false, src: src(3, "Spreading rash") },
    ],
    thresholds: [
      { variable: "rate", op: ">=", value: 45, unit: "breaths per minute", age_band: null, src: src(3, "45 breaths or more") },
      { variable: "days", op: "<", value: 7, unit: "days", age_band: null, src: src(3, "less than 7 days") },
      { variable: "days", op: ">", value: 10, unit: "days", age_band: null, src: src(3, "more than 10 days") },
      { variable: "days", op: "<=", value: 3, unit: "days", age_band: null, src: src(3, "3 days or less") },
      { variable: "rate", op: "=", value: 30, unit: "breaths per minute", age_band: null, src: src(3, "exactly 30 breaths") },
      { variable: "rate", op: ">", value: 37.5, unit: "breaths per minute", age_band: null, src: src(3, "above 37.5") },
      { variable: "rate", op: ">=", value: 50, unit: "breaths per minute", age_band: "age 1 month up to 12 months", src: src(3, "In a child age 1 month up to 12 months, 50 or more") },
    ],
    actions: [
      { id: "act_drug", type: "drug", drug: "syrup X", dose_text: "Age 1 month up to 12 months—5 ml (total 50 ml); Age 12 months up to 3 years—10 ml (total 100 ml)", age_band: null, frequency: null, duration: null, trigger_node_id: null, clinical: true, src: src(4, "Give syrup X twice daily") },
      { id: "act_drug_bad", type: "drug", drug: "syrup Y", dose_text: "Give a spoonful when needed", age_band: null, frequency: null, duration: null, trigger_node_id: null, clinical: true, src: src(4, "Give syrup Y") },
      { id: "act_refer", type: "refer", drug: null, dose_text: null, age_band: null, frequency: null, duration: null, trigger_node_id: null, clinical: true, src: src(3, "REFER TO CLINIC") },
    ],
    followups: [
      { id: "fu_3", text: "See the child again in 3 days.", due_text: "in 3 days", trigger_node_id: null, src: src(4, "again in 3 days") },
      { id: "fu_return", text: "Follow up on return.", due_text: null, trigger_node_id: null, src: src(3, "Follow up on return") },
      { id: "fu_vague", text: "Check later if worse.", due_text: null, trigger_node_id: null, src: src(4, "Check later if worse") },
    ],
    unclear_items: [
      { id: "u1", block_id: "p4.b9", quote: "see chart 7", what_is_unclear: "Chart 7 is missing.", related_ids: ["n_advice"] },
      { id: "u2", block_id: "p2.b3", quote: "count again", what_is_unclear: "When to recount is not said.", related_ids: ["rate"] },
    ],
  };
  mutate?.(e);
  return e;
}

const SHA = "a".repeat(64);
const opts: ResolveOptions = { pathwayId: "wheeze_test", createdAt: "2026-11-04T10:00:00Z", guideline: { title: "Synthetic guideline", publisher: "Team", edition: "1", fileSha256: SHA } };

function draft(mutate?: (d: any) => void): Draft {
  const d: any = {
    questions: [
      { id: "age_months", label: "Age in months", answer_type: "integer", variable_id: "age_m" },
      { id: "wheeze", label: "Wheeze?", answer_type: "yes_no", variable_id: "wheeze", danger_sign_id: "ds_wheeze" },
      { id: "rate", label: "Breaths in a minute", answer_type: "integer", variable_id: "rate" },
      { id: "days", label: "Days ill", answer_type: "integer", variable_id: "days", shown_when: { ref: "wheeze" } },
    ],
    derived: [{ id: "fast", label: "Fast", definition: { threshold: 0 }, cite: ["n_dec"] }],
    outcomes: [
      { id: "refer", severity: 1, title: "Refer", action_ids: ["act_refer"], followup_id: "fu_return", cite: ["n_dec"] },
      { id: "treat", severity: 3, title: "Treat at home", action_ids: ["act_drug", "n_advice"], followup_id: "fu_3", cite: ["n_advice"] },
      { id: "home", severity: 5, title: "Home care", action_ids: [] },
    ],
    rules: [
      { priority: 10, when: { ref: "wheeze" }, outcome: "refer", cite: ["n_dec"] },
      { priority: 20, when: { ref: "fast" }, outcome: "treat" },
    ],
    open_questions: [],
  };
  mutate?.(d);
  return DraftSchema.parse(d);
}

function ok(d: Draft, e = extraction(), o = opts): ResolvedModel {
  const r = resolveDraft(d, e, o);
  if (!r.ok) throw new Error(r.problems.join("\n"));
  const p = parseModel(r.model);
  if (!p.ok) throw new Error("does not parse: " + p.issues.join("; "));
  return r.model;
}
function problems(d: Draft, e = extraction()): string[] {
  const r = resolveDraft(d, e, opts);
  if (r.ok) throw new Error("expected problems");
  return r.problems;
}
const derivedDef = (m: ResolvedModel, id: string) => m.derived.find((x) => x.id === id)!.definition;

describe("threshold operators", () => {
  it("maps each operator exactly, shifting > and <= by one only for whole numbers", () => {
    expect(mapThresholdOp(">=", 45)).toEqual({ op: "at_least", value: 45 });
    expect(mapThresholdOp("<", 7)).toEqual({ op: "less_than", value: 7 });
    expect(mapThresholdOp(">", 10)).toEqual({ op: "at_least", value: 11 });
    expect(mapThresholdOp("<=", 3)).toEqual({ op: "less_than", value: 4 });
    expect(mapThresholdOp("=", 30)).toBeUndefined();
    expect(mapThresholdOp(">", 37.5)).toBeUndefined();
    expect(mapThresholdOp(">=", 37.5)).toBeUndefined();
  });

  it.each([
    [0, { field: "rate", op: "at_least", value: 45 }],
    [1, { field: "days", op: "less_than", value: 7 }],
    [2, { field: "days", op: "at_least", value: 11 }],
    [3, { field: "days", op: "less_than", value: 4 }],
  ])("threshold %i resolves from the extraction, with its source", (idx, expected) => {
    const m = ok(draft((d) => (d.derived[0].definition = { threshold: idx })));
    expect(derivedDef(m, "fast")).toEqual(expected);
    const t = extraction().thresholds[idx]!;
    expect(m.derived[0]!.source).toContainEqual({ page: t.src[0]!.pdf_page, quote: t.src[0]!.quote });
  });

  it("adds the age band of a threshold and asks how its end is read", () => {
    const m = ok(draft((d) => (d.derived[0].definition = { threshold: 6 })));
    expect(derivedDef(m, "fast")).toEqual({
      all: [
        { field: "age_months", op: "at_least", value: 1 },
        { field: "age_months", op: "less_than", value: 12 },
        { field: "rate", op: "at_least", value: 50 },
      ],
    });
    const q = m.open_questions.find((x) => x.question.includes("age 1 month up to 12 months"))!;
    expect(q.route_to).toBe("clinician");
    expect(q.affects).toEqual(["fast"]);
  });

  it.each([4, 5])("does not guess threshold %i: using it is a problem, and it is always an open question", (idx) => {
    expect(problems(draft((d) => (d.derived[0].definition = { threshold: idx })))[0]).toMatch(new RegExp(`threshold ${idx} .*cannot be written exactly`));
    const m = ok(draft());
    const quote = extraction().thresholds[idx]!.src[0]!.quote;
    expect(m.open_questions.some((q) => q.question.includes(quote) && q.route_to === "clinician")).toBe(true);
  });
});

describe("draft problems (repairable)", () => {
  const cases: Array<[string, (d: any) => void, RegExp]> = [
    ["unknown ref", (d) => (d.rules[0].when = { ref: "nope" }), /"nope" is not a question or derived item/],
    ["threshold index out of range", (d) => (d.derived[0].definition = { threshold: 99 }), /threshold index 99 does not exist/],
    ["threshold with no question for its variable", (d) => d.questions.splice(2, 1), /no question has variable_id "rate"/],
    ["yes/no ref to a number question", (d) => (d.rules[0].when = { ref: "rate" }), /answered with a number/],
    ["shown_when reads a later question", (d) => (d.questions[1].shown_when = { ref: "wheeze" }), /asked later or is the question itself/],
    ["shown_when reads a derived item", (d) => (d.questions[3].shown_when = { ref: "fast" }), /reads the derived item "fast"/],
    ["derived reads a later derived item", (d) => d.derived.unshift({ id: "early", label: "Early", definition: { ref: "fast" } }), /defined later/],
    ["unknown variable", (d) => (d.questions[1].variable_id = "ghost"), /variable_id "ghost" is not in extraction.variables/],
    ["unknown danger sign", (d) => (d.questions[1].danger_sign_id = "ds_ghost"), /danger_sign_id "ds_ghost"/],
    ["unknown node", (d) => (d.questions[1].node_id = "n_ghost"), /node_id "n_ghost"/],
    ["answer type against the variable", (d) => (d.questions[1].answer_type = "integer"), /use "yes_no"/],
    ["unknown action", (d) => d.outcomes[0].action_ids.push("act_ghost"), /action "act_ghost" is not in extraction/],
    ["node that is not an action", (d) => d.outcomes[0].action_ids.push("n_dec"), /is a decision node/],
    ["unknown follow-up", (d) => (d.outcomes[0].followup_id = "fu_ghost"), /followup_id "fu_ghost"/],
    ["unknown cite", (d) => (d.derived[0].cite = ["zzz"]), /cites "zzz"/],
    ["unknown outcome", (d) => (d.rules[0].outcome = "ghost"), /"ghost", which is not an outcome/],
    ["duplicate priority", (d) => (d.rules[1].priority = 10), /Two rules have priority 10/],
    ["two otherwise rules", (d) => d.rules.push({ priority: 30, when: "otherwise", outcome: "home" }, { priority: 40, when: "otherwise", outcome: "home" }), /2 "otherwise" rules/],
    ["duplicate id", (d) => (d.derived[0].id = "wheeze"), /"wheeze" is used twice/],
    ["unknown related id", (d) => d.open_questions.push({ text: "Why?", route_to: "clinician", related_ids: ["what"] }), /related id "what"/],
    ["no age question", (d) => d.questions.splice(0, 1), /variable_id "age_m"/],
  ];
  it.each(cases)("%s", (_name, mutate, re) => {
    expect(problems(draft(mutate)).join("\n")).toMatch(re);
  });

  it("reports every problem, not only the first", () => {
    const p = problems(draft((d) => {
      d.rules[0].when = { ref: "nope" };
      d.derived[0].definition = { threshold: 99 };
    }));
    expect(p.length).toBe(2);
  });
});

describe("doses", () => {
  it("parses age bands, doses and totals", () => {
    expect(parseDoseText("Age 2 months up to 12 months—1 tablet; Age 12 months up to 5 years—2 tablets")).toEqual([
      { age_months_min: 2, age_months_below: 12, dose: "1 tablet" },
      { age_months_min: 12, age_months_below: 60, dose: "2 tablets" },
    ]);
    expect(parseDoseText("Age 2 months up to 12 months—1 tablet (total 10 tabs)\nAge 12 months up to 5 years - 2 tablets (total 20 tabs)")).toEqual([
      { age_months_min: 2, age_months_below: 12, dose: "1 tablet", total: "10 tabs" },
      { age_months_min: 12, age_months_below: 60, dose: "2 tablets", total: "20 tabs" },
    ]);
  });
  it("fails as a whole when any part does not read", () => {
    expect(parseDoseText("Give one dose now, then twice daily for 5 days")).toBeUndefined();
    expect(parseDoseText("Age 2 months up to 12 months—1 tablet; then more")).toBeUndefined();
    expect(parseDoseText("Age 12 months up to 2 months—1 tablet")).toBeUndefined();
    expect(parseDoseText("")).toBeUndefined();
    expect(parseDoseText(null)).toBeUndefined();
  });
  it("puts a parsed dose table on the action", () => {
    const m = ok(draft());
    const a = m.outcomes.find((o) => o.id === "treat")!.actions[0]!;
    expect(a.dose_by_age).toEqual([
      { age_months_min: 1, age_months_below: 12, dose: "5 ml", total: "50 ml" },
      { age_months_min: 12, age_months_below: 36, dose: "10 ml", total: "100 ml" },
    ]);
    expect(a.origin).toBe("guideline");
    expect(a.source).toEqual([{ page: 4, quote: "Give syrup X twice daily" }]);
  });
  it("keeps an unreadable dose as text only and asks the clinician", () => {
    const m = ok(draft((d) => (d.outcomes[1].action_ids = ["act_drug_bad"])));
    const a = m.outcomes.find((o) => o.id === "treat")!.actions[0]!;
    expect(a.dose_by_age).toBeUndefined();
    // red team 2: the action shows the booklet quote only; the unread dose text goes to the clinician
    expect(a.text).toBe("Give syrup Y");
    const q = m.open_questions.find((x) => x.question.includes("Give a spoonful when needed"))!;
    expect(q).toMatchObject({ route_to: "clinician", affects: ["treat"] });
  });
});

describe("follow-ups and age bands", () => {
  it("reads scheduled and on-return follow-ups, and nothing else", () => {
    expect(parseFollowup("See the child again in 3 days.", null)).toEqual({ kind: "scheduled", due: 3 });
    expect(parseFollowup("FOLLOW UP child on return at least once a week", null)).toEqual({ kind: "on_return", due: null });
    expect(parseFollowup("Check later if worse.", null)).toBeUndefined();
  });
  it("a follow-up that does not read becomes null plus an open question", () => {
    const m = ok(draft((d) => (d.outcomes[1].followup_id = "fu_vague")));
    expect(m.outcomes.find((o) => o.id === "treat")!.follow_up).toBeNull();
    expect(m.open_questions.some((q) => q.question.includes("Check later if worse."))).toBe(true);
  });
  it("reads age bands in months and years", () => {
    expect(parseAgeBand("age 2 months up to 12 months")).toEqual({ min: 2, below: 12 });
    expect(parseAgeBand("2 months up to 5 years")).toEqual({ min: 2, below: 60 });
    expect(parseAgeBand("under five")).toBeUndefined();
  });
});

describe("what code adds", () => {
  it("always ends with exactly one catch-all rule, origin team, on the most urgent result when the draft gives none", () => {
    const m = ok(draft());
    const last = m.rules[m.rules.length - 1]!;
    expect(last).toMatchObject({ when: "otherwise", outcome: "refer", origin: "team" });
    expect(m.rules.filter((r) => r.when === "otherwise")).toHaveLength(1);
    expect(last.priority).toBe(Math.max(...m.rules.map((r) => r.priority)));
    expect(m.open_questions.some((q) => q.affects.includes(last.id) && q.route_to === "clinician" && /most urgent/.test(q.question))).toBe(true);
  });
  it("uses the draft's otherwise outcome for the catch-all, still origin team", () => {
    const m = ok(draft((d) => d.rules.push({ priority: 99, when: "otherwise", outcome: "home" })));
    const last = m.rules[m.rules.length - 1]!;
    expect(last).toMatchObject({ when: "otherwise", outcome: "home", origin: "team" });
    expect(m.rules.filter((r) => r.when === "otherwise")).toHaveLength(1);
  });
  it("adds the out-of-age-range rule first, origin team, with the most urgent severity, and lists it", () => {
    const m = ok(draft());
    expect(m.scope).toMatchObject({ age_months_min: 1, age_months_below: 36 });
    expect(m.rules[0]).toMatchObject({
      id: "R1",
      priority: 1,
      when: { any: [{ field: "age_months", op: "less_than", value: 1 }, { field: "age_months", op: "at_least", value: 36 }] },
      outcome: "refer_outside_age_range",
      origin: "team",
    });
    const o = m.outcomes.find((x) => x.id === "refer_outside_age_range")!;
    expect(o).toMatchObject({ origin: "team", severity: 1 });
    expect(o.actions.every((a) => a.origin === "guideline" && a.dose_by_age === undefined)).toBe(true);
    expect(m.open_questions.find((q) => q.affects.includes("R1"))?.route_to).toBe("clinician");
  });
  it("keeps draft rule order and renumbers priorities after the age rule", () => {
    const m = ok(draft());
    expect(m.rules.map((r) => [r.id, r.priority, r.outcome])).toEqual([
      ["R1", 1, "refer_outside_age_range"],
      ["R2", 2, "refer"],
      ["R3", 3, "treat"],
      ["R4", 4, "refer"],
    ]);
  });
  it("entry limits are team values and are an open question", () => {
    const m = ok(draft());
    for (const q of m.questions.filter((x) => x.answer_type === "integer")) expect(q.constraint?.origin).toBe("team");
    expect(m.questions.find((q) => q.id === "rate")!.unit).toBe("breaths_per_minute");
    const q = m.open_questions.find((x) => x.question.startsWith("The entry limits"))!;
    expect(q.affects.sort()).toEqual(["age_months", "days", "rate"]);
  });
  it("items without a guideline quote are origin team and listed for the clinician", () => {
    const m = ok(draft());
    expect(m.outcomes.find((o) => o.id === "home")).toMatchObject({ origin: "team" });
    expect(m.outcomes.find((o) => o.id === "home")!.actions[0]!.origin).toBe("team");
    expect(m.rules.find((r) => r.outcome === "treat")).toMatchObject({ origin: "team" });
    const q = m.open_questions.find((x) => x.question.includes("no supporting quote"))!;
    expect(q.route_to).toBe("clinician");
    expect(q.affects).toEqual(expect.arrayContaining(["home", "R3"]));
  });
  it("every unclear item becomes an open question, once", () => {
    const m = ok(draft());
    const u1 = m.open_questions.filter((q) => q.question.includes("Chart 7 is missing."));
    const u2 = m.open_questions.filter((q) => q.question.includes("When to recount is not said."));
    expect(u1).toHaveLength(1);
    expect(u2).toHaveLength(1);
    expect(u1[0]!.source).toEqual([{ page: 4, quote: "see chart 7" }]);
    expect(u1[0]!.affects).toEqual(["treat"]);
    expect(u2[0]!.affects).toEqual(["rate"]);

    const covered = ok(draft((d) => d.open_questions.push({ text: "Where is chart 7?", route_to: "program_officer", related_ids: ["u1"] })));
    expect(covered.open_questions.filter((q) => q.question.includes("Chart 7 is missing."))).toHaveLength(0);
    const own = covered.open_questions.find((q) => q.question === "Where is chart 7?")!;
    expect(own).toMatchObject({ id: "Q1", source: [{ page: 4, quote: "see chart 7" }] });
  });
  it("names danger signs and out-of-scope items left out, with a danger-sign question for the clinician", () => {
    const m = ok(draft());
    expect(m.scope.excluded.map((x) => x.item)).toEqual(["Spreading rash", "See the rash chart"]);
    const q = m.open_questions.find((x) => /danger signs/.test(x.question))!;
    expect(q.route_to).toBe("clinician");
    expect(q.question).toContain("Spreading rash");
  });
  it("meta comes from code; a missing file hash is flagged, never invented", () => {
    const m = ok(draft());
    expect(m.meta).toMatchObject({ pathway_id: "wheeze_test", version: 1, parent_version: null, created_by: "ai_draft", guideline: { file_sha256: SHA } });
    const noSha = ok(draft(), extraction(), { ...opts, guideline: { title: "T" } });
    expect(noSha.meta.guideline.file_sha256).toBe("0".repeat(64));
    expect(noSha.meta.guideline.publisher).toBe("Not recorded");
    expect(noSha.open_questions.some((q) => /fingerprint/.test(q.question))).toBe(true);
    expect(noSha.open_questions.some((q) => /publisher and edition/.test(q.question))).toBe(true);
  });
  it("copies sources from the extraction for questions (variable and danger sign)", () => {
    const m = ok(draft());
    expect(m.questions.find((q) => q.id === "wheeze")).toMatchObject({ origin: "guideline", source: [{ page: 2, quote: "Wheeze?" }, { page: 3, quote: "Wheeze" }] });
  });
});

describe("draft schema", () => {
  it("rejects numbers, operators and quotes in conditions", () => {
    const base = draft();
    for (const bad of [{ field: "rate", op: "at_least", value: 45 }, { ref: "rate", value: 3 }, { threshold: 1.5 }, { quote: "x" }]) {
      const d = structuredClone(base) as any;
      d.derived[0].definition = bad;
      expect(DraftSchema.safeParse(d).success).toBe(false);
    }
  });
  it("rejects extra keys on outcomes and questions without a link", () => {
    const d = structuredClone(draft()) as any;
    d.outcomes[0].follow_up = { due_in_days: 3 };
    expect(DraftSchema.safeParse(d).success).toBe(false);
    const e = structuredClone(draft()) as any;
    delete e.questions[1].variable_id;
    delete e.questions[1].danger_sign_id;
    expect(DraftSchema.safeParse(e).success).toBe(false);
  });
});

describe("normalizeUnit", () => {
  it("reads any unit that names months as months (real run 6a22034d wrote \"months/years\")", () => {
    for (const u of ["months", "Months", "month", "months/years", "age in months", "months (whole)"]) expect(normalizeUnit(u), u).toBe("months");
  });
  it("leaves other units alone", () => {
    expect(normalizeUnit("breaths per minute")).toBe("breaths_per_minute");
    expect(normalizeUnit("days")).toBe("days");
    expect(normalizeUnit("years")).toBe("years");
    expect(normalizeUnit("  ")).toBeUndefined();
    expect(normalizeUnit(null)).toBeUndefined();
  });
});

describe("resolveDraft accepts an age variable whose unit is months/years", () => {
  it("does not report a missing child age variable", () => {
    const ex = extraction((e) => { e.variables[0]!.unit = "months/years"; });
    const r = resolveDraft(draft(), ex, opts);
    expect(r.ok ? [] : r.problems.filter((p) => /no child age variable/.test(p))).toEqual([]);
  });
});

describe("the age variable", () => {
  it("is found by unit, or by an age label with an age range when the unit is empty (real run 1a3c8cff)", () => {
    expect(isAgeVariable({ id: "child_age", label: "Child age", unit: null, range_hint: "2 months up to 5 years" })).toBe(true);
    expect(isAgeVariable({ id: "v3", label: "Child age", unit: "months/years", range_hint: null })).toBe(true);
    expect(variableUnit({ id: "child_age", label: "Child age", unit: null, range_hint: "2 months up to 5 years" })).toBe("months");
  });
  it("is not confused with other variables", () => {
    expect(isAgeVariable({ id: "cough_days", label: "Cough duration", unit: "days", range_hint: null })).toBe(false);
    expect(isAgeVariable({ id: "message", label: "Message sent", unit: null, range_hint: "2 months up to 5 years" })).toBe(false);
    expect(isAgeVariable({ id: "child_age", label: "Child age", unit: null, range_hint: null })).toBe(false);
    expect(variableUnit({ id: "rate", label: "Breaths", unit: "breaths per minute", range_hint: null })).toBe("breaths_per_minute");
  });
  it("lets resolveDraft find an age variable with an empty unit", () => {
    const ex = extraction((e) => { e.variables[0]!.unit = null; });
    const r = resolveDraft(draft(), ex, opts);
    expect(r.ok ? [] : r.problems.filter((p) => /no child age variable/.test(p))).toEqual([]);
  });
});
