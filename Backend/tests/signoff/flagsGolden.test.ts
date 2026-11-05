import { describe, expect, it } from "vitest";
import { flagsDocumentOf } from "../../src/signoff/checks.js";
import { FlagsDocumentSchema } from "../../src/validation/flags.js";
import { goldenCasesCheck } from "../../src/validation/checks/goldenCases.js";
import { goldenCases, matchedCtx } from "../validation/helpers.js";

// The checked draft (v1.json) agrees with every case; the second draft names one result differently, so the cases
// that expect it cannot run on it.
const A = matchedCtx().model;
const B = matchedCtx((m) => Object.assign(m, JSON.parse(JSON.stringify(m).replaceAll('"refer_urgent"', '"refer_now"')))).model;
const cases = goldenCases();
const record = (): never =>
  ({ runId: "r1", n: 1, modelSha: "a".repeat(64), checksVersion: "x", inputsSha: "b".repeat(64), checkedAt: 0, findings: goldenCasesCheck({ model: A, goldenCases: cases }) }) as never;

describe("flags document: the confirmed cases on both drafts", () => {
  it("counts how many cases each draft gets right", () => {
    const doc = flagsDocumentOf(record(), { goldenCases: cases, crossCheck: { model: B } });
    expect(doc.golden).toBeDefined();
    expect(doc.golden!.cases).toBe(cases.length);
    expect(doc.golden!.first).toBe(cases.length);
    expect(doc.golden!.second).toBeLessThan(cases.length);
    expect(doc.golden!.second).toBeGreaterThan(-1);
    expect(FlagsDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it("gives the same count for both when the drafts are the same", () => {
    const doc = flagsDocumentOf(record(), { goldenCases: cases, crossCheck: { model: A } });
    expect(doc.golden).toEqual({ cases: cases.length, first: cases.length, second: cases.length });
  });

  it("leaves it out without a second draft, with an unreadable one, or without cases", () => {
    expect(flagsDocumentOf(record(), { goldenCases: cases }).golden).toBeUndefined();
    expect(flagsDocumentOf(record(), { goldenCases: cases, crossCheck: { invalid: ["bad"] } }).golden).toBeUndefined();
    expect(flagsDocumentOf(record(), { crossCheck: { model: B } }).golden).toBeUndefined();
    expect(flagsDocumentOf(record(), { goldenCases: [], crossCheck: { model: B } }).golden).toBeUndefined();
  });

  it("an older stored flags document without the field still reads", () => {
    const doc = flagsDocumentOf(record(), { goldenCases: cases });
    expect(FlagsDocumentSchema.safeParse(doc).success).toBe(true);
  });
});
