import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore, artifactKey } from "../../src/artifacts/artifactStore.js";
import { runStep } from "../../src/engine/runner.js";
import type { StepContext } from "../../src/engine/step.js";
import { TransientError } from "../../src/engine/step.js";
import { FakeModelClient, ModelOutputError } from "../../src/model/modelClient.js";
import { QUOTE_TRIES, checkQuotes, createExtractStep, findBadQuotes } from "../../src/steps/extract.js";
import { ExtractionOutput } from "../../src/steps/extractionSchema.js";
import { MemoryStore } from "../../src/store/memoryStore.js";

const extractionDir = path.resolve(import.meta.dirname, "../../extraction");
const realOutput = JSON.parse(readFileSync(path.join(extractionDir, "extraction_output.json"), "utf8"));
delete realOutput._run;
const realInput = JSON.parse(readFileSync(path.join(extractionDir, "input_blocks.json"), "utf8"));
const realBlocks = new Map<string, string>(
  realInput.pages.flatMap((p: { blocks: { block_id: string; text: string }[] }) =>
    p.blocks.map((b) => [b.block_id, b.text] as const),
  ),
);
const promptPath = path.join(extractionDir, "final_prompt.txt");

const PNG = new Uint8Array([1, 2, 3]);
const tinyDoc = {
  source_id: "g",
  doc_name: "g.pdf",
  doc_sha256: "x",
  page_count: 2,
  pages: [
    { pdf_page: 3, width: 1, height: 1, image: "pages/page-03.png", blocks: [{ block_id: "p3.b1", pdf_page: 3, bbox: [0, 0, 1, 1], text: "Cough for 14 days" }] },
    { pdf_page: 5, width: 1, height: 1, image: "pages/page-05.png", blocks: [{ block_id: "p5.b1", pdf_page: 5, bbox: [0, 0, 1, 1], text: "Fast breathing" }] },
  ],
};

function emptyOutput() {
  return { nodes: [], edges: [], variables: [], danger_signs: [], thresholds: [], actions: [], followups: [], unclear_items: [] };
}

async function setup(model: FakeModelClient) {
  const artifacts = new MemoryArtifactStore();
  await artifacts.put(artifactKey("r1", "ingest", "input_blocks.json"), JSON.stringify(tinyDoc));
  await artifacts.put(artifactKey("r1", "ingest", "pages", "page-03.png"), PNG);
  await artifacts.put(artifactKey("r1", "ingest", "pages", "page-05.png"), PNG);
  const ctx: StepContext = {
    run: { runId: "r1", state: "extracting", createdAt: 0 },
    store: new MemoryStore(),
    artifacts,
    model,
    now: () => 0,
  };
  return { ctx, artifacts };
}

const usage = { inputTokens: 10, outputTokens: 5, modelId: "m1" };
const text = (a: MemoryArtifactStore, k: string) => a.get(k).then((b) => new TextDecoder().decode(b));

describe("ExtractionOutput schema", () => {
  it("accepts the real sample output (minus _run)", () => {
    const r = ExtractionOutput.safeParse(realOutput);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues.slice(0, 5))).toBe(true);
  });

  it("rejects a missing required field", () => {
    const bad = { ...emptyOutput(), nodes: [{ id: "n1" }] };
    expect(ExtractionOutput.safeParse(bad).success).toBe(false);
  });

  it("allows unknown extra fields on items", () => {
    const o = structuredClone(realOutput);
    o.nodes[0].extra = "x";
    expect(ExtractionOutput.safeParse(o).success).toBe(true);
  });
});

describe("findBadQuotes", () => {
  it("reports zero for the real sample", () => {
    expect(findBadQuotes(realOutput, realBlocks)).toEqual([]);
  });

  it("reports a tampered quote", () => {
    const o = structuredClone(realOutput);
    o.nodes[0].src[0].quote = "not in the block";
    const bad = findBadQuotes(o, realBlocks);
    expect(bad).toEqual([{ block_id: o.nodes[0].src[0].block_id, quote: "not in the block" }]);
  });

  it.each([["empty", ""], ["whitespace", "  \n\t "]])("reports an %s quote even for a real block", (_n, quote) => {
    const o = structuredClone(realOutput);
    o.nodes[0].src[0].quote = quote;
    expect(findBadQuotes(o, realBlocks)).toEqual([{ block_id: o.nodes[0].src[0].block_id, quote }]);
  });

  it("reports an unknown block id", () => {
    const o = structuredClone(realOutput);
    o.nodes[0].src[0].block_id = "p99.b99";
    expect(findBadQuotes(o, realBlocks).map((b) => b.block_id)).toContain("p99.b99");
  });
});

