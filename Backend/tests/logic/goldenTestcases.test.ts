import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/logic/interpreter.js";
import { goldenCasesCheck } from "../../src/validation/checks/goldenCases.js";
import { loadGoldenCases } from "../../src/validation/context.js";
import { rawGolden, v1 } from "./helpers.js";

// golden-testcases.json = the 20 proposed cases g01 to g20 (awaiting Medic) followed by the 12
// Medic-confirmed cases GF01 to GF12 from golden-cases-final-12-annotated.xlsx.
const cases = loadGoldenCases(rawGolden());
const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);
const confirmed = cases.filter((c) => c.id.startsWith("GF"));

describe("golden-testcases.json (merged golden cases)", () => {
  it("holds g01 to g20 followed by GF01 to GF12, with unique ids", () => {
    expect(cases.map((c) => c.id)).toEqual([...ids("g", 20), ...ids("GF", 12)]);
  });

  it("keeps g01 to g20 marked as not yet confirmed by Medic", () => {
    for (const c of cases.filter((c) => c.id.startsWith("g"))) expect(c.note).toMatch(/pending|awaiting|not (?:yet )?(?:clinically )?confirmed/i);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s gets its expected outcome through its expected rule", (_id, c) => {
    const r = evaluate(v1(), c.answers);
    expect(r.outcome).toBe(c.expected_outcome);
    expect(r.rule).toBe(c.expected_rule);
  });

  it("marks GF01 to GF12 as Medic confirmed, not pending", () => {
    for (const c of confirmed) {
      expect(c.note).toMatch(/^Medic confirmed/);
      expect(c.note).not.toMatch(/pending|awaiting|not (?:yet )?(?:clinically )?confirmed/i);
    }
  });

  it("passes the golden case check: every case agrees and every outcome is covered", () => {
    const findings = goldenCasesCheck({ model: v1(), goldenCases: cases } as Parameters<typeof goldenCasesCheck>[0]);
    expect(findings.filter((f) => f.severity === "blocking")).toEqual([]);
    expect(findings.map((f) => f.code)).not.toContain("OUTCOME_WITHOUT_GOLDEN_CASE");
    const count = findings.find((f) => f.code === "GOLDEN_COUNT");
    expect(count?.params).toMatchObject({ total: cases.length, agree: cases.length, different: 0 });
  });
});
