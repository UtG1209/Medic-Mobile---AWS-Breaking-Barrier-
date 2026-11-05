import { describe, expect, it } from "vitest";
import { allowedOps } from "../../src/guard/patchPaths.js";

const model = { open_questions: [{ route_to: "clinician" }, { route_to: "program_officer" }, { route_to: "program_officer" }] };
const answer = (i: number) => [
  { op: "replace", path: `/open_questions/${i}/status`, value: "resolved" },
  { op: "add", path: `/open_questions/${i}/resolution`, value: "The guideline pages do not state a publisher or edition." },
];

describe("allowedOps", () => {
  it("keeps valid answers and drops a stray /meta write instead of refusing the whole patch", () => {
    const ops = [{ op: "replace", path: "/meta/guideline/publisher", value: "WHO" }, ...answer(1), ...answer(2)];
    const r = allowedOps(["OPEN_QUESTION"], ops, model);
    expect(r.kept.map((o) => o.path)).toEqual(answer(1).concat(answer(2)).map((o) => o.path));
    expect(r.dropped).toEqual(["/meta/guideline/publisher"]);
  });

  it("never keeps an answer to a clinician question", () => {
    const r = allowedOps(["OPEN_QUESTION"], answer(0), model);
    expect(r.kept).toEqual([]);
  });

  it("keeps a question's status and resolution only as a pair", () => {
    const r = allowedOps(["OPEN_QUESTION"], [answer(1)[0]!, { op: "add", path: "/open_questions/1/resolution", value: 42 }], model);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toHaveLength(2);
  });

  it("keeps nothing without an open-question finding to target", () => {
    expect(allowedOps(["SOME_OTHER_CODE"], answer(1), model).kept).toEqual([]);
  });
});
