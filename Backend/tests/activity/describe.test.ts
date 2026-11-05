import { describe, expect, it } from "vitest";
import { describeAudit } from "../../src/activity/describe.js";
import type { AuditEvent } from "../../src/store/store.js";

const ev: AuditEvent[] = [
  { at: 1, type: "run_state", detail: { from: null, to: "created" } },
  { at: 2, type: "step_started", detail: { step: "ingest", attempt: 1 } },
  { at: 3, type: "step_succeeded", detail: { step: "ingest", attempt: 1 } },
  { at: 4, type: "signature", detail: { n: 2, role: "program_officer" } },
  { at: 5, type: "officer_agent_escalated", detail: { reason: "unclear cut-off" } },
  { at: 6, type: "signature", detail: { n: 2, role: "clinician" } },
  { at: 7, type: "version_locked", detail: { n: 2 } },
  { at: 8, type: "mystery_event", detail: null },
];

describe("describeAudit", () => {
  it("keeps order, maps actors, writes plain words", () => {
    const f = describeAudit(ev, "locked");
    expect(f.items.map((i) => i.at)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(f.items.map((i) => i.actor)).toEqual(["pipeline", "pipeline", "pipeline", "officer_agent", "officer_agent", "clinician", "pipeline", "pipeline"]);
    expect(f.items[1]!.text).toBe("Started reading the guideline.");
    expect(f.items[4]!.text).toContain("unclear cut-off");
    expect(f.runState).toBe("locked");
  });
  it("shows why the officer agent escalated (it writes `why`), and hides the refused-paths detail", () => {
    const f = describeAudit([
      { at: 1, type: "officer_agent_escalated", detail: { n: 1, why: "2 fix attempts used", remaining: ["OPEN_QUESTION"] } },
      { at: 2, type: "officer_agent_refused_paths", detail: { n: 1, paths: "/rules/0/when" } },
    ], "awaiting_officer");
    expect(f.items[0]!.text).toContain("2 fix attempts used");
    expect(f.items[1]!.kind).toBe("agent_note");
    expect(f.items[1]!.text).not.toContain("/rules/0/when");
  });
  it("a refused agent attempt is a note, never 'fixed ... and saved' (seen on a real AWS run)", () => {
    const f = describeAudit([
      { at: 1, type: "officer_agent_fix", detail: { n: 1, attempt: 1, refused: "patch touches paths the agent may not change" } },
      { at: 2, type: "officer_agent_fix", detail: { n: 1, attempt: 2, newVersion: 2 } },
    ], "awaiting_officer");
    expect(f.items[0]!.kind).toBe("agent_note");
    expect(f.items[0]!.text).toBe("The review agent's proposed fix to version 1 was not applied: patch touches paths the agent may not change.");
    expect(f.items[1]!.kind).toBe("agent_fix");
  });
  it("cursor and after", () => {
    const first = describeAudit(ev.slice(0, 3), "ingesting");
    expect(first.cursor).toBe(3);
    const next = describeAudit(ev, "locked", { after: first.cursor });
    expect(next.items.map((i) => i.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(next.cursor).toBe(8);
    expect(describeAudit(ev, "locked", { after: 8 }).items).toEqual([]);
    expect(describeAudit(ev, "locked", { after: -5 }).items).toHaveLength(8);
  });
});
