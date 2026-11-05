import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore, artifactKey } from "../../src/artifacts/artifactStore.js";
import { TransientUsageError, type Step, type StepContext } from "../../src/engine/step.js";
import { FakeModelClient } from "../../src/model/modelClient.js";
import { CrossArtifacts, crossCheckModelKey, withCrossDraft } from "../../src/steps/crossDraft.js";
import { createFillLogicStep } from "../../src/steps/fillLogic.js";
import { parseModelValidator } from "../../src/steps/logicModelValidator.js";
import { MemoryStore } from "../../src/store/memoryStore.js";
import { parseModel } from "../../src/logic/schema.js";

const backend = path.resolve(import.meta.dirname, "..", "..");
const extractionText = readFileSync(path.join(backend, "extraction", "extraction_output.json"), "utf8");
const draftText = readFileSync(path.join(backend, "tests", "fixtures", "fill", "draft-cough.json"), "utf8");
const promptPath = path.join(backend, "extraction", "fill_prompt.txt");
const SHA = "0d74150dc2e1d377522706560444e3ea86b6877600cefc375f18809239513793";
const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, modelId: "m" });

function setup(model = new FakeModelClient([])) {
  const artifacts = new MemoryArtifactStore();
  const store = new MemoryStore();
  const ctx: StepContext = { run: { runId: "r1", state: "checking", createdAt: 0, docSha256: SHA }, store, artifacts, model, now: () => Date.UTC(2026, 10, 5, 12) };
  return { ctx, artifacts, store };
}
const text = (a: MemoryArtifactStore, k: string) => a.get(k).then((b) => new TextDecoder().decode(b));
const checks: Step & { calls: number } = {
  name: "checks", runState: "checking", calls: 0,
  async run() { this.calls++; return { artifactRefs: { version: "1" } }; },
};
const stub = (name: string, fn: (ctx: StepContext) => Promise<void>, u = usage(1, 1)): Step => ({ name, runState: "extracting", run: async (ctx) => { await fn(ctx); return { artifactRefs: {}, usage: u }; } });

describe("CrossArtifacts", () => {
  it("moves extract/, fill_logic/ and versions/ under cross/ and leaves the rest alone", async () => {
    const inner = new MemoryArtifactStore();
    const c = new CrossArtifacts(inner, "r1");
    await c.put(artifactKey("r1", "extract", "extraction_output.json"), "x");
    await c.put(artifactKey("r1", "fill_logic", "raw_response.txt"), "y");
    await c.put(artifactKey("r1", "versions", "v1.json"), "z");
    await inner.put(artifactKey("r1", "ingest", "input_blocks.json"), "blocks");
    expect(await text(inner, "runs/r1/cross/extract/extraction_output.json")).toBe("x");
    expect(await text(inner, "runs/r1/cross/fill_logic/raw_response.txt")).toBe("y");
    expect(await text(inner, "runs/r1/cross/versions/v1.json")).toBe("z");
    expect(await inner.exists("runs/r1/extract/extraction_output.json")).toBe(false);
    expect(await text(inner, artifactKey("r1", "ingest", "input_blocks.json"))).toBe("blocks"); // not moved
    expect(await c.exists(artifactKey("r1", "extract", "extraction_output.json"))).toBe(true);
    expect(await (async () => (await c.get(artifactKey("r1", "ingest", "input_blocks.json"))).length)()).toBe(6);
  });
});

