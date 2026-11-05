import { createHash } from "node:crypto";
import { z } from "zod";
import { NotFound, artifactKey } from "../artifacts/artifactStore.js";
import type { ArtifactStore } from "../artifacts/artifactStore.js";
import type { CompileSettings } from "../compiler/types.js";
import type { SignerRole } from "../contract/schemas.js";
import type { Version } from "../domain/types.js";
import { canonicalJson } from "../logic/canonical.js";
import { modelSha, parseModel, type Model } from "../logic/index.js";
import type { Store } from "../store/store.js";
import { loadExtraction, type Extraction, type VersionHistoryEntry } from "../validation/context.js";
import { FindingSchema, loadSourceDocument, type Finding, type SourceDocument } from "../validation/finding.js";
import { findingsFor, gates as computeGates, type FindingGroup } from "../validation/gates.js";
import { FLAGS_NOTICE, FlagsDocumentSchema, buildFlags, type FlagsDocument } from "../validation/flags.js";
import { runChecks } from "../validation/runChecks.js";
import { goldenCasesCheck } from "../validation/checks/goldenCases.js";
import { defaultCheckInputs, type CheckInputs, type CheckInputsProvider } from "./checkInputs.js";

export type { CheckInputs, CheckInputsProvider } from "./checkInputs.js";

/**
 * The automatic checks of one version (BR-11, GR-03): runChecks over the stored body with the run's
 * guideline context, its golden cases and compile settings, and the chain of earlier versions (for the
 * open questions). Stored as one findings artifact per content and inputs.
 *
 * The stored artifact is a CACHE for the views only (DEC-020). It is validated with zod on the way in, its
 * gate booleans and role views are never read (they are recomputed from its findings), and a signature or a
 * release build never uses it: Signoff.sign and Signoff.verifyLocked run the checks again.
 */

/** Bump whenever a check changes what it finds: older cached findings are then never served. */
export const CHECKS_VERSION = "dec020-5";

export interface StoreIo {
  store: Store;
  artifacts: ArtifactStore;
  now: () => number;
  /** Golden cases and compile settings for a run. Default: defaultCheckInputs (run artifacts, then env). */
  inputs?: CheckInputsProvider;
}

const GateIds = z.object({ officer: z.array(z.string()), clinician: z.array(z.string()), compile: z.array(z.string()) }).strict();

/** The stored record, validated before any of it is used. */
export const FindingsRecordSchema = z
  .object({
    checksVersion: z.literal(CHECKS_VERSION),
    runId: z.string().min(1),
    n: z.number().int().min(1),
    modelSha: z.string().regex(/^[0-9a-f]{64}$/),
    inputsSha: z.string().regex(/^[0-9a-f]{64}$/),
    settingsSha: z.string().regex(/^([0-9a-f]{64}|none)$/),
    checkedAt: z.number(),
    modelValid: z.boolean(),
    context: z.object({ document: z.boolean(), extraction: z.boolean(), goldenCases: z.boolean(), compileSettings: z.boolean(), crossCheck: z.boolean(), history: z.number().int().min(0) }).strict(),
    checksNotRun: z.array(z.string()),
    claim: z.enum(["PROVEN", "NOT_PROVEN"]),
    claimText: z.string(),
    blocking: z.number().int().min(0),
    status: z.enum(["pass", "fail"]),
    findings: z.array(FindingSchema),
    gates: z.object({ canOfficerSign: z.boolean(), canClinicianSign: z.boolean(), canCompile: z.boolean(), summary: z.string(), blockers: GateIds }).strict(),
    views: z.record(z.string(), z.unknown()),
  })
  .strict();

export interface FindingsRecord {
  checksVersion: string;
  runId: string;
  /** The version that was checked first with this content. */
  n: number;
  modelSha: string;
  /** sha256 of {CHECKS_VERSION, golden cases, compile settings}: part of the cache key. */
  inputsSha: string;
  /** sha256 of the compile settings the checks used, or "none". Recorded on every signature. */
  settingsSha: string;
  checkedAt: number;
  /** false when the body does not parse as a logic model (then every signature is refused). */
  modelValid: boolean;
  /** Which optional inputs the checks had; history is the number of earlier versions compared. */
  context: { document: boolean; extraction: boolean; goldenCases: boolean; compileSettings: boolean; crossCheck: boolean; history: number };
  /** Plain words: each check that did not run and why (never silent, DEC-020). Empty when all ran. */
  checksNotRun: string[];
  claim: "PROVEN" | "NOT_PROVEN";
  claimText: string;
  blocking: number;
  status: "pass" | "fail";
  findings: Finding[];
  gates: {
    canOfficerSign: boolean;
    canClinicianSign: boolean;
    canCompile: boolean;
    summary: string;
    /** Finding ids. */
    blockers: { officer: string[]; clinician: string[]; compile: string[] };
  };
  /** What each role sees, worded for that role (validation/gates.ts findingsFor). */
  views: Record<SignerRole, FindingGroup[]>;
}