describe("extract step", () => {
  it("has name and runState", () => {
    const s = createExtractStep({ modelId: "m1", promptPath });
    expect(s.name).toBe("extract");
    expect(s.runState).toBe("extracting");
  });

  it("builds the request, stores raw and output, returns refs and usage", async () => {
    const raw = JSON.stringify(emptyOutput());
    const model = new FakeModelClient([{ raw, usage }]);
    const { ctx, artifacts } = await setup(model);
    const res = await createExtractStep({ modelId: "m1", promptPath }).run(ctx);
    expect(res.usage).toEqual(usage);
    expect(res.artifactRefs).toEqual({
      output: "runs/r1/extract/extraction_output.json",
      raw: "runs/r1/extract/raw_response.txt",
    });
    expect(await text(artifacts, res.artifactRefs.raw!)).toBe(raw);
    expect(JSON.parse(await text(artifacts, res.artifactRefs.output!))).toEqual(emptyOutput());

    const req = model.calls[0]!;
    expect(req.modelId).toBe("m1");
    expect(req.maxTokens).toBe(32000);
    expect(req.system).toBe(readFileSync(promptPath, "utf8"));
    const c = req.content;
    expect(c).toHaveLength(1 + 3 * 2 + 1);
    expect(c[0]).toEqual({ type: "text", text: "Run: r1\nSource: g   Pages: 2\nMode: new_guideline\nFor each page, in order:" });
    expect(c[1]).toEqual({ type: "text", text: "--- pdf_page 3 ---" });
    expect(c[2]).toEqual({ type: "image", format: "png", bytes: PNG });
    expect(c[3]).toEqual({ type: "text", text: "Blocks: " + JSON.stringify(tinyDoc.pages[0]!.blocks) });
    expect(c[4]).toEqual({ type: "text", text: "--- pdf_page 5 ---" });
    expect(c[7]).toEqual({ type: "text", text: "Return one JSON object for the whole document." });
  });

  it("honors maxTokens option", async () => {
    const model = new FakeModelClient([{ raw: JSON.stringify(emptyOutput()) }]);
    const { ctx } = await setup(model);
    await createExtractStep({ modelId: "m1", promptPath, maxTokens: 123 }).run(ctx);
    expect(model.calls[0]!.maxTokens).toBe(123);
  });

  it("fails non-transient on bad quotes, keeps raw, does not store output", async () => {
    const o = emptyOutput() as Record<string, unknown[]>;
    o.unclear_items = Array.from({ length: 12 }, (_, i) => ({
      id: `u${i}`, block_id: "p3.b1", quote: "x".repeat(200), what_is_unclear: "w", related_ids: [],
    }));
    const raw = JSON.stringify(o);
    const model = new FakeModelClient([{ raw, usage }, { raw, usage }]);
    const { ctx, artifacts } = await setup(model);
    const err = await createExtractStep({ modelId: "m1", promptPath }).run(ctx).catch((e) => e);
    expect(err).not.toBeInstanceOf(TransientError);
    expect(model.calls).toHaveLength(QUOTE_TRIES);
    // Both paid calls are recorded.
    expect(err.usage).toEqual({ ...usage, inputTokens: usage.inputTokens * 2, outputTokens: usage.outputTokens * 2 });
    expect(err.message).toContain("12");
    expect(err.message.match(/p3\.b1: /g)).toHaveLength(10);
    expect(err.message).toContain("x".repeat(80));
    expect(err.message).not.toContain("x".repeat(81));
    expect(await text(artifacts, artifactKey("r1", "extract", "raw_response.txt"))).toBe(raw);
    expect(await artifacts.exists(artifactKey("r1", "extract", "extraction_output.json"))).toBe(false);
  });

  it("calls the model again when quotes are not found, and keeps the second answer when it is right", async () => {
    const o = emptyOutput() as Record<string, unknown[]>;
    o.unclear_items = [{ id: "u0", block_id: "p3.b1", quote: "not in the booklet", what_is_unclear: "w", related_ids: [] }];
    const good = JSON.stringify(emptyOutput());
    const model = new FakeModelClient([{ raw: JSON.stringify(o), usage }, { raw: good, usage }]);
    const { ctx, artifacts } = await setup(model);
    const res = await createExtractStep({ modelId: "m1", promptPath }).run(ctx);
    expect(model.calls).toHaveLength(2);
    expect(res.usage).toEqual({ ...usage, inputTokens: usage.inputTokens * 2, outputTokens: usage.outputTokens * 2 });
    expect(await text(artifacts, artifactKey("r1", "extract", "raw_response.txt"))).toBe(good);
    expect(await artifacts.exists(artifactKey("r1", "extract", "extraction_output.json"))).toBe(true);
  });

  it("makes one model call when every quote is found", async () => {
    const model = new FakeModelClient([{ raw: JSON.stringify(emptyOutput()), usage }]);
    const { ctx } = await setup(model);
    const res = await createExtractStep({ modelId: "m1", promptPath }).run(ctx);
    expect(model.calls).toHaveLength(1);
    expect(res.usage).toEqual(usage);
  });

  it("propagates ModelOutputError for invalid JSON", async () => {
    const model = new FakeModelClient([{ raw: "not json" }]);
    const { ctx } = await setup(model);
    await expect(createExtractStep({ modelId: "m1", promptPath }).run(ctx)).rejects.toBeInstanceOf(ModelOutputError);
  });

  it("keeps the full raw text of an invalid response in raw_response.txt", async () => {
    const raw = "not json " + "w".repeat(5000);
    const model = new FakeModelClient([{ raw }]);
    const { ctx, artifacts } = await setup(model);
    const err = await createExtractStep({ modelId: "m1", promptPath }).run(ctx).catch((e) => e);
    expect(err.message.length).toBeLessThan(300);
    expect(await text(artifacts, artifactKey("r1", "extract", "raw_response.txt"))).toBe(raw);
  });

  it("records the usage of a call whose output is invalid JSON on the failed step record", async () => {
    const model = new FakeModelClient([{ raw: "not json", usage }]);
    const { ctx } = await setup(model);
    const prices = { m1: { inPerMTok: 1_000_000, outPerMTok: 2_000_000 } };
    const rec = await runStep(createExtractStep({ modelId: "m1", promptPath }), ctx, {
      maxAttempts: 3,
      backoffMs: () => 0,
      sleep: async () => {},
      prices,
    });
    expect(rec).toMatchObject({ status: "failed", attempt: 1, inputTokens: 10, outputTokens: 5, modelId: "m1", costUsd: 20 });
  });

  it("fails non-transient on a zero-page document without calling the model", async () => {
    const model = new FakeModelClient([{ raw: JSON.stringify(emptyOutput()) }]);
    const { ctx, artifacts } = await setup(model);
    await artifacts.put(
      artifactKey("r1", "ingest", "input_blocks.json"),
      JSON.stringify({ ...tinyDoc, page_count: 0, pages: [] }),
    );
    const err = await createExtractStep({ modelId: "m1", promptPath }).run(ctx).catch((e) => e);
    expect(err.name).toBe("Error");
    expect(err.message).toMatch(/No pages to extract/);
    expect(model.calls).toHaveLength(0);
  });
});