describe("withCrossDraft", () => {
  const keepName = (a: Step) => ({ name: a.name, runState: a.runState });

  it("keeps the wrapped step's name and run state, and runs the checks after the second draft", async () => {
    const w = withCrossDraft(checks, { extract: stub("e", async () => {}), fill: stub("f", async () => {}) });
    expect(keepName(w)).toEqual(keepName(checks));
  });

  it("makes the second draft in its own folder and stores it where the cross-check reads it", async () => {
    const { ctx, artifacts, store } = setup();
    const order: string[] = [];
    const extract = stub("extract", async (c) => { order.push("extract"); await c.artifacts.put(artifactKey("r1", "extract", "extraction_output.json"), "EX"); });
    const fill = stub("fill_logic", async (c) => {
      order.push("fill");
      expect(await text(artifacts, "runs/r1/cross/extract/extraction_output.json")).toBe("EX"); // fill sees the second extraction
      await c.store.addVersion({ runId: "r1", n: 1, parent: null, author: "ai", createdAt: 0, artifactKey: "k" }); // a throwaway store
      await c.artifacts.put(artifactKey("r1", "versions", "v1.json"), '{"second":"draft"}');
    }, usage(2, 3));
    const step: Step = { ...checks, run: async () => { order.push("checks"); return { artifactRefs: { version: "1" } }; } };
    const res = await withCrossDraft(step, { extract, fill }).run(ctx);
    expect(order).toEqual(["extract", "fill", "checks"]);
    expect(await text(artifacts, crossCheckModelKey("r1"))).toBe('{"second":"draft"}');
    expect(await store.listVersions("r1")).toEqual([]); // the real run got no second version
    expect(await artifacts.exists(artifactKey("r1", "extract", "extraction_output.json"))).toBe(false); // nor a second extraction
    expect(res.artifactRefs).toMatchObject({ version: "1", crossDraftStatus: "ok", crossDraft: crossCheckModelKey("r1") });
    expect(res.usage).toEqual(usage(3, 4)); // the second draft's cost lands in the step
  });

  it("does not make one when it is already there or supplied another way", async () => {
    const boom = stub("x", async () => { throw new Error("must not run"); });
    const a = setup();
    await a.artifacts.put(crossCheckModelKey("r1"), "{}");
    expect((await withCrossDraft(checks, { extract: boom, fill: boom }).run(a.ctx)).artifactRefs.crossDraftStatus).toBe("present");
    const b = setup();
    expect((await withCrossDraft(checks, { extract: boom, fill: boom, suppliedElsewhere: true }).run(b.ctx)).artifactRefs.crossDraftStatus).toBe("supplied");
  });

  it("never fails the step: a failed second draft is recorded, the checks still run, nothing is stored", async () => {
    const { ctx, artifacts } = setup();
    const before = checks.calls;
    const bad = stub("extract", async () => { throw new TransientUsageError("Extraction has 2 quote(s) not found", usage(10, 5)); });
    const res = await withCrossDraft(checks, { extract: bad, fill: stub("f", async () => {}), tries: 2 }).run(ctx);
    expect(checks.calls).toBe(before + 1);
    expect(res.artifactRefs).toMatchObject({ crossDraftStatus: "failed" });
    expect(res.artifactRefs.crossDraftError).toContain("quote");
    expect(await artifacts.exists(crossCheckModelKey("r1"))).toBe(false);
    expect(res.usage).toEqual(usage(20, 10)); // both failed tries are still paid for
  });

  it("tries a step again once: a slip on the first call does not lose the second draft", async () => {
    const { ctx, artifacts } = setup();
    let n = 0;
    const flaky = stub("extract", async (c) => {
      if (++n === 1) throw new TransientUsageError("slip", usage(4, 4));
      await c.artifacts.put(artifactKey("r1", "extract", "extraction_output.json"), "EX");
    });
    const fill = stub("fill_logic", async (c) => { await c.artifacts.put(artifactKey("r1", "versions", "v1.json"), "{}"); });
    const res = await withCrossDraft(checks, { extract: flaky, fill }).run(ctx);
    expect(n).toBe(2);
    expect(res.artifactRefs.crossDraftStatus).toBe("ok");
    expect(await artifacts.exists(crossCheckModelKey("r1"))).toBe(true);
  });

  it("reports a fill that left no logic model", async () => {
    const { ctx } = setup();
    const res = await withCrossDraft(checks, { extract: stub("e", async () => {}), fill: stub("f", async () => {}) }).run(ctx);
    expect(res.artifactRefs).toMatchObject({ crossDraftStatus: "failed", crossDraftError: "the second draft left no logic model" });
  });

  it("works with the real fill step: the second draft is a valid logic model and the real version is untouched", async () => {
    const model = new FakeModelClient([{ raw: draftText, usage: usage(1000, 400) }]);
    const { ctx, artifacts, store } = setup(model);
    await artifacts.put(artifactKey("r1", "ingest", "input_blocks.json"), JSON.stringify({ source_id: "guideline", doc_name: "Cough_Guideline.pdf", doc_sha256: SHA, pages: [] }));
    const extract = stub("extract", async (c) => { await c.artifacts.put(artifactKey("r1", "extract", "extraction_output.json"), extractionText); });
    const fill = createFillLogicStep({ validator: parseModelValidator, modelId: "us.test.model-v1:0", promptPath, pathwayId: "cough_fast_breathing" });
    const res = await withCrossDraft(checks, { extract, fill }).run(ctx);
    expect(res.artifactRefs.crossDraftStatus).toBe("ok");
    expect(parseModel(JSON.parse(await text(artifacts, crossCheckModelKey("r1")))).ok).toBe(true);
    expect(await store.listVersions("r1")).toEqual([]);
    expect(await artifacts.exists(artifactKey("r1", "versions", "v1.json"))).toBe(false);
    expect(await artifacts.exists("runs/r1/cross/fill_logic/raw_response.txt")).toBe(true);
  });
});
