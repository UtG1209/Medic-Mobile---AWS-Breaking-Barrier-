import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Version } from "../../src/domain/types.js";
import { Conflict, type Store } from "../../src/store/store.js";
import { MemoryArtifactStore, artifactKey } from "../../src/artifacts/artifactStore.js";
import { TransientError, TransientUsageError, UsageError, type StepContext } from "../../src/engine/step.js";
import { createFillLogicStep } from "../../src/steps/fillLogic.js";
import { acceptAnyObjectValidator, parseModelValidator } from "../../src/steps/logicModelValidator.js";
import { MemoryStore } from "../../src/store/memoryStore.js";
import { FakeModelClient, type FakeResponse } from "../../src/model/modelClient.js";
import { DraftSchema } from "../../src/logic/fill/draftSchema.js";
import { parseModel } from "../../src/logic/schema.js";
import { rawV1 } from "../logic/helpers.js";

const backend = path.resolve(import.meta.dirname, "..", "..");
const extractionText = readFileSync(path.join(backend, "extraction", "extraction_output.json"), "utf8");
const draftText = readFileSync(path.join(backend, "tests", "fixtures", "fill", "draft-cough.json"), "utf8");
const promptPath = path.join(backend, "extraction", "fill_prompt.txt");
const SHA = "0d74150dc2e1d377522706560444e3ea86b6877600cefc375f18809239513793";

const outKey = artifactKey("r1", "extract", "extraction_output.json");
const v1Key = artifactKey("r1", "versions", "v1.json");
const draftKey = artifactKey("r1", "fill_logic", "draft.json");
const rawKey = artifactKey("r1", "fill_logic", "raw_response.txt");
const repairKey = artifactKey("r1", "fill_logic", "raw_repair.txt");
const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, modelId: "us.test.model-v1:0" });
const good: FakeResponse = { raw: draftText, usage: usage(1000, 400) };
const badDraft = (): string => {
  const d = JSON.parse(draftText);
  d.rules[0].when = { ref: "no_such_item" };
  d.outcomes[0].action_ids.push("act_ghost");
  return JSON.stringify(d);
};

const mkStep = (validator = parseModelValidator) =>
  createFillLogicStep({ validator, modelId: "us.test.model-v1:0", promptPath, pathwayId: "cough_fast_breathing" });
const step = mkStep();

async function setup(responses: (FakeResponse | Error)[] = [good], withExtraction = true) {
  const artifacts = new MemoryArtifactStore();
  if (withExtraction) await artifacts.put(outKey, extractionText);
  const store = new MemoryStore();
  const model = new FakeModelClient(responses);
  const ctx: StepContext = {
    run: { runId: "r1", state: "filling_logic", createdAt: 0, docSha256: SHA },
    store,
    artifacts,
    model,
    now: () => Date.UTC(2026, 10, 4, 12),
  };
  return { ctx, store, artifacts, model };
}
const text = (a: MemoryArtifactStore, k: string) => a.get(k).then((b) => new TextDecoder().decode(b));