const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

/** sha256 of the canonical JSON of the compile settings, or "none" without settings. */
export function settingsShaOf(settings: CompileSettings | undefined): string {
  return settings === undefined ? "none" : sha256(canonicalJson(settings as unknown as Record<string, unknown>));
}

export function inputsShaOf(inputs: CheckInputs): string {
  return sha256(
    canonicalJson({
      checksVersion: CHECKS_VERSION,
      golden: inputs.goldenCases === undefined ? null : sha256(canonicalJson(inputs.goldenCases as unknown as Record<string, unknown>[])),
      settings: settingsShaOf(inputs.compileSettings),
      crossCheck: inputs.crossCheck === undefined ? null : sha256(canonicalJson(inputs.crossCheck as unknown as Record<string, unknown>)),
    }),
  );
}

export const findingsKey = (runId: string, sha: string, inputsSha: string): string =>
  artifactKey(runId, "checks", CHECKS_VERSION, `${sha}-${String(inputsSha).slice(0, 16)}.json`);
/**
 * The flags document of a version (flags.json, read by the front end through GET /runs/:id/versions/:n/flags): the
 * cross-check findings in the form the front end reads. Keyed like the findings, by content and inputs. Like the
 * findings it is derived (from the stored versions and inputs), so it is a cache that can be recomputed, not a record.
 */
export const flagsKey = (runId: string, sha: string, inputsSha: string): string =>
  artifactKey(runId, "flags", CHECKS_VERSION, `${sha}-${String(inputsSha).slice(0, 16)}.json`);
/**
 * The clinician's acceptances of findings ("keep"): one record per run, findingId -> who, why, when. A finding id is
 * the hash of its check, code, subjects and params, so it stays the same while the problem is the same. Only a
 * blocking finding the clinician decides can be accepted (acknowledge in signoff.ts); it then counts as information.
 */
export type Acknowledgement = { by: string; note: string; at: number; n: number };
export const acksKey = (runId: string): string => artifactKey(runId, "acks", "acknowledgements.json");
export async function loadAcks(artifacts: ArtifactStore, runId: string): Promise<Record<string, Acknowledgement>> {
  const raw = await optionalJson(artifacts, acksKey(runId));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, Acknowledgement>;
}
export const ingestBlocksKey = (runId: string): string => artifactKey(runId, "ingest", "input_blocks.json");
export const extractionKey = (runId: string): string => artifactKey(runId, "extract", "extraction_output.json");

export class VersionNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionNotFound";
  }
}

export interface LoadedVersion {
  version: Version;
  raw: unknown;
  /** Present when the body parses. */
  model?: Model;
  issues: string[];
  /** modelSha of the parsed model; for a body that does not parse, sha256 of its canonical JSON. */
  sha: string;
  /** sha256 of the exact stored bytes. */
  bytesSha: string;
}

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

export async function loadVersion(io: Pick<StoreIo, "store" | "artifacts">, runId: string, n: number): Promise<LoadedVersion> {
  const version = await io.store.getVersion(runId, n);
  if (!version) throw new VersionNotFound(`Version ${n} of run ${runId} not found`);
  const bytes = await io.artifacts.get(version.artifactKey);
  const bytesSha = sha256(bytes);
  const raw = JSON.parse(decode(bytes)) as unknown;
  const parsed = parseModel(raw);
  if (parsed.ok) return { version, raw, model: parsed.value, issues: [], sha: modelSha(parsed.value), bytesSha };
  return { version, raw, issues: parsed.issues, sha: sha256(canonicalJson(raw)), bytesSha };
}

