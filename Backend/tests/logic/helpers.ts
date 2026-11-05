import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseModel, type Model } from "../../src/logic/schema.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixtures = join(dir, "..", "fixtures", "logic");

export function rawV1(): any {
  return JSON.parse(readFileSync(join(fixtures, "v1.json"), "utf8"));
}

export function rawGolden(): GoldenCase[] {
  return JSON.parse(readFileSync(join(fixtures, "golden-testcases.json"), "utf8")) as GoldenCase[];
}

export interface GoldenCase {
  id: string;
  description: string;
  answers: Record<string, number | boolean>;
  expected_outcome: string;
  expected_rule: string;
  note: string;
}

export function v1(): Model {
  const r = parseModel(rawV1());
  if (!r.ok) throw new Error(r.issues.join("\n"));
  return r.value;
}

/** Parse a mutated raw model and return the issues (empty array when it parsed). */
export function issuesOf(raw: unknown): string[] {
  const r = parseModel(raw);
  return r.ok ? [] : r.issues;
}