describe("fill_logic step", () => {
  it("has the expected name and state", () => {
    expect(step.name).toBe("fill_logic");
    expect(step.runState).toBe("filling_logic");
  });

  it("drafts with the model, resolves and stores exactly one version 1 that parses", async () => {
    const { ctx, store, artifacts, model } = await setup();
    const res = await step.run(ctx);
    const versions = await store.listVersions("r1");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ n: 1, parent: null, author: "ai", artifactKey: v1Key });
    expect(res.artifactRefs).toEqual({ version: v1Key, draft: draftKey });
    expect(res.usage).toEqual(usage(1000, 400));

    const body = JSON.parse(await text(artifacts, v1Key));
    const parsed = parseModel(body);
    expect(parsed.ok).toBe(true);
    expect(body.meta).toMatchObject({
      pathway_id: "cough_fast_breathing",
      version: 1,
      parent_version: null,
      created_by: "ai_draft",
      created_at: "2026-11-04T12:00:00.000Z",
      guideline: { file_sha256: SHA },
    });
    expect(JSON.parse(await text(artifacts, draftKey))).toEqual(JSON.parse(draftText));
    expect(await text(artifacts, rawKey)).toBe(draftText);

    // One model call, through the ModelClient, with the prompt file and the draft schema.
    expect(model.calls).toHaveLength(1);
    const call = model.calls[0]!;
    expect(call.modelId).toBe("us.test.model-v1:0");
    expect(call.system).toBe(readFileSync(promptPath, "utf8"));
    expect(call.schema).toBe(DraftSchema);
    const sent = call.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(sent).toContain('"index":2');
    expect(sent).toContain("n_dec_danger");
  });

  it("is idempotent: a second run makes no model call and adds no version", async () => {
    const { ctx, store, model } = await setup([good]);
    await step.run(ctx);
    const res = await step.run(ctx);
    expect(await store.listVersions("r1")).toHaveLength(1);
    expect(res.artifactRefs).toEqual({ version: v1Key });
    expect(res.usage).toBeUndefined();
    expect(model.calls).toHaveLength(1);
  });

  it("succeeds without touching a pre-existing version 1 and without a model call", async () => {
    const { ctx, store, artifacts, model } = await setup([]);
    await artifacts.put(v1Key, "user edited");
    await store.addVersion({ runId: "r1", n: 1, parent: null, author: "ai", createdAt: 1, artifactKey: v1Key });
    await store.addVersion({ runId: "r1", n: 2, parent: 1, author: "user", createdAt: 2, artifactKey: "k2" });
    const res = await step.run(ctx);
    expect(await store.listVersions("r1")).toHaveLength(2);
    expect(await text(artifacts, v1Key)).toBe("user edited");
    expect(res.artifactRefs).toEqual({ version: v1Key });
    expect(model.calls).toHaveLength(0);
  });

  it("two concurrent executions end with one version and both succeed", async () => {
    const { ctx, store } = await setup([good, good]);
    const [a, b] = await Promise.all([step.run(ctx), step.run(ctx)]);
    expect(await store.listVersions("r1")).toHaveLength(1);
    expect(a.artifactRefs.version).toBe(v1Key);
    expect(b.artifactRefs.version).toBe(v1Key);
  });

  it("repairs a draft with problems once, sending the problems back, and sums the usage", async () => {
    const { ctx, store, artifacts, model } = await setup([{ raw: badDraft(), usage: usage(1000, 400) }, { raw: draftText, usage: usage(1500, 420) }]);
    const res = await step.run(ctx);
    expect(model.calls).toHaveLength(2);
    expect(res.usage).toEqual(usage(2500, 820));
    expect(await store.listVersions("r1")).toHaveLength(1);
    const repairText = model.calls[1]!.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(repairText).toContain('"no_such_item" is not a question or derived item');
    expect(repairText).toContain('action "act_ghost" is not in extraction');
    expect(repairText).toContain("Your previous answer was:");
    expect(await text(artifacts, rawKey)).toBe(badDraft());
    expect(await text(artifacts, repairKey)).toBe(draftText);
  });

  it("repairs an answer that is not valid JSON or does not fit the draft schema", async () => {
    for (const raw of ["not json at all", JSON.stringify({ questions: [] })]) {
      const { ctx, model } = await setup([{ raw, usage: usage(10, 5) }, good]);
      const res = await step.run(ctx);
      expect(model.calls).toHaveLength(2);
      expect(res.usage).toEqual(usage(1010, 405));
    }
  });

  it("fails clearly (as a retryable error) after one failed repair, records the usage of both calls and writes no version", async () => {
    const { ctx, store, artifacts, model } = await setup([{ raw: badDraft(), usage: usage(1000, 400) }, { raw: badDraft(), usage: usage(1100, 410) }, good]);
    const err = await step.run(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toMatch(/still has 2 problem\(s\) after one repair/);
    expect((err as TransientUsageError).usage).toEqual(usage(2100, 810));
    expect(model.calls).toHaveLength(2);
    expect(await store.listVersions("r1")).toHaveLength(0);
    expect(await artifacts.exists(v1Key)).toBe(false);
  });

  it("does not retry a failure that comes from the extraction (no age variable): UsageError, not transient", async () => {
    const ex = JSON.parse(extractionText);
    for (const v of ex.variables) if (/age/i.test(`${v.id} ${v.label}`) || /month/i.test(String(v.unit))) Object.assign(v, { id: "other_" + v.id, label: "Other", unit: null, range_hint: null });
    const { ctx, artifacts, model } = await setup([good, good]);
    await artifacts.put(outKey, JSON.stringify(ex));
    const err = await step.run(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err).not.toBeInstanceOf(TransientError);
    expect((err as Error).message).toMatch(/after one repair/);
    expect(model.calls.length).toBeGreaterThan(0);
  });

  it("adds the naming hint to the prompt content; a failing hint never fails the step", async () => {
    const hinted = createFillLogicStep({ validator: parseModelValidator, modelId: "us.test.model-v1:0", promptPath, pathwayId: "cough_fast_breathing", namingHint: async () => "NAMES: age_months, refer_urgent" });
    const a = await setup();
    await hinted.run(a.ctx);
    const texts = (a.model.calls[0]!.content as { type: string; text?: string }[]).map((c) => c.text ?? "");
    expect(texts.some((t) => t.includes("NAMES: age_months, refer_urgent"))).toBe(true);
    expect(texts[texts.length - 1]).toBe("Return one JSON object: the draft.");

    const failing = createFillLogicStep({ validator: parseModelValidator, modelId: "us.test.model-v1:0", promptPath, pathwayId: "cough_fast_breathing", namingHint: async () => { throw new Error("no golden file"); } });
    const b = await setup();
    await expect(failing.run(b.ctx)).resolves.toBeDefined();
    const plain = (b.model.calls[0]!.content as { type: string; text?: string }[]).map((c) => c.text ?? "");
    expect(plain.some((t) => t.includes("NAMES"))).toBe(false);
  });

  describe("the confirmed test cases' questions", () => {
    // The cases answer exactly the questions of the fixture draft.
    const required = (JSON.parse(draftText).questions as { id: string; answer_type: "yes_no" | "integer" }[]).map((q) => ({ id: q.id, answer_type: q.answer_type }));
    const renamed = draftText.replaceAll('"cough_days"', '"cough_duration"'); // the same draft, one question under another id
    // The same draft with one question added that no case answers (a danger sign of the booklet that the cases leave out).
    const withExtra = (() => {
      const d = JSON.parse(draftText);
      d.questions.push({ id: "fever_7_days", label: "Fever for 7 days or more?", answer_type: "yes_no", danger_sign_id: "ds_fever_7d" });
      return JSON.stringify(d);
    })();
    const stepWith = (req: (runId: string) => Promise<typeof required | undefined>) =>
      createFillLogicStep({ validator: parseModelValidator, modelId: "us.test.model-v1:0", promptPath, pathwayId: "cough_fast_breathing", requiredQuestions: req });
    const qIds = async (a: MemoryArtifactStore) => (JSON.parse(await text(a, v1Key)).questions as { id: string }[]).map((q) => q.id);
    const asked = (m: { calls: { content: unknown }[] }, i: number) => (m.calls[i]!.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");

    it("makes no extra call when the draft asks exactly the questions of the cases", async () => {
      const { ctx, model } = await setup([good]);
      await stepWith(async () => required).run(ctx);
      expect(model.calls).toHaveLength(1);
    });

    it("asks once for what is missing and keeps the corrected draft when it is better", async () => {
      const { ctx, artifacts, model } = await setup([{ raw: renamed, usage: usage(1000, 400) }, { raw: draftText, usage: usage(1500, 420) }]);
      const res = await stepWith(async () => required).run(ctx);
      expect(model.calls).toHaveLength(2);
      expect(asked(model, 1)).toContain("- cough_days (integer)");
      expect(asked(model, 1)).toContain("- cough_duration"); // the one it asked that the cases do not answer
      expect(asked(model, 1)).not.toContain("- age_months");
      expect(await qIds(artifacts)).toContain("cough_days");
      expect(await text(artifacts, artifactKey("r1", "fill_logic", "raw_naming.txt"))).toBe(draftText);
      expect(res.usage).toEqual(usage(2500, 820)); // both calls are paid for
    });

    it("asks for a question the cases do not answer to be taken out, and keeps the draft without it", async () => {
      const { ctx, artifacts, model } = await setup([{ raw: withExtra, usage: usage(1000, 400) }, { raw: draftText, usage: usage(1200, 380) }]);
      await stepWith(async () => required).run(ctx);
      expect(model.calls).toHaveLength(2);
      expect(asked(model, 1)).toContain("- fever_7_days");
      expect(asked(model, 1)).toContain("Remove each of these questions");
      expect(asked(model, 1)).not.toContain("confirmed test cases answer these questions by id"); // nothing is missing
      expect(await qIds(artifacts)).not.toContain("fever_7_days");
    });

    it("keeps the first draft when the correction is no better, or does not resolve", async () => {
      for (const second of [renamed, "not json"]) {
        const { ctx, artifacts, model } = await setup([{ raw: renamed, usage: usage(1000, 400) }, { raw: second, usage: usage(10, 5) }]);
        await expect(stepWith(async () => required).run(ctx)).resolves.toBeDefined();
        expect(model.calls).toHaveLength(2);
        const ids = await qIds(artifacts);
        expect(ids).toContain("cough_duration");
        expect(ids).not.toContain("cough_days");
      }
    });

    it("keeps the first draft when the correction call itself fails", async () => {
      const { ctx, artifacts } = await setup([{ raw: renamed, usage: usage(1000, 400) }, new TransientError("throttled")]);
      await expect(stepWith(async () => required).run(ctx)).resolves.toBeDefined();
      expect(await qIds(artifacts)).toContain("cough_duration");
    });

    it("never fails because the list of questions cannot be read, and does nothing for an empty list", async () => {
      const a = await setup([{ raw: renamed, usage: usage(1000, 400) }]);
      await expect(stepWith(async () => { throw new Error("no golden file"); }).run(a.ctx)).resolves.toBeDefined();
      expect(a.model.calls).toHaveLength(1);
      const b = await setup([good]);
      await stepWith(async () => []).run(b.ctx);
      expect(b.model.calls).toHaveLength(1);
    });
  });

  it("does not repair a transient model error: it is rethrown for the runner to retry", async () => {
    const { ctx, model } = await setup([new TransientError("throttled")]);
    await expect(step.run(ctx)).rejects.toBeInstanceOf(TransientError);
    expect(model.calls).toHaveLength(1);
  });

  it("fails when the validator rejects, writing no version and keeping the usage", async () => {
    const { ctx, store, artifacts } = await setup();
    const bad = mkStep({ validate: () => ({ ok: false, issues: ["a", "b"] }) });
    const err = await bad.run(ctx).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/a; b/);
    expect((err as UsageError).usage).toEqual(usage(1000, 400));
    expect(await store.listVersions("r1")).toHaveLength(0);
    expect(await artifacts.exists(v1Key)).toBe(false);
  });

  it("takes the file hash from the ingest record when the run has none, and flags it when neither has it", async () => {
    const { ctx, artifacts } = await setup();
    await artifacts.put(artifactKey("r1", "ingest", "input_blocks.json"), JSON.stringify({ source_id: "Cough_Guideline", doc_name: "Cough_Guideline.pdf", doc_sha256: "b".repeat(64), pages: [] }));
    const run = { ...ctx.run };
    delete run.docSha256;
    await createFillLogicStep({ validator: parseModelValidator, modelId: "m", promptPath }).run({ ...ctx, run });
    const body = JSON.parse(await text(artifacts, v1Key));
    expect(body.meta.guideline).toMatchObject({ title: "Cough_Guideline.pdf", file_sha256: "b".repeat(64) });
    expect(body.meta.pathway_id).toBe("cough_guideline");

    const s2 = await setup();
    const run2 = { ...s2.ctx.run };
    delete run2.docSha256;
    await step.run({ ...s2.ctx, run: run2 });
    const body2 = JSON.parse(await text(s2.artifacts, v1Key));
    expect(body2.meta.guideline.file_sha256).toBe("0".repeat(64));
    expect(body2.open_questions.some((q: { question: string }) => /fingerprint/.test(q.question))).toBe(true);
  });

  it("fails clearly when the extraction artifact is missing", async () => {
    const { ctx } = await setup([], false);
    await expect(step.run(ctx)).rejects.toThrow(/Extraction output not found/);
  });

  it("fails clearly when the extraction artifact is not JSON", async () => {
    const { ctx, artifacts } = await setup([], false);
    await artifacts.put(outKey, "not json");
    await expect(step.run(ctx)).rejects.toThrow(/not valid JSON/);
  });

  it("fails clearly when the extraction does not match its schema, before any model call", async () => {
    const { ctx, artifacts, model } = await setup([good], false);
    await artifacts.put(outKey, JSON.stringify({ nodes: [] }));
    await expect(step.run(ctx)).rejects.toThrow(/does not match the extraction schema/);
    expect(model.calls).toHaveLength(0);
  });
});

