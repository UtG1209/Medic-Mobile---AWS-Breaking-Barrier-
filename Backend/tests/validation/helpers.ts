import { readFileSync } from "node:fs";
import path from "node:path";
import { parseModel, type Model } from "../../src/logic/schema.js";
import { loadSourceDocument } from "../../src/validation/finding.js";
import type { CheckContext, SourceDocument } from "../../src/validation/finding.js";
import { rawV1 } from "../logic/helpers.js";

const dir = import.meta.dirname;

/** The real extraction of the public WHO/UNICEF cough booklet (page and block text, no patient data). */
export function realDocumentRaw(): any {
  return JSON.parse(readFileSync(path.join(dir, "../../extraction/input_blocks.json"), "utf8"));
}

export function realDocument(): SourceDocument {
  return loadSourceDocument(realDocumentRaw());
}

export function syntheticDocument(): SourceDocument {
  return loadSourceDocument(JSON.parse(readFileSync(path.join(dir, "../fixtures/validation/synthetic.document.json"), "utf8")));
}

/** A parsed copy of v1.json (sources already normalised to arrays) that a test may change freely. */
export function v1Copy(mutate?: (m: any) => void): Model {
  const r = parseModel(rawV1());
  if (!r.ok) throw new Error("bad fixture: " + r.issues.join("; "));
  const m = structuredClone(r.value) as any;
  mutate?.(m);
  return m as Model;
}

/** v1 against the real document as it is: the file hash differs, so GUIDELINE_FILE_MISMATCH fires. */
export function realCtx(mutate?: (m: any) => void): CheckContext {
  return { model: v1Copy(mutate), document: realDocument() };
}

/** v1 with its guideline hash patched to the real document's, so only content findings remain. */
export function matchedCtx(mutate?: (m: any) => void): CheckContext {
  const doc = realDocument();
  return { model: v1Copy((m) => { m.meta.guideline.file_sha256 = doc.docSha256; mutate?.(m); }), document: doc };
}

export const codesOf = (fs: readonly { code: string }[]): string[] => fs.map((f) => f.code);

/** Words that must never appear in a message shown to a clinician or program officer. */
export const JARGON_RE = />=|<=|==|!=|=>|\bAST\b|\bgrid\b|\bjson\b|\bschema\b|\boperator|\bboolean\b|\binteger\b|\bsha\b|\bhash\b|\bchecksum\b|\bfield\b|\bregex\b|undefined|\[object|\bnull\b|\bNaN\b/i;

export const rawExtraction = (): any => JSON.parse(readFileSync(path.join(dir, "../../extraction/extraction_output.json"), "utf8"));
export const rawGoldenCases = (): any => JSON.parse(readFileSync(path.join(dir, "../fixtures/logic/golden-testcases.json"), "utf8"));
export const demoSettings = (): any => JSON.parse(readFileSync(path.join(dir, "../../compile-demo/settings.demo.json"), "utf8"));

import { loadExtraction, loadGoldenCases } from "../../src/validation/context.js";
export function realExtraction(mutate?: (e: any) => void) {
  const raw = rawExtraction();
  mutate?.(raw);
  return loadExtraction(raw);
}
export function goldenCases(mutate?: (g: any[]) => void) {
  const raw = rawGoldenCases();
  mutate?.(raw);
  return loadGoldenCases(raw);
}
