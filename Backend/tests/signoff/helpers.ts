import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MemoryArtifactStore, artifactKey } from "../../src/artifacts/artifactStore.js";
import type { RunState } from "../../src/contract/schemas.js";
import { DraftSchema } from "../../src/logic/fill/draftSchema.js";
import { resolveDraft } from "../../src/logic/fill/resolve.js";
import { modelSha, parseModel, type Model } from "../../src/logic/index.js";
import type { CheckInputs } from "../../src/signoff/checks.js";
import { Signoff } from "../../src/signoff/signoff.js";
import { loadGoldenCases, type GoldenCase } from "../../src/validation/context.js";
import { demoSettings } from "../compiler/helpers.js";
import { ExtractionOutput } from "../../src/steps/extractionSchema.js";
import { MemoryStore } from "../../src/store/memoryStore.js";
import { resolveForDemo } from "../helpers/resolveForDemo.js";

export const backend = path.resolve(import.meta.dirname, "..", "..");
export const extractionText = readFileSync(path.join(backend, "extraction", "extraction_output.json"), "utf8");
export const blocksText = readFileSync(path.join(backend, "extraction", "input_blocks.json"), "utf8");
export const DOC_SHA = (JSON.parse(blocksText) as { doc_sha256: string }).doc_sha256;

/** The real draft (tests/fixtures/fill/draft-cough.json) resolved against the real extraction: what fill_logic stores as version 1. */
export function draftV1(): Model {
  const draft = DraftSchema.parse(JSON.parse(readFileSync(path.join(backend, "tests", "fixtures", "fill", "draft-cough.json"), "utf8")));
  const r = resolveDraft(draft, ExtractionOutput.parse(JSON.parse(extractionText)), {
    pathwayId: "cough_fast_breathing",
    createdAt: "2026-11-04T10:00:00.000Z",
    guideline: { title: "Caring for the sick child in the community: Chart booklet", fileSha256: DOC_SHA },
  });
  if (!r.ok) throw new Error(r.problems.join("\n"));
  const p = parseModel(r.model);
  if (!p.ok) throw new Error(p.issues.join("\n"));
  return p.value;
}

/** v2: the officer's demo fixes on v1 (officer blockers cleared, 5 clinician questions still open). */
export const officerFixed = (): Model => resolveForDemo(draftV1(), "program_officer");
/** v3: the clinician's demo answers on top of v2: no blocking finding left. */
export const fullyResolved = (): Model => resolveForDemo(officerFixed(), "clinician");

export const shaOf = (m: Model): string => modelSha(m);

/**
 * The golden cases (tests/fixtures/logic/golden-testcases.json: GF01 to GF12 Medic confirmed, g01 to g20 awaiting Medic). Their outcome ids
 * match the ones the fill step writes. TEST-ONLY, not clinical decisions.
 */
export function testGoldenCases(): GoldenCase[] {
  const g = loadGoldenCases(JSON.parse(readFileSync(path.join(backend, "tests", "fixtures", "logic", "golden-testcases.json"), "utf8")));
  return g;
}

/** The check inputs the tests use unless they say otherwise: the demo form settings and testGoldenCases. */
export const testInputs = (): CheckInputs => ({ compileSettings: demoSettings(), goldenCases: testGoldenCases() });

/** The role a demo edit was made in (resolveForDemo sets created_by), as the save request would say. */
export const roleOf = (m: Model): "program_officer" | "clinician" | undefined =>
  m.meta.created_by === "demo-program_officer" ? "program_officer" : m.meta.created_by === "demo-clinician" ? "clinician" : undefined;

export const bytesSha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * A run in `state` with the given versions (1..n) and the ingest and extract artifacts the checks read.
 * Each version row records the sha256 of its stored bytes and the role of a demo edit, as the API does.
 */
export async function seed(state: RunState, models: Model[], opts: { inputs?: CheckInputs } = {}) {
  const store = new MemoryStore();
  const artifacts = new MemoryArtifactStore();
  const clock = { ms: 1_000 };
  await store.createRun({ runId: "r1", state, createdAt: 0, docSha256: DOC_SHA });
  await artifacts.put(artifactKey("r1", "ingest", "input_blocks.json"), blocksText);
  await artifacts.put(artifactKey("r1", "extract", "extraction_output.json"), extractionText);
  for (const [i, m] of models.entries()) {
    const n = i + 1;
    const key = artifactKey("r1", "versions", `v${n}.json`);
    const text = JSON.stringify(m);
    await artifacts.put(key, text);
    const role = roleOf(m);
    await store.addVersion({
      runId: "r1",
      n,
      parent: n === 1 ? null : n - 1,
      author: n === 1 ? "ai" : "person",
      createdAt: n,
      artifactKey: key,
      bodySha256: bytesSha(text),
      ...(role !== undefined ? { authorRole: role } : {}),
    });
  }
  const inputs = opts.inputs ?? testInputs();
  const signoff = new Signoff({ store, artifacts, now: () => clock.ms++, inputs: async () => inputs });
  return { store, artifacts, clock, signoff, inputs };
}

/** How many questions of m are still open for this role (the fixture changes as the fill step evolves). */
export const openFor = (m: Model, role: "program_officer" | "clinician"): number => m.open_questions.filter((q) => q.status === "open" && q.route_to === role).length;