async function optionalJson(artifacts: ArtifactStore, key: string): Promise<unknown> {
  try {
    return JSON.parse(decode(await artifacts.get(key))) as unknown;
  } catch (e) {
    if (e instanceof NotFound || e instanceof SyntaxError) return undefined;
    throw e;
  }
}

/** The run's guideline text (ingest) and extraction record, when present and well formed. */
export async function loadCheckContext(artifacts: ArtifactStore, runId: string): Promise<{ document?: SourceDocument; extraction?: Extraction }> {
  const out: { document?: SourceDocument; extraction?: Extraction } = {};
  const blocks = await optionalJson(artifacts, ingestBlocksKey(runId));
  if (blocks !== undefined) {
    try {
      out.document = loadSourceDocument(blocks);
    } catch {
      // A malformed record is treated as absent; contextNotice and checksNotRun tell the reviewer.
    }
  }
  const ex = await optionalJson(artifacts, extractionKey(runId));
  if (ex !== undefined) {
    try {
      out.extraction = loadExtraction(ex);
    } catch {
      // As above.
    }
  }
  return out;
}

/**
 * The chain of versions from version 1 to `loaded` (oldest first, `loaded` last), following `parent`.
 * Versions whose body does not parse are left out (nothing to compare in them).
 */
export async function loadHistory(io: Pick<StoreIo, "store" | "artifacts">, runId: string, loaded: LoadedVersion): Promise<VersionHistoryEntry[]> {
  const entry = (v: Version, model: Model): VersionHistoryEntry => ({ n: v.n, model, author: v.author, ...(v.authorRole !== undefined ? { authorRole: v.authorRole } : {}) });
  const chain: VersionHistoryEntry[] = [];
  if (loaded.model !== undefined) chain.push(entry(loaded.version, loaded.model));
  let parent = loaded.version.parent;
  const seen = new Set<number>([loaded.version.n]);
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    let v: LoadedVersion;
    try {
      v = await loadVersion(io, runId, parent);
    } catch (e) {
      if (e instanceof VersionNotFound || e instanceof NotFound || e instanceof SyntaxError) break;
      throw e;
    }
    if (v.model !== undefined) chain.push(entry(v.version, v.model));
    parent = v.version.parent;
  }
  return chain.reverse();
}

function notRun(ctx: { document?: unknown; extraction?: unknown }, inputs: CheckInputs): string[] {
  const out: string[] = [];
  if (ctx.document === undefined) out.push("the quote and number checks against the booklet: the booklet text of this run is missing");
  if (ctx.extraction === undefined) out.push("the danger-sign and unused-passage checks: the reading of the booklet is missing");
  if (inputs.goldenCases === undefined) out.push("the test-case check: no test cases (children with a known result) were supplied, so none was run through this version");
  if (inputs.compileSettings === undefined) out.push("the form-readiness check: no form settings were supplied, so it is not known whether the form can be built");
  return out;
}

function buildRecord(base: Omit<FindingsRecord, "gates" | "views" | "blocking" | "status">, modelValid: boolean): FindingsRecord {
  const g = computeGates({ findings: base.findings, claim: base.claim, claimText: base.claimText });
  const ids = (fs: readonly Finding[]): string[] => fs.map((f) => f.id);
  const blocking = base.findings.filter((f) => f.severity === "blocking").length;
  const tail = base.checksNotRun.length > 0 ? ` Not checked: ${base.checksNotRun.join("; ")}.` : "";
  return {
    ...base,
    blocking,
    status: blocking === 0 ? "pass" : "fail",
    gates: {
      canOfficerSign: g.canOfficerSign && modelValid,
      canClinicianSign: g.canClinicianSign && modelValid,
      canCompile: g.canCompile && modelValid,
      summary: g.summary + tail,
      blockers: { officer: ids(g.blockers.officer), clinician: ids(g.blockers.clinician), compile: ids(g.blockers.compile) },
    },
    views: { program_officer: findingsFor(base.findings, "program_officer"), clinician: findingsFor(base.findings, "clinician") },
  };
}

export async function inputsFor(io: StoreIo, runId: string): Promise<CheckInputs> {
  return (io.inputs ?? defaultCheckInputs(io.artifacts))(runId);
}

/**
 * Runs the checks for version n now and stores the findings artifact (the cache). `override` replaces the
 * run's inputs (the release build passes its own compile settings). Returns the record and its key.
 */
