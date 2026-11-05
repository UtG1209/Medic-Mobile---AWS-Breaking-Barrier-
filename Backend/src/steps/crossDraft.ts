import { NotFound, artifactKey, type ArtifactStore } from "../artifacts/artifactStore.js";
import type { Step, StepContext, StepResult, StepUsage } from "../engine/step.js";
import { MemoryStore } from "../store/memoryStore.js";

/**
 * The second, independent draft for the "two drafts agree" check (DEC-035).
 *
 * The comparison already exists: when runs/<id>/inputs/cross_check_model.json is there, the checks compare the
 * draft with it child by child. Nothing in the deployed pipeline made that file, so the check never ran. The
 * repository's original second draft comes from a different model run by an offline script; the deployment's IAM
 * policy allows one model, so this step makes it the same way the first one was made: it runs the extract and fill
 * steps again from the same pages, as a fresh and independent model call, and keeps the result as that file.
 * (Same model, so two drafts agreeing does not make either right; the check's own notice says so.)
 *
 * The second run's files live under runs/<id>/cross/ and its logic model version goes to a throwaway in-memory
 * store, so nothing of it touches the real run: no second version 1, no second extraction.
 *
 * Advisory: a failure never fails the run. It is recorded in artifactRefs (crossDraftStatus, crossDraftError).
 */

export const crossCheckModelKey = (runId: string): string => artifactKey(runId, "inputs", "cross_check_model.json");

// The folders the extract and fill steps write to. Everything else (ingest's pages and blocks, the PDF) is read as is.
const MOVED = new Set(["extract", "fill_logic", "versions"]);

/** The run's artifacts with extract/, fill_logic/ and versions/ moved under cross/, so a second run cannot overwrite the first. */
export class CrossArtifacts implements ArtifactStore {
  constructor(
    private readonly inner: ArtifactStore,
    private readonly runId: string,
  ) {}

  private map(key: string): string {
    const prefix = `runs/${this.runId}/`;
    if (!key.startsWith(prefix)) return key;
    const rest = key.slice(prefix.length);
    return MOVED.has(rest.split("/")[0]!) ? `${prefix}cross/${rest}` : key;
  }
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<void> {
    return this.inner.put(this.map(key), body, contentType);
  }
  get(key: string): Promise<Uint8Array> {
    return this.inner.get(this.map(key));
  }
  exists(key: string): Promise<boolean> {
    return this.inner.exists(this.map(key));
  }
  size(key: string): Promise<number> {
    return this.inner.size(this.map(key));
  }
}

export interface CrossDraftOptions {
  /** The same steps the pipeline runs (extract, then fill_logic), built with the same options. */
  extract: Step;
  fill: Step;
  /** True when a second draft is supplied some other way (CROSS_CHECK_MODEL_PATH): nothing to make. */
  suppliedElsewhere?: boolean;
  /** Tries per step (the model's output varies; a bad quote or a slip is usually gone on the next call). Default 2. */
  tries?: number;
}

const short = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);
const add = (a: StepUsage | undefined, b: StepUsage | undefined): StepUsage | undefined =>
  a === undefined ? b : b === undefined ? a : { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, modelId: b.modelId };

async function runWithTries(step: Step, ctx: StepContext, tries: number): Promise<{ result: StepResult; usage?: StepUsage }> {
  let usage: StepUsage | undefined;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const result = await step.run(ctx);
      return { result, usage: add(usage, result.usage) };
    } catch (e) {
      last = e;
      // The cost of a failed call is carried on the error (UsageError / TransientUsageError).
      usage = add(usage, (e as { usage?: StepUsage }).usage);
    }
  }
  throw Object.assign(new Error(short(last)), { usage });
}

/**
 * The step with the second draft made before it, under the same name and run state (the engine runs one step per
 * state). Wrap the checks step: the checks read the second draft, so it has to exist first.
 */
export function withCrossDraft(checks: Step, opts: CrossDraftOptions): Step {
  const tries = opts.tries ?? 2;
  return {
    name: checks.name,
    runState: checks.runState,
    async run(ctx): Promise<StepResult> {
      const runId = ctx.run.runId;
      let refs: Record<string, string> = {};
      let usage: StepUsage | undefined;
      const key = crossCheckModelKey(runId);
      if (opts.suppliedElsewhere) refs = { crossDraftStatus: "supplied" };
      else if (await ctx.artifacts.exists(key)) refs = { crossDraftStatus: "present" };
      else {
        const sub: StepContext = { ...ctx, store: new MemoryStore(), artifacts: new CrossArtifacts(ctx.artifacts, runId) };
        try {
          const e = await runWithTries(opts.extract, sub, tries);
          usage = add(usage, e.usage);
          const f = await runWithTries(opts.fill, sub, tries);
          usage = add(usage, f.usage);
          const model = await sub.artifacts.get(artifactKey(runId, "versions", "v1.json"));
          await ctx.artifacts.put(key, model, "application/json");
          refs = { crossDraftStatus: "ok", crossDraft: key };
        } catch (e) {
          usage = add(usage, (e as { usage?: StepUsage }).usage);
          const notFound = e instanceof NotFound;
          refs = { crossDraftStatus: "failed", crossDraftError: notFound ? "the second draft left no logic model" : short(e) };
        }
      }
      const res = await checks.run(ctx);
      const merged = add(res.usage, usage);
      return { ...res, artifactRefs: { ...res.artifactRefs, ...refs }, ...(merged !== undefined ? { usage: merged } : {}) };
    },
  };
}