function wrapStore(store: MemoryStore, over: Partial<Store>): Store {
  return new Proxy(store as Store, {
    get(t, prop, r) {
      if (prop in over) return (over as Record<string | symbol, unknown>)[prop];
      const v = Reflect.get(t, prop, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

describe("fill_logic races and edge cases", () => {
  it("on Conflict with a winner present, returns the winner key and adds no version", async () => {
    const { ctx, store } = await setup();
    const winnerKey = "winner/v1.json";
    const wrapped = wrapStore(store, {
      async addVersion() {
        await store.addVersion({ runId: "r1", n: 1, parent: null, author: "ai", createdAt: 1, artifactKey: winnerKey });
        throw new Conflict("chain");
      },
    });
    const res = await step.run({ ...ctx, store: wrapped });
    expect(res.artifactRefs).toEqual({ version: winnerKey });
    expect(await store.listVersions("r1")).toHaveLength(1);
  });

  it("rethrows Conflict when version 1 still does not exist", async () => {
    const { ctx, store } = await setup();
    const wrapped = wrapStore(store, {
      async addVersion() {
        throw new Conflict("chain");
      },
    });
    await expect(step.run({ ...ctx, store: wrapped })).rejects.toBeInstanceOf(Conflict);
  });

  it("fails clearly when versions exist but version 1 is missing", async () => {
    const { ctx, store } = await setup();
    const v2: Version = { runId: "r1", n: 2, parent: 1, author: "user", createdAt: 2, artifactKey: "k2" };
    const wrapped = wrapStore(store, { listVersions: async () => [v2] });
    await expect(step.run({ ...ctx, store: wrapped })).rejects.toThrow(/version 1 is missing/);
  });

  it("re-checks before the version artifact put and skips it when version 1 appeared", async () => {
    const { ctx, store, artifacts } = await setup();
    const winnerKey = "winner/v1.json";
    const winner: Version = { runId: "r1", n: 1, parent: null, author: "ai", createdAt: 1, artifactKey: winnerKey };
    let calls = 0;
    const wrapped = wrapStore(store, { listVersions: async () => (++calls === 1 ? [] : [winner]) });
    const puts: string[] = [];
    const spy = {
      put: (k: string, b: Uint8Array | string, c?: string) => (puts.push(k), artifacts.put(k, b, c)),
      get: (k: string) => artifacts.get(k),
      exists: (k: string) => artifacts.exists(k),
      size: (k: string) => artifacts.size(k),
    };
    const res = await step.run({ ...ctx, store: wrapped, artifacts: spy });
    // Only the raw model answer is kept; no version object and no draft are written.
    expect(puts).toEqual([rawKey]);
    expect(res.artifactRefs).toEqual({ version: winnerKey });
    expect(res.usage).toEqual(usage(1000, 400));
  });
});

describe("logic model validators", () => {
  it("parseModelValidator accepts the reference model and rejects anything else with issues", () => {
    expect(parseModelValidator.validate(rawV1())).toEqual({ ok: true });
    for (const v of [{}, null, [], "s", { placeholder: true }]) {
      const r = parseModelValidator.validate(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
    }
  });
  it("acceptAnyObjectValidator accepts plain objects and rejects others", () => {
    expect(acceptAnyObjectValidator.validate({})).toEqual({ ok: true });
    for (const v of [null, [], "s", 3, undefined]) {
      const r = acceptAnyObjectValidator.validate(v);
      expect(r.ok).toBe(false);
    }
  });
});