export async function computeFindings(
  io: StoreIo,
  runId: string,
  n: number,
  override?: CheckInputs,
): Promise<{ record: FindingsRecord; key: string; loaded: LoadedVersion; inputs: CheckInputs }> {
  const loaded = await loadVersion(io, runId, n);
  const inputs = override ?? (await inputsFor(io, runId));
  const record = await analyse(io, runId, n, loaded, inputs);
  const inputsSha = inputsShaOf(inputs);
  const key = findingsKey(runId, loaded.sha, inputsSha);
  await io.artifacts.put(key, JSON.stringify(record), "application/json");
  await io.artifacts.put(flagsKey(runId, loaded.sha, inputsSha), JSON.stringify(flagsDocumentOf(record, inputs)), "application/json");
  return { record, key, loaded, inputs };
}

/**
 * The findings an edited model would get as the next version after `baseN`, computed now and NOT stored
 * (no artifact, no version). Same checks and history rules as computeFindings; for previews only.
 */
export async function previewFindings(
  io: StoreIo,
  runId: string,
  baseN: number,
  model: Model,
  who: { author: string; authorRole?: SignerRole },
): Promise<FindingsRecord> {
  const base = await loadVersion(io, runId, baseN);
  const next = baseN + 1;
  const loaded: LoadedVersion = {
    version: { ...base.version, n: next, parent: baseN, author: who.author, ...(who.authorRole !== undefined ? { authorRole: who.authorRole } : {}) },
    raw: model,
    model,
    issues: [],
    sha: modelSha(model),
    bytesSha: "",
  };
  return analyse(io, runId, next, loaded, await inputsFor(io, runId));
}

async function analyse(io: StoreIo, runId: string, n: number, loaded: LoadedVersion, inputs: CheckInputs): Promise<FindingsRecord> {
  const ctx = await loadCheckContext(io.artifacts, runId);
  const history = await loadHistory(io, runId, loaded);
  // A body that does not parse still goes through runChecks: schemaReferences turns every parse issue
  // into a blocking SCHEMA_INVALID finding and the other checks are skipped.
  const model = (loaded.model ?? loaded.raw) as Model;
  const res = runChecks({
    model,
    ...ctx,
    ...(inputs.goldenCases !== undefined ? { goldenCases: inputs.goldenCases } : {}),
    ...(inputs.compileSettings !== undefined ? { compileSettings: inputs.compileSettings } : {}),
    ...(inputs.crossCheck !== undefined ? { crossCheck: inputs.crossCheck } : {}),
    // Read by the open-question check (validation/context.ts HistoryContext).
    history,
  } as Parameters<typeof runChecks>[0]);
  const acks = await loadAcks(io.artifacts, runId);
  const findings = res.findings.map((f): Finding =>
    f.severity === "blocking" && f.decidedBy === "clinician" && acks[f.id] !== undefined ? { ...f, severity: "info" } : f,
  );
  return buildRecord(
    {
      checksVersion: CHECKS_VERSION,
      runId,
      n,
      modelSha: loaded.sha,
      inputsSha: inputsShaOf(inputs),
      settingsSha: settingsShaOf(inputs.compileSettings),
      checkedAt: io.now(),
      modelValid: loaded.model !== undefined,
      context: {
        document: ctx.document !== undefined,
        extraction: ctx.extraction !== undefined,
        goldenCases: inputs.goldenCases !== undefined,
        compileSettings: inputs.compileSettings !== undefined,
        crossCheck: inputs.crossCheck !== undefined,
        history: Math.max(0, history.length - 1),
      },
      checksNotRun: notRun(ctx, inputs),
      claim: res.claim,
      claimText: res.claimText,
      findings,
    },
    loaded.model !== undefined,
  );
}

/** How many confirmed cases the checked draft and the second draft each get right (the golden check run on both); null without both. */
function goldenOfBoth(record: FindingsRecord, inputs: CheckInputs): { cases: number; first: number; second: number } | null {
  const cc = inputs.crossCheck;
  const cases = inputs.goldenCases;
  if (cc === undefined || !("model" in cc) || cases === undefined || cases.length === 0) return null;
  const agreeOf = (fs: readonly { code: string; params: Record<string, unknown> }[]): number | undefined => {
    const n = fs.find((f) => f.code === "GOLDEN_COUNT")?.params["agree"];
    return typeof n === "number" ? n : undefined;
  };
  const first = agreeOf(record.findings.filter((f) => f.check === "goldenCases"));
  const second = agreeOf(goldenCasesCheck({ model: cc.model, goldenCases: cases } as unknown as Parameters<typeof goldenCasesCheck>[0]));
  return first !== undefined && second !== undefined ? { cases: cases.length, first, second } : null;
}

