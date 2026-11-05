import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadGoldenCasesFile, runChecks, withCheckInputs } from "../../src/validation/index.js";
import { demoSettings, matchedCtx, rawGoldenCases } from "./helpers.js";

const file = path.join(import.meta.dirname, "../fixtures/logic/golden-testcases.json");

describe("supplying test cases and form settings to the checks (red team 1, item 8)", () => {
  it("loads and validates a golden-case file", () => {
    const g = loadGoldenCasesFile(file);
    expect(g.length).toBe(32);
    expect(g.map((c) => c.id)).toContain("g16");
  });
  it("adds validated test cases and settings to a context, and the overlap and golden checks then run", () => {
    const ctx = withCheckInputs(matchedCtx(), { goldenCases: rawGoldenCases(), compileSettings: demoSettings() });
    expect(ctx.goldenCases).toHaveLength(32);
    expect(ctx.compileSettings).toBeDefined();
    const codes = runChecks(ctx).findings.map((f) => f.code);
    expect(codes).toContain("GOLDEN_COUNT");
    expect(codes).not.toContain("URGENT_OVERLAP_UNTESTED");
    expect(runChecks(matchedCtx()).findings.map((f) => f.code)).toContain("URGENT_OVERLAP_UNTESTED");
  });
  it("refuses bad test cases and leaves out what is not given", () => {
    expect(() => withCheckInputs(matchedCtx(), { goldenCases: [{ id: "x" }] })).toThrow();
    const ctx = withCheckInputs(matchedCtx(), {});
    expect("goldenCases" in ctx).toBe(false);
    expect("compileSettings" in ctx).toBe(false);
  });
});
