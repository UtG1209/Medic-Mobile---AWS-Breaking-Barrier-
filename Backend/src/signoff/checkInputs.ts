import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NotFound, artifactKey, type ArtifactStore } from "../artifacts/artifactStore.js";
import { FLOW_MODES, type CompileSettings } from "../compiler/types.js";
import { loadCrossCheck, loadGoldenCases, type GoldenCase } from "../validation/context.js";
import type { CrossCheckInput } from "../validation/finding.js";

/**
 * The inputs of the checks besides the model and the booklet (DEC-020): the golden cases (children whose
 * result the clinician knows) and the compile settings (form title, icon, team default task window,
 * contact types, flow mode). Both change what the checks find, so both are part of the findings key, and
 * the settings are part of every signature (settingsSha): a release build must use the signed settings.
 *
 * Where they come from, first match wins:
 * 1. the run's own artifacts runs/<id>/inputs/golden_cases.json and runs/<id>/inputs/compile_settings.json;
 * 2. the files named by GOLDEN_CASES_PATH and COMPILE_SETTINGS_PATH ("none" switches one off);
 * 3. defaults in this repository (below). A default file that is missing (for example in the Lambda
 *    image) means "not supplied", and the findings say plainly which checks did not run. A path that
 *    was configured explicitly and is missing, or any malformed input, is an error, never a silent skip.
 *
 * TODO (DEC-020): the default golden cases are tests/fixtures/logic/golden-testcases.json, written for
 * v1.json: GF01 to GF12 are Medic confirmed, g01 to g20 are proposed and still awaiting Medic. Move the
 * default out of tests/ (or behind a loader exported by the golden-case work) and both settings into src/config.ts.
 */

export interface CheckInputs {
  goldenCases?: GoldenCase[];
  compileSettings?: CompileSettings;
  /** The second, independent logic model for the cross-check comparison (a model that does not parse is kept as { invalid }). */
  crossCheck?: CrossCheckInput;
}

export type CheckInputsProvider = (runId: string) => Promise<CheckInputs>;

export const goldenCasesKey = (runId: string): string => artifactKey(runId, "inputs", "golden_cases.json");
export const compileSettingsKey = (runId: string): string => artifactKey(runId, "inputs", "compile_settings.json");
/** The second draft: a logic model (JSON) produced separately, for example by running fill_logic on the cross-check extraction. */
export const crossCheckKey = (runId: string): string => artifactKey(runId, "inputs", "cross_check_model.json");

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_GOLDEN_CASES_PATH = path.join(backendDir, "tests", "fixtures", "logic", "golden-testcases.json");
export const DEFAULT_COMPILE_SETTINGS_PATH = path.join(backendDir, "compile-demo", "settings.demo.json");

const CompileSettingsSchema = z
  .object({
    formTitle: z.string().min(1).max(200),
    icon: z.string().min(1).max(100),
    taskWindowDays: z.number().int().min(0).max(3650).optional(),
    contactTypes: z.object({ person: z.boolean(), place: z.boolean() }).strict(),
    flowMode: z.enum(FLOW_MODES as unknown as [string, ...string[]]).optional(),
  })
  .strict();

/** Validates compile settings (a `_note` key is dropped). Throws on bad input. */
export function parseCompileSettings(json: unknown): CompileSettings {
  const obj = typeof json === "object" && json !== null ? { ...(json as Record<string, unknown>) } : json;
  if (typeof obj === "object" && obj !== null) delete (obj as Record<string, unknown>)["_note"];
  return CompileSettingsSchema.parse(obj) as CompileSettings;
}

async function fromRun(artifacts: ArtifactStore, key: string): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(await artifacts.get(key))) as unknown;
  } catch (e) {
    if (e instanceof NotFound) return undefined;
    throw new Error(`check input ${key} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function fromFile(configured: string | undefined, fallback: string, name: string): unknown {
  if (configured === "none") return undefined;
  const p = configured !== undefined && configured !== "" ? configured : fallback;
  if (!existsSync(p)) {
    if (p === fallback) return undefined;
    throw new Error(`${name} points to a missing file: ${p}`);
  }
  return JSON.parse(readFileSync(p, "utf8")) as unknown;
}

/** The production provider (see the module comment). `env` defaults to process.env. */
export function defaultCheckInputs(artifacts: ArtifactStore, env: Record<string, string | undefined> = process.env): CheckInputsProvider {
  return async (runId) => {
    const out: CheckInputs = {};
    const g = (await fromRun(artifacts, goldenCasesKey(runId))) ?? fromFile(env["GOLDEN_CASES_PATH"], DEFAULT_GOLDEN_CASES_PATH, "GOLDEN_CASES_PATH");
    if (g !== undefined) out.goldenCases = loadGoldenCases(g);
    const st =
      (await fromRun(artifacts, compileSettingsKey(runId))) ?? fromFile(env["COMPILE_SETTINGS_PATH"], DEFAULT_COMPILE_SETTINGS_PATH, "COMPILE_SETTINGS_PATH");
    if (st !== undefined) out.compileSettings = parseCompileSettings(st);
    // No default: without a second draft the comparison does not run and contextNotice says so.
    const cc = (await fromRun(artifacts, crossCheckKey(runId))) ?? fromFile(env["CROSS_CHECK_MODEL_PATH"], "", "CROSS_CHECK_MODEL_PATH");
    if (cc !== undefined) out.crossCheck = loadCrossCheck(cc);
    return out;
  };
}