/** The flags document for a findings record: only the cross-check's findings, and whether the comparison ran. */
export function flagsDocumentOf(record: FindingsRecord, inputs: CheckInputs): FlagsDocument {
  const cc = inputs.crossCheck;
  const { flags, summary } = buildFlags(record.findings.filter((f) => f.check === "crossCheck"));
  let golden: ReturnType<typeof goldenOfBoth> = null;
  try {
    golden = goldenOfBoth(record, inputs);
  } catch {
    // Advisory: a draft the golden check cannot work through leaves the comparison out, never the flags.
  }
  return {
    mode: "logic_models",
    runId: record.runId,
    n: record.n,
    modelSha: record.modelSha,
    checksVersion: record.checksVersion,
    inputsSha: record.inputsSha,
    comparison: cc === undefined ? "not_run" : "model" in cc ? "ran" : "second_draft_invalid",
    secondDraftSha: cc !== undefined && "model" in cc ? modelSha(cc.model) : null,
    ...(golden !== null ? { golden } : {}),
    checkedAt: record.checkedAt,
    summary,
    notice: FLAGS_NOTICE,
    flags,
  };
}

/**
 * The stored flags document for the current content and inputs of version n, computed (with the findings) when it is
 * missing or does not belong to this content. For the front end's view only; a signature or a build never reads it.
 */
export async function ensureFlags(io: StoreIo, runId: string, n: number): Promise<{ doc: FlagsDocument; key: string }> {
  const loaded = await loadVersion(io, runId, n);
  const inputs = await inputsFor(io, runId);
  const inputsSha = inputsShaOf(inputs);
  const key = flagsKey(runId, loaded.sha, inputsSha);
  const read = async (): Promise<FlagsDocument | undefined> => {
    const parsed = FlagsDocumentSchema.safeParse(await optionalJson(io.artifacts, key));
    return parsed.success && parsed.data.runId === runId && parsed.data.modelSha === loaded.sha && parsed.data.inputsSha === inputsSha && parsed.data.checksVersion === CHECKS_VERSION
      ? parsed.data
      : undefined;
  };
  const hit = await read();
  if (hit !== undefined) return { doc: hit, key };
  await computeFindings(io, runId, n, inputs);
  const fresh = await read();
  if (fresh === undefined) throw new Error(`flags for version ${n} of run ${runId} could not be stored`);
  return { doc: fresh, key };
}

/**
 * The findings for the current content and inputs of version n, for the VIEWS: read from the cache when a
 * valid record exists (gates and views recomputed from its findings, never read), computed otherwise.
 * Never use this for a signature or a build; use computeFindings.
 */
export async function ensureFindings(io: StoreIo, runId: string, n: number): Promise<{ record: FindingsRecord; key: string; loaded: LoadedVersion }> {
  const loaded = await loadVersion(io, runId, n);
  const inputs = await inputsFor(io, runId);
  const inputsSha = inputsShaOf(inputs);
  const key = findingsKey(runId, loaded.sha, inputsSha);
  const parsed = FindingsRecordSchema.safeParse(await optionalJson(io.artifacts, key));
  if (parsed.success && parsed.data.modelSha === loaded.sha && parsed.data.inputsSha === inputsSha && parsed.data.runId === runId) {
    const d = parsed.data;
    const record = buildRecord(
      {
        checksVersion: d.checksVersion,
        runId,
        n,
        modelSha: d.modelSha,
        inputsSha: d.inputsSha,
        settingsSha: d.settingsSha,
        checkedAt: d.checkedAt,
        modelValid: loaded.model !== undefined,
        context: d.context,
        checksNotRun: d.checksNotRun,
        claim: d.claim,
        claimText: d.claimText,
        findings: d.findings,
      },
      loaded.model !== undefined,
    );
    return { record, key, loaded };
  }
  const { record } = await computeFindings(io, runId, n, inputs);
  return { record, key, loaded };
}
