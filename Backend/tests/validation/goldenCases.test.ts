import { describe, expect, it } from "vitest";
import { goldenCasesCheck } from "../../src/validation/checks/goldenCases.js";
import { goldenCases, matchedCtx } from "./helpers.js";

const run = (mutate?: (g: any[]) => void, model?: (m: any) => void) => goldenCasesCheck({ ...matchedCtx(model), goldenCases: goldenCases(mutate) });
const codes = (mutate?: (g: any[]) => void, model?: (m: any) => void) => run(mutate, model).map((f) => f.code);

describe("goldenCases", () => {
  it("without cases nothing is reported", () => {
    expect(goldenCasesCheck(matchedCtx())).toEqual([]);
  });
  it("the golden cases all agree with v1.json; the count is reported and only the 20 not-yet-confirmed cases are listed, once", () => {
    const fs = run();
    expect(fs.filter((f) => f.code === "GOLDEN_MISMATCH" || f.code === "GOLDEN_INVALID")).toEqual([]);
    const count = fs.find((f) => f.code === "GOLDEN_COUNT")!;
    expect(count.severity).toBe("info");
    expect(count.params["total"]).toBe(32);
    expect(count.params["agree"]).toBe(32);
    expect(fs.filter((f) => f.code === "GOLDEN_PENDING_CLINICIAN")).toHaveLength(1);
    expect(fs.find((f) => f.code === "GOLDEN_PENDING_CLINICIAN")!.params["count"]).toBe(20);
  });
  it("outcomes no case leads to are warned about", () => {
    const fs = run().filter((f) => f.code === "OUTCOME_WITHOUT_GOLDEN_CASE");
    for (const f of fs) {
      expect(f.severity).toBe("warning");
      expect(f.decidedBy).toBe("clinician");
    }
    const withCase = new Set(goldenCases().map((c) => c.expected_outcome));
    const all = ["refer_urgent_outside_age_range", "refer_outside_age_range", "refer_urgent_with_antibiotic", "refer_urgent", "treat_fast_breathing_at_home", "cough_no_fast_breathing", "no_cough"];
    expect(fs.map((f) => f.subjects[0]!.id).sort()).toEqual(all.filter((o) => !withCase.has(o)).sort());
  });
  it("a case that expects another result blocks, with both results in words and the rule that fired", () => {
    const fs = run((g) => { g[0].expected_outcome = "refer_urgent"; });
    const f = fs.find((x) => x.code === "GOLDEN_MISMATCH")!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.audience).toEqual(["clinician", "program_officer"]);
    expect(f.subjects[0]!.id).toBe("golden:g01");
    expect(f.message).toContain("Danger sign: refer urgently");
    expect(f.message).toContain("Fast breathing (pneumonia): treat at home and follow up in 3 days");
    expect(f.message).toContain("R5");
    expect(f.message).toContain("6 months, 52 breaths");
  });
  it("a case that gets the right result through another rule also blocks, saying so", () => {
    const f = run((g) => { g[0].expected_rule = "R6"; }).find((x) => x.code === "GOLDEN_MISMATCH")!;
    expect(f.params["ruleOnly"]).toBe(true);
    expect(f.message).toContain("R5");
    expect(f.message).toContain("R6");
  });
  it("a case without an expected rule is judged on the result alone", () => {
    expect(codes((g) => { delete g[0].expected_rule; })).not.toContain("GOLDEN_MISMATCH");
  });
  it("a case whose answers cannot be used blocks as invalid", () => {
    for (const mut of [
      (g: any[]) => { g[0].answers.nonsense = 3; },
      (g: any[]) => { g[0].answers.breaths_per_minute = 5000; },
      (g: any[]) => { g[0].answers.cough = 4; },
      (g: any[]) => { delete g[0].answers.age_months; },
    ]) {
      const f = run(mut).find((x) => x.code === "GOLDEN_INVALID")!;
      expect(f, String(mut)).toBeDefined();
      expect(f.severity).toBe("blocking");
      expect(f.decidedBy).toBe("clinician");
      expect(f.message).toContain("g01");
    }
  });
  it("a case that names a result the draft does not have is invalid", () => {
    expect(codes((g) => { g[0].expected_outcome = "no_such_result"; })).toContain("GOLDEN_INVALID");
  });
  it("a note saying pending, awaiting or not yet confirmed marks the case as waiting for the clinician", () => {
    const fs = run((g) => { for (const c of g) c.note = "ok"; g[2]!.note = "Pending clinician review"; g[3]!.note = "awaiting Medic"; });
    const p = fs.find((f) => f.code === "GOLDEN_PENDING_CLINICIAN")!;
    expect(p.severity).toBe("info");
    expect(p.params["count"]).toBe(2);
    expect(p.message).toContain("g03");
    expect(p.message).toContain("g04");
    expect(codes((g) => { for (const c of g) c.note = "confirmed by Dr Test"; })).not.toContain("GOLDEN_PENDING_CLINICIAN");
  });
  it("an empty list of cases still reports the count and the outcomes without a case", () => {
    const fs = run((g) => { g.length = 0; });
    expect(fs.find((f) => f.code === "GOLDEN_COUNT")!.params["total"]).toBe(0);
    expect(fs.filter((f) => f.code === "OUTCOME_WITHOUT_GOLDEN_CASE")).toHaveLength(7);
  });
  it("is deterministic", () => {
    expect(run().map((f) => f.id)).toEqual(run().map((f) => f.id));
  });
});
