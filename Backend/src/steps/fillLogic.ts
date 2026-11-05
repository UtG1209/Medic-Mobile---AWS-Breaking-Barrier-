import { readFile } from "node:fs/promises";
import { NotFound, artifactKey } from "../artifacts/artifactStore.js";
import { TransientUsageError, UsageError, type Step, type StepContext, type StepResult, type StepUsage } from "../engine/step.js";
import { DraftSchema, type Draft } from "../logic/fill/draftSchema.js";
import { resolveDraft, type ResolveOptions, type ResolvedModel } from "../logic/fill/resolve.js";
import { ModelOutputError, RunawayOutputError, type ModelContent } from "../model/modelClient.js";
import { Conflict } from "../store/store.js";
import { ExtractionOutput } from "./extractionSchema.js";
import { missingQuestions, namingRepairText, type RequiredQuestion } from "./goldenNames.js";
import type { LogicModelValidator } from "./logicModelValidator.js";

export interface FillLogicOptions {
  validator: LogicModelValidator;
  modelId: string;
  /** System prompt file (extraction/fill_prompt.txt by default, see config FILL_PROMPT). */
  promptPath: string;
  maxTokens?: number;
  /** The names the confirmed test cases use, as text for the prompt (see goldenNames.ts). A failure here never fails the step. */
  namingHint?: (runId: string) => Promise<string | undefined>;
  /** The questions the confirmed test cases answer. A finished draft that lacks one gets one correction call (kept only if better). */
  requiredQuestions?: (runId: string) => Promise<RequiredQuestion[] | undefined>;
  /** Logic model meta.pathway_id; defaults to a slug of the guideline source id. */
  pathwayId?: string;
  guideline?: { title?: string; publisher?: string; edition?: string };
}

const MAX_PROBLEMS_LISTED = 30;

// Output cap of a fill call. The hidden thinking of Haiku 5.5 counts too (11k used of the old 16k for a 6 KB draft).
export const FILL_MAX_TOKENS = 32000;

// Problems that come from the extraction itself: asking the model for the same draft again cannot fix them.
const EXTRACTION_PROBLEM = /no child age variable|cannot be read as "X months up to/;

function addUsage(a: StepUsage | undefined, b: StepUsage | undefined): StepUsage | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, modelId: b.modelId };
}

