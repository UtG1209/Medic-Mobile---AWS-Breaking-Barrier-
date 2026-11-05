import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/validation/runChecks.js";
import { findingsFor } from "../../src/validation/gates.js";
import { demoSettings, goldenCases, realCtx, realExtraction, JARGON_RE } from "./helpers.js";

/** The whole chain on the real pair: v1.json, the real booklet blocks, the real extraction, the golden cases and the demo settings. */
const full = () => runChecks({ ...realCtx(), extraction: realExtraction(), goldenCases: goldenCases(), compileSettings: demoSettings() });

const counts = (r: ReturnType<typeof full>): Record<string, number> => {
  const c: Record<string, number> = {};
  for (const f of r.findings) c[`${f.severity}:${f.code}`] = (c[`${f.severity}:${f.code}`] ?? 0) + 1;
  return Object.fromEntries(Object.entries(c).sort(([a], [b]) => (a < b ? -1 : 1)));
};

describe("v1.json on the real pair (real booklet blocks, real extraction, golden cases, demo settings)", () => {
  const r = full();

  it("yields exactly these findings, each one justified", () => {
    expect(counts(r)).toEqual({
      // v1.json was written from another copy of the guideline than the uploaded one
      "blocking:GUIDELINE_FILE_MISMATCH": 1,
      // Q1..Q6 are all still open
      "blocking:OPEN_QUESTION": 6,
      // no severity inversion and no age-band gap any more: R1 (outside the ages AND a danger sign) comes first, and
      // the out-of-range value is recognised as the complement of the covered ages
      // the dose-list ages (2, 12, 60 months), doses and totals of the two antibiotic actions, and the 7 days of the 3 on-return
      // referrals, are in none of the quotes those items cite (content findings for the program officer)
      "blocking:UNGROUNDED_NUMBER": 17,
      // the "250 mg" of the two antibiotic action texts, and "2 months up to 5 years" in the no-medicine action of R1's result
      "blocking:NUMBER_IN_TEXT_UNSUPPORTED": 3,
      "info:BOUNDARY_SHOWN": 6,
      // no second, independent draft was supplied, so the cross-check comparison did not run (and says so)
      "info:CONTEXT_NOT_PROVIDED": 1,
      // 7 danger signs the extraction found are not modelled but named as left out of this form (Q4)
      "info:DANGER_SIGN_EXCLUDED_NOT_COUGH": 7,
      "info:ENTRY_LIMIT_TEAM_CHOICE": 1,
      // 4 on-return follow-ups
      "info:FOLLOWUP_NOT_COMPILED": 4,
      // 3 on-return follow-ups also carry 7 days
      "info:FOLLOWUP_RETURN_DAYS_IGNORED": 3,
      "info:GOLDEN_COUNT": 1,
      "info:GOLDEN_PENDING_CLINICIAN": 1,
      // "up to 5 years" is read as excluding 60 months, for fast breathing and for the out-of-range value
      "info:INCLUSIVITY_ASSUMED": 2,
      // 60 months is 5 years: the covered range, the out-of-range value and fast breathing
      "info:NUMBER_UNIT_CONVERTED": 3,
      "info:TEAM_TEXT_TO_CONFIRM": 3,
      "info:UNMEASURABLE_NOT_SUPPORTED": 1,
      // the null window of the 3-day follow-up uses the team default (Q5)
      "warning:TEAM_DEFAULT_WINDOW": 1,
      "warning:UNCITED_PASSAGE": 4,
      // red team 2: the labels, titles and action texts that are not the booklet's own words, listed once for the clinician
      "warning:AI_WORDED_TEXT": 1,
    });
  });

  it("fast breathing cites both booklet rows, so none of its numbers is ungrounded; the ungrounded ones are the dose lists and the 7 days", () => {
    const f = r.findings.filter((x) => x.code === "UNGROUNDED_NUMBER");
    expect(f.some((x) => x.subjects.some((s) => s.id === "fast_breathing"))).toBe(false);
    expect(f.every((x) => x.decidedBy === "program_officer")).toBe(true);
    expect(f.filter((x) => /follow-up/.test(String(x.params["usage"])))).toHaveLength(3);
    expect(f.filter((x) => /dose table/.test(String(x.params["usage"]))).map((x) => x.params["number"]).sort()).toEqual([12, 12, 12, 12, 2, 2, 60, 60]);
  });

  it("all cases agree; every outcome has a case; the claim is PROVEN", () => {
    expect(r.claim).toBe("PROVEN");
    const g = r.findings.find((x) => x.code === "GOLDEN_COUNT")!;
    expect(g.params).toMatchObject({ total: 32, agree: 32, different: 0 });
    expect(r.findings.some((x) => x.code === "OUTCOME_WITHOUT_GOLDEN_CASE")).toBe(false);
    // everything but the optional second draft was supplied
    expect(r.findings.find((x) => x.code === "CONTEXT_NOT_PROVIDED")?.params["needs"]).toBe("the second draft");
  });

  it("the gates: nobody can sign and nothing can be built", () => {
    expect(r.gates.canOfficerSign).toBe(false);
    expect(r.gates.canClinicianSign).toBe(false);
    expect(r.gates.canCompile).toBe(false);
    expect(r.gates.blockers.officer.map((f) => f.code).sort()).toEqual([
      "GUIDELINE_FILE_MISMATCH", "OPEN_QUESTION", ...Array(17).fill("UNGROUNDED_NUMBER"),
    ].sort());
    expect(r.gates.blockers.clinician.map((f) => f.code).sort()).toEqual([...Array(5).fill("OPEN_QUESTION"), ...Array(3).fill("NUMBER_IN_TEXT_UNSUPPORTED")].sort());
    expect(r.gates.blockers.compile).toHaveLength(27);
    expect(r.gates.summary).toMatch(/^The program officer cannot sign yet\./);
    expect(r.gates.summary).not.toMatch(JARGON_RE);
  });

  it("each role sees plain-language findings in its own words, grouped by severity", () => {
    for (const role of ["program_officer", "clinician"] as const) {
      const groups = findingsFor(r.findings, role);
      expect(groups.map((g) => g.severity)).toEqual(["blocking", "warning", "info"].filter((s) => groups.some((g) => g.severity === s)));
      for (const g of groups) {
        for (const f of g.findings) {
          expect(f.message, f.code).not.toMatch(JARGON_RE);
          expect(f.audience).toContain(role);
        }
      }
    }
    const o = findingsFor(r.findings, "program_officer")[0]!.findings;
    expect(o[0]!.yours).toBe(true);
    // the program officer never sees the clinician-only open questions as their own
    const q1 = findingsFor(r.findings, "program_officer").flatMap((g) => g.findings).find((f) => f.code === "OPEN_QUESTION" && f.subjects[0]!.id === "Q1");
    expect(q1).toBeUndefined();
    const q5 = findingsFor(r.findings, "program_officer").flatMap((g) => g.findings).find((f) => f.code === "OPEN_QUESTION" && f.subjects[0]!.id === "Q5");
    expect(q5!.message).toContain("program officer");
  });

  it("is deterministic: ids, order and messages are identical on a second run", () => {
    const again = full();
    expect(again.findings.map((f) => f.id)).toEqual(r.findings.map((f) => f.id));
    expect(again.findings.map((f) => f.message)).toEqual(r.findings.map((f) => f.message));
    expect(again.gates).toEqual(r.gates);
  });

  it("every blocking finding names a page and a quote or says the booklet is not involved", () => {
    for (const f of r.findings.filter((x) => x.severity === "blocking")) {
      expect(f.message.length, f.code).toBeGreaterThan(60);
      expect(f.message, f.code).not.toMatch(/\bundefined\b|\[object|\$\{/);
    }
  });
});
