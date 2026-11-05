import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { goldenNamingHint } from "../../src/steps/goldenNames.js";
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