function slug(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = s.toLowerCase().replace(/\.pdf$/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return /^[a-z][a-z0-9_]*$/.test(t) ? t : undefined;
}

/** The extraction as the model sees it: thresholds carry their index, which is all the draft may write. */
function extractionContent(runId: string, ex: ExtractionOutput, hint?: string): ModelContent[] {
  const thresholds = ex.thresholds.map((t, index) => ({ index, ...t }));
  return [
    { type: "text", text: `Run: ${runId}\nMode: new_guideline\nThe guideline extraction follows. Refer to its items by id, and to thresholds by index.` },
    { type: "text", text: "Thresholds (use {\"threshold\": index}):\n" + JSON.stringify(thresholds) },
    { type: "text", text: "Extraction:\n" + JSON.stringify({ ...ex, thresholds: undefined }) },
    ...(hint !== undefined ? [{ type: "text" as const, text: hint }] : []),
    { type: "text", text: "Return one JSON object: the draft." },
  ];
}

export function createFillLogicStep(opts: FillLogicOptions): Step {
  return {
    name: "fill_logic",
    runState: "filling_logic",
    async run(ctx): Promise<StepResult> {
      const runId = ctx.run.runId;

      // Version 1 is the only one this step may create. If it exists (for example a
      // crash after addVersion), succeed without touching it: a user may have extended it.
      const existing = async (): Promise<string | undefined> => {
        const versions = await ctx.store.listVersions(runId);
        if (versions.length === 0) return undefined;
        const v1 = versions.find((v) => v.n === 1);
        if (!v1) throw new Error(`Run ${runId} has versions but version 1 is missing`);
        return v1.artifactKey;
      };

      const found = await existing();
      if (found !== undefined) return { artifactRefs: { version: found } };

      const inKey = artifactKey(runId, "extract", "extraction_output.json");
      let output: unknown;
      try {
        output = JSON.parse(new TextDecoder().decode(await ctx.artifacts.get(inKey)));
      } catch (e) {
        if (e instanceof NotFound) throw new Error(`Extraction output not found at ${inKey}`);
        if (e instanceof SyntaxError) throw new Error(`Extraction output at ${inKey} is not valid JSON`);
        throw e;
      }
      const parsedEx = ExtractionOutput.safeParse(output);
      if (!parsedEx.success) {
        const issues = parsedEx.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`);
        throw new Error(`Extraction output at ${inKey} does not match the extraction schema: ${issues.join("; ")}`);
      }
      const ex = parsedEx.data;

      const resolveOpts = await resolveOptions(ctx, opts);
      const system = await readFile(opts.promptPath, "utf8");
      const hint = await opts.namingHint?.(runId).catch(() => undefined);
      const content = extractionContent(runId, ex, hint);
      const maxTokens = opts.maxTokens ?? FILL_MAX_TOKENS;

      const call = async (
        c: ModelContent[],
        rawName: string,
      ): Promise<{ draft?: Draft; raw: string; usage?: StepUsage; problems: string[] }> => {
        const rawKey = artifactKey(runId, "fill_logic", rawName);
        try {
          const r = await ctx.model.generateJson({ modelId: opts.modelId, system, content: c, schema: DraftSchema, maxTokens });
          await ctx.artifacts.put(rawKey, r.raw, "text/plain");
          return { draft: r.value, raw: r.raw, usage: r.usage, problems: [] };
        } catch (e) {
          if (e instanceof RunawayOutputError) {
            await ctx.artifacts.put(artifactKey(runId, "fill_logic", "raw_runaway.txt"), e.raw, "text/plain");
            throw e;
          }
          if (!(e instanceof ModelOutputError)) throw e;
          await ctx.artifacts.put(rawKey, e.raw, "text/plain");
          return { raw: e.raw, ...(e.usage !== undefined ? { usage: e.usage } : {}), problems: e.issues ?? [e.message] };
        }
      };
      const tryResolve = (d: Draft | undefined, problems: string[]): { model?: ResolvedModel; problems: string[] } => {
        if (d === undefined) return { problems };
        const r = resolveDraft(d, ex, resolveOpts);
        if (!r.ok) return { problems: r.problems };
        // No human program officer: every question a person must answer goes to the clinician (a team choice or a missing
        // publisher cannot be settled by the officer agent, and nobody else may answer officer-routed questions). The
        // officer agent keeps fixing everything else (citations, wording, checks) by itself.
        const open_questions = r.model.open_questions.map((q) => (q.route_to === "clinician" ? q : { ...q, route_to: "clinician" as const }));
        return { model: { ...r.model, open_questions }, problems: [] };
      };

      // First attempt.
      const first = await call(content, "raw_response.txt");
      let usage = first.usage;
      let attempt = tryResolve(first.draft, first.problems);
      let draft = first.draft;
      let raw = first.raw;
      let repaired = false;

      // One repair call with the list of problems; content findings are not repaired here.
      if (attempt.model === undefined) {
        const listed = attempt.problems.slice(0, MAX_PROBLEMS_LISTED);
        const repairContent: ModelContent[] = [
          ...content,
          { type: "text", text: "Your previous answer was:\n" + first.raw },
          {
            type: "text",
            text:
              "It cannot be used because of these problems:\n- " +
              listed.join("\n- ") +
              (attempt.problems.length > listed.length ? `\n(and ${attempt.problems.length - listed.length} more)` : "") +
              "\nReturn the whole corrected draft as one JSON object. Change only what these problems need.",
          },
        ];
        const second = await call(repairContent, "raw_repair.txt");
        usage = addUsage(usage, second.usage);
        attempt = tryResolve(second.draft, second.problems);
        draft = second.draft;
        raw = second.raw;
        repaired = true;
        if (attempt.model === undefined) {
          const message = `fill_logic: the model draft still has ${attempt.problems.length} problem(s) after one repair: ${attempt.problems.slice(0, 10).join("; ")}`;
          // A problem in the extraction itself (no age variable, an unreadable age range) comes back every time: do not retry.
          if (attempt.problems.some((p) => EXTRACTION_PROBLEM.test(p))) throw new UsageError(message, usage);
          // Otherwise the draft is sampled, so a fresh call usually avoids the slip (an outcome used as an action, a number
          // used as yes/no): retry it. The cost of this attempt's calls is still recorded.
          throw new TransientUsageError(
            message,
            usage,
          );
        }
      }
      // The confirmed test cases answer questions by id and type, and a draft without one cannot be tested against them. The
      // model's names vary from run to run, so one correction call asks for what is missing. It is kept only when it resolves
      // and has fewer of them missing; otherwise the draft stays as it was (the golden-case check then says what is missing).
      // Never fails the step, and is skipped when the draft already needed a repair.
      const required = await opts.requiredQuestions?.(runId).catch(() => undefined);
      if (required !== undefined && required.length > 0 && !repaired && attempt.model !== undefined) {
        const missing = missingQuestions(attempt.model.questions, required);
        if (missing.length > 0) {
          const fixContent: ModelContent[] = [...content, { type: "text", text: "Your previous answer was:\n" + raw }, { type: "text", text: namingRepairText(missing) }];
          try {
            const third = await call(fixContent, "raw_naming.txt");
            usage = addUsage(usage, third.usage);
            const t = tryResolve(third.draft, third.problems);
            if (t.model !== undefined && missingQuestions(t.model.questions, required).length < missing.length) {
              attempt = t;
              draft = third.draft;
            }
          } catch {
            // A failed correction keeps the draft as it was.
          }
        }
      }
      const body = attempt.model;

      const result = opts.validator.validate(body);
      if (!result.ok) throw new UsageError(`Logic model failed validation: ${result.issues.join("; ")}`, usage);

      // Re-check right before writing so we never overwrite an object a version already
      // points at. The remaining window between this check and addVersion is accepted
      // because the engine lease serialises a run's steps.
      const raced = await existing();
      if (raced !== undefined) return { artifactRefs: { version: raced }, ...(usage !== undefined ? { usage } : {}) };

      const draftKey = artifactKey(runId, "fill_logic", "draft.json");
      await ctx.artifacts.put(draftKey, JSON.stringify(draft, null, 2), "application/json");

      // Artifact first, so a version never points at a missing object.
      const key = artifactKey(runId, "versions", "v1.json");
      await ctx.artifacts.put(key, JSON.stringify(body, null, 2), "application/json");
      try {
        await ctx.store.addVersion({ runId, n: 1, parent: null, author: "ai", createdAt: ctx.now(), artifactKey: key });
      } catch (e) {
        if (!(e instanceof Conflict)) throw e;
        const winner = await existing();
        if (winner === undefined) throw e;
        return { artifactRefs: { version: winner }, ...(usage !== undefined ? { usage } : {}) };
      }
      return { artifactRefs: { version: key, draft: draftKey }, ...(usage !== undefined ? { usage } : {}) };
    },
  };
}

/** meta comes from code: the run's file hash, else the ingest record's; titles from options or the ingest record. */
async function resolveOptions(ctx: StepContext, opts: FillLogicOptions): Promise<ResolveOptions> {
  let doc: { source_id?: unknown; doc_name?: unknown; doc_sha256?: unknown } = {};
  try {
    doc = JSON.parse(new TextDecoder().decode(await ctx.artifacts.get(artifactKey(ctx.run.runId, "ingest", "input_blocks.json")))) as typeof doc;
  } catch (e) {
    if (!(e instanceof NotFound) && !(e instanceof SyntaxError)) throw e;
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
  const fileSha256 = str(ctx.run.docSha256) ?? str(doc.doc_sha256);
  const title = opts.guideline?.title ?? str(doc.doc_name) ?? str(doc.source_id) ?? "Guideline";
  return {
    pathwayId: opts.pathwayId ?? slug(str(doc.source_id)) ?? "pathway",
    createdAt: new Date(ctx.now()).toISOString(),
    guideline: {
      title,
      ...(opts.guideline?.publisher !== undefined ? { publisher: opts.guideline.publisher } : {}),
      ...(opts.guideline?.edition !== undefined ? { edition: opts.guideline.edition } : {}),
      ...(fileSha256 !== undefined ? { fileSha256 } : {}),
    },
  };
}
