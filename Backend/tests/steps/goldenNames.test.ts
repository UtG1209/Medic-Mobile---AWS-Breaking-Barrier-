import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extraQuestions, goldenNamingHint, goldenQuestions, missingQuestions, namingRepairText } from "../../src/steps/goldenNames.js";
import { loadGoldenCases } from "../../src/validation/context.js";

const real = loadGoldenCases(JSON.parse(readFileSync(new URL("../../golden/golden-confirmed.json", import.meta.url), "utf8")));

describe("goldenNamingHint", () => {
  it("lists the question ids with their types and the result ids with their meaning (the real confirmed cases)", () => {
    const h = goldenNamingHint(real)!;
    for (const q of ["age_months: integer", "cough_days: integer", "breaths_per_minute: integer", "cough: yes_no", "chest_indrawing: yes_no", "convulsions: yes_no"]) expect(h, q).toContain("- " + q);
    for (const r of ["refer_urgent", "refer_urgent_with_antibiotic", "treat_fast_breathing_at_home"]) expect(h, r).toContain("- " + r);
    expect(h).toContain("amoxicillin");
  });

  it("does not say which child gets which result, nor the expected rule", () => {
    const h = goldenNamingHint(real)!;
    expect(h).not.toMatch(/GF\d\d/);
    expect(h).not.toMatch(/\bR[345]\b/);
    expect(h).not.toMatch(/\d+-month-old/);
    expect(h).not.toContain("56 breaths");
  });

  it("is undefined without cases", () => {
    expect(goldenNamingHint(undefined)).toBeUndefined();
    expect(goldenNamingHint([])).toBeUndefined();
  });
});

describe("goldenQuestions and missingQuestions", () => {
  it("lists the questions the real cases answer with their answer types", () => {
    const q = goldenQuestions(real);
    expect(q).toContainEqual({ id: "cough_days", answer_type: "integer" });
    expect(q).toContainEqual({ id: "chest_indrawing", answer_type: "yes_no" });
    expect(q).toHaveLength(9);
    expect(goldenQuestions(undefined)).toEqual([]);
  });
  it("is missing a question that is absent or has another answer type", () => {
    const req = goldenQuestions(real);
    const draft = req.map((r) => ({ id: r.id, answer_type: r.answer_type }));
    expect(missingQuestions(draft, req)).toEqual([]);
    expect(missingQuestions(draft.filter((d) => d.id !== "cough_days"), req).map((m) => m.id)).toEqual(["cough_days"]);
    expect(missingQuestions(draft.map((d) => (d.id === "cough_days" ? { ...d, answer_type: "yes_no" } : d)), req).map((m) => m.id)).toEqual(["cough_days"]);
  });
  it("names what is missing in the correction text and keeps the number-cut-off rule", () => {
    const t = namingRepairText([{ id: "cough_days", answer_type: "integer" }]);
    expect(t).toContain("- cough_days (integer)");
    expect(t).toContain("threshold on the number question");
  });
});

describe("extraQuestions and the correction text", () => {
  it("finds the questions of a draft that the cases do not answer", () => {
    const req = goldenQuestions(real);
    const draft = [...req.map((r) => ({ id: r.id })), { id: "fever_days" }];
    expect(extraQuestions(draft, req)).toEqual(["fever_days"]);
    expect(extraQuestions(req.map((r) => ({ id: r.id })), req)).toEqual([]);
  });
  it("asks for extras to be removed, and for both missing and extra when both apply", () => {
    const t = namingRepairText([], ["fever_days"]);
    expect(t).toContain("- fever_days");
    expect(t).toContain("Remove each of these questions");
    expect(t).not.toContain("by id and answer type");
    const both = namingRepairText([{ id: "cough_days", answer_type: "integer" }], ["cough_14_days"]);
    expect(both).toContain("- cough_days (integer)");
    expect(both).toContain("- cough_14_days");
  });
  it("tells the draft the form asks exactly the listed questions, and leaves a result's meaning but not who gets it", () => {
    const h = goldenNamingHint(real)!;
    expect(h).toContain("exactly the questions listed below");
    expect(h).toContain("no other question");
    expect(h).not.toMatch(/GF\d\d/);
  });
});