describe("checkQuotes repairs only unambiguous slips, and records them", () => {
  // Shapes seen on the 2014 HIV-adapted booklet (Nov 2026 run): blocks keep the PDF's leading spaces and curly quotes.
  const blocks = new Map([
    ["p5.b5", " Chest indrawing?"],
    ["p5.b7", " If cough, count breaths in 1 minute: ___ breaths per\nminute (bpm)."],
    ["p5.b8", " Unusually sleepy or unconscious?"],
    ["p9.b17", " Advise the caregiver to\ngive more fluids and\ncontinue feeding."],
    ["p9.b18", " Give oral antibiotic (amoxycillin tablet\u2014250 mg )."],
    ["p12.b3", "Check vaccines received (see child\u2019s health card)"],
    ["p6.b1", "Fever"],
    ["p6.b2", "Fever"],
  ]);
  const out = (block_id: string, quote: string) => ({ nodes: [{ id: "n1", src: [{ block_id, pdf_page: 1, quote }] }] });

  it("typography: a straight apostrophe for the booklet's curly one becomes the booklet's exact text", () => {
    const o = out("p12.b3", "Check vaccines received (see child's health card)");
    const r = checkQuotes(o, blocks, { apply: true });
    expect(r.bad).toEqual([]);
    expect(r.fixes).toEqual([{ kind: "typography", from: { block_id: "p12.b3", quote: "Check vaccines received (see child's health card)" }, to: { block_id: "p12.b3", quote: "Check vaccines received (see child\u2019s health card)" } }]);
    expect(o.nodes[0]!.src[0]!.quote).toBe("Check vaccines received (see child\u2019s health card)");
  });

  it("block: a quote found in exactly one other block of the same page moves to that block", () => {
    const o = { nodes: [{ src: [{ block_id: "p5.b7", quote: " Chest indrawing?" }] }, { src: [{ block_id: "p9.b17", quote: " Give oral antibiotic (amoxycillin tablet\u2014250 mg )." }] }] };
    const r = checkQuotes(o, blocks, { apply: true });
    expect(r.bad).toEqual([]);
    expect(r.fixes.map((f) => [f.kind, f.from.block_id, f.to.block_id])).toEqual([["block", "p5.b7", "p5.b5"], ["block", "p9.b17", "p9.b18"]]);
    expect(o.nodes.map((n) => n.src[0]!.block_id)).toEqual(["p5.b5", "p9.b18"]);
  });

  it("without apply, nothing in the output changes", () => {
    const o = out("p5.b7", " Chest indrawing?");
    expect(checkQuotes(o, blocks).fixes).toHaveLength(1);
    expect(o.nodes[0]!.src[0]!.block_id).toBe("p5.b7");
  });

  it("still fails: a quote on another page, in two blocks of the page, in no block, or empty", () => {
    for (const [id, q] of [["p9.b17", " Chest indrawing?"], ["p6.b9", "Fever"], ["p5.b7", "Fast breathing"], ["p5.b5", " "], ["p99.b1", "Chest"]] as const) {
      const r = checkQuotes(out(id, q), blocks, { apply: true });
      expect(r.bad, `${id} ${q}`).toEqual([{ block_id: id, quote: q }]);
      expect(r.fixes).toEqual([]);
    }
  });

  it("other words are never repaired: only curly quotes are folded", () => {
    expect(checkQuotes(out("p12.b3", "Check vaccine received (see child's health card)"), blocks).bad).toHaveLength(1);
    expect(checkQuotes(out("p9.b18", "Give oral antibiotic (amoxycillin tablet-250 mg )."), blocks).bad).toHaveLength(1);
  });

  describe("spacing: the PDF's split lines and letter spacing (AWS run, Nov 5 2026)", () => {
    const pdf = new Map([
      ["p7.b1", " I F ANY DANGER SIGN , R EFER C HILD URGENTLY TO H EALTH F ACILITY"],
      ["p9.b32", " Advise on when to return.\nGo to nearest health facility\nor, if not possible, return\nimmediately if child\n Cannot drink or feed\n Becomes sicker\n Has blood in stool\n Advise caregiver on use of a\nbednet (ITN)"],
      ["p9.b33", " Follow up child in 3 days."],
    ]);

    it("letter spacing: the model's spacing becomes the booklet's", () => {
      const o = out("p7.b1", "I F ANY DANGER SIGN, R EFER CHILD URGENTLY TO HEALTH FACILITY");
      const r = checkQuotes(o, pdf, { apply: true });
      expect(r.bad).toEqual([]);
      expect(r.fixes.map((f) => f.kind)).toEqual(["spacing"]);
      expect(o.nodes[0]!.src[0]!.quote).toBe("I F ANY DANGER SIGN , R EFER C HILD URGENTLY TO H EALTH F ACILITY");
    });

    it("a split line and an added full stop: the quote becomes the booklet's text, without the stop", () => {
      const o = out("p9.b32", "Advise caregiver on use of a bednet (ITN).");
      const r = checkQuotes(o, pdf, { apply: true });
      expect(r.bad).toEqual([]);
      expect(r.fixes.map((f) => f.kind)).toEqual(["spacing"]);
      expect(o.nodes[0]!.src[0]!.quote).toBe("Advise caregiver on use of a\nbednet (ITN)");
    });

    it("a spacing slip in another block of the page also moves the quote there", () => {
      const o = out("p9.b33", "Advise caregiver on use of a bednet (ITN)");
      const r = checkQuotes(o, pdf, { apply: true });
      expect(r.bad).toEqual([]);
      expect(o.nodes[0]!.src[0]).toMatchObject({ block_id: "p9.b32", quote: "Advise caregiver on use of a\nbednet (ITN)" });
    });

    it("still fails: changed words, letters or other punctuation", () => {
      for (const [id, q] of [
        ["p9.b32", "Advise caregiver on use of a bed net (LLIN)."],
        ["p9.b32", "Advise the caregiver on use of a bednet (ITN)"],
        ["p7.b1", "IF ANY DANGER SIGN, REFER CHILD URGENTLY TO A HEALTH FACILITY"],
        ["p7.b1", "IF ANY DANGER SIGN; REFER CHILD"],
        ["p9.b33", "Follow up child in 5 days."],
      ] as const) {
        expect(checkQuotes(out(id, q), pdf).bad, `${id} ${q}`).toHaveLength(1);
      }
    });
  });

  it("findBadQuotes still reports every quote not exactly in its cited block", () => {
    expect(findBadQuotes(out("p5.b7", " Chest indrawing?"), blocks)).toEqual([{ block_id: "p5.b7", quote: " Chest indrawing?" }]);
  });
});
