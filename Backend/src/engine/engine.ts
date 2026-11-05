import { randomUUID } from "node:crypto";
import type { RunState } from "../contract/schemas.js";
import type { ArtifactStore } from "../artifacts/artifactStore.js";
import { NotFound } from "../artifacts/artifactStore.js";
import { canTransition } from "../domain/stateMachine.js";
import type { Run } from "../domain/types.js";
import type { ModelClient } from "../model/modelClient.js";
import type { Store } from "../store/store.js";
import { runStep, type RunStepOptions } from "./runner.js";
import type { Step } from "./step.js";
import { errorMessage, safeLog, type Log } from "../log.js";

const MAX_ERROR_CHARS = 500;

// Total attempts per step across all invocations, abandoned ones included. A step that keeps
// outliving its invocation would otherwise be retried (and paid for) forever.
export const DEFAULT_MAX_TOTAL_ATTEMPTS = 6;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface OrchestratorOptions {
  store: Store;
  artifacts: ArtifactStore;
  model: ModelClient;
  // The fixed flow, in order. Each step runs while the run is in its runState.
  steps: Step[];
  owner: string;
  leaseMs: number;
  runnerOpts: Omit<RunStepOptions, "firstAttempt">;
  maxTotalAttempts?: number;
  now?: () => number;
  // State the run enters after the last step (default in_review). Production registers the checks step
  // last and ends in awaiting_officer, where the sign-off starts (DEC-019).
  finalState?: RunState;
  // Called (and awaited, errors dropped) once a run has reached finalState and its lease is released, and by
  // resumeAll for every run waiting in awaiting_officer. Must be idempotent; production wires the officer agent.
  onFinalState?: (runId: string) => Promise<void>;
  // Lambda mode: after each step this invocation runs, stop and call this (lease released first) so the next step
  // starts in a fresh invocation with its own 15 minutes. One invocation for the whole pipeline (several model calls
  // of up to 6 minutes each) runs past the Lambda timeout and fill_logic is cut off every time. If the hand-off is
  // lost, the resume sweep picks the run up (listResumable). Absent: every step runs in this call.
  continueElsewhere?: (runId: string) => Promise<void>;
  // One line per state change and per unexpected error. Default: no logging.
  log?: Log;
}

export class Orchestrator {
  private readonly store: Store;
  private readonly artifacts: ArtifactStore;
  private readonly model: ModelClient;
  private readonly steps: Step[];
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly runnerOpts: Omit<RunStepOptions, "firstAttempt">;
  private readonly now: () => number;
  private readonly maxTotalAttempts: number;
  private readonly continueElsewhere?: (runId: string) => Promise<void>;
  private readonly finalState: RunState;
  private readonly onFinalState: ((runId: string) => Promise<void>) | undefined;
  private readonly log: Log;
  // Runs this instance is advancing right now. The lease is per owner, so it does
  // not stop two calls in the same process (for example a duplicate upload event
  // handled concurrently) from both advancing one run; this set does.
  private readonly active = new Set<string>();
  private statusChangedAt: number | undefined;

  constructor(opts: OrchestratorOptions) {
    this.store = opts.store;
    this.artifacts = opts.artifacts;
    this.model = opts.model;
    this.steps = opts.steps;
    this.owner = opts.owner;
    this.leaseMs = opts.leaseMs;
    this.runnerOpts = opts.runnerOpts;
    this.now = opts.now ?? Date.now;
    this.maxTotalAttempts = opts.maxTotalAttempts ?? DEFAULT_MAX_TOTAL_ATTEMPTS;
    this.finalState = opts.finalState ?? "in_review";
    this.onFinalState = opts.onFinalState;
    this.continueElsewhere = opts.continueElsewhere;
    this.log = safeLog(opts.log);
  }

  // Number of runs this process is advancing right now (reported by /ping).
  activeCount(): number {
    return this.active.size;
  }

  // When the busy/idle status last changed (ms), or undefined if it never has (reported by /ping).
  lastStatusChange(): number | undefined {
    return this.statusChangedAt;
  }

  async createRun(pages: number[] | undefined, filename: string, createdBy?: string): Promise<Run> {
    const createdAt = this.now();
    const run: Run = { runId: randomUUID(), state: "created", createdAt };
    if (pages !== undefined) run.pages = pages;
    if (createdBy !== undefined) run.createdBy = createdBy;
    await this.store.createRun(run);
    await this.store.appendAudit(run.runId, {
      at: createdAt,
      type: "run_state",
      detail: { from: null, to: "created", filename },
    });
    return run;
  }

  // Idempotent: a repeated upload event for a run past `created` does nothing.
  async onUploaded(runId: string, docSha256?: string): Promise<void> {
    const run = await this.mustGet(runId);
    if (run.state !== "created") return;
    if (docSha256 !== undefined) await this.store.updateRun(runId, { docSha256 }, "created");
    await this.advance(runId);
  }

  async advance(runId: string): Promise<void> {
    if (this.active.has(runId)) return;
    this.active.add(runId);
    if (this.active.size === 1) this.statusChangedAt = this.now();
    let outcome: "final" | "handoff" | "stop" = "stop";
    try {
      outcome = await this.advanceHeld(runId);
    } finally {
      this.active.delete(runId);
      if (this.active.size === 0) this.statusChangedAt = this.now();
    }
    if (outcome === "final") await this.fireFinal(runId);
    if (outcome === "handoff" && this.continueElsewhere) {
      try {
        await this.continueElsewhere(runId);
      } catch (e) {
        // The run has no lease, so the resume sweep continues it.
        this.log("hand-off to the next invocation failed; the resume sweep will continue the run", { runId, error: errorMessage(e) });
      }
    }
  }

  private async fireFinal(runId: string): Promise<void> {
    if (!this.onFinalState) return;
    try {
      await this.onFinalState(runId);
    } catch (e) {
      this.log("final state hook error", { runId, error: errorMessage(e) });
      try {
        await this.store.appendAudit(runId, { at: this.now(), type: "final_state_hook_error", detail: { error: errorText(e).slice(0, MAX_ERROR_CHARS) } });
      } catch {
        // Best effort only.
      }
    }
  }

  private async advanceHeld(runId: string): Promise<"final" | "handoff" | "stop"> {
    if (!(await this.renewLease(runId))) return "stop";
    let threw = false;
    let current: Step | undefined;
    // Whether this call ran a step (rather than only skipping steps that had already succeeded).
    let ran = false;
    try {
      let run = await this.mustGet(runId);
      if (run.state === "created") {
        const first = this.steps[0];
        if (!first) return "stop";
        run = await this.transition(run, first.runState);
      }

      for (;;) {
        const index = this.steps.findIndex((s) => s.runState === run.state);
        if (index === -1) return "stop";
        const step = this.steps[index]!;
        current = step;
        // Another owner may have taken the run after our lease lapsed: stop quietly.
        if (!(await this.renewLease(runId))) return "stop";

        const records = (await this.store.listSteps(runId)).filter((r) => r.step === step.name);
        // A succeeded record means the step's outputs already exist; skip it.
        if (!records.some((r) => r.status === "succeeded")) {
          ran = true;
          for (const r of records.filter((r) => r.status === "running")) {
            await this.store.updateStep(runId, step.name, r.attempt, {
              status: "failed",
              endedAt: this.now(),
              error: "abandoned",
            });
          }
          const firstAttempt = records.reduce((max, r) => Math.max(max, r.attempt), 0) + 1;
          const floor = run.attemptFloor?.step === step.name ? run.attemptFloor.attempt : 0;
          const used = records.filter((r) => r.attempt > floor).length;
          const remaining = this.maxTotalAttempts - used;
          if (remaining <= 0) {
            await this.failCapped(run, step, firstAttempt, used);
            if (!(await this.renewLease(runId))) return "stop";
            await this.transition(run, "failed", { currentStep: step.name });
            return "stop";
          }
          const ctx = { run, store: this.store, artifacts: this.artifacts, model: this.model, now: this.now };
          const rec = await runStep(step, ctx, {
            ...this.runnerOpts,
            firstAttempt,
            maxAttempts: Math.min(this.runnerOpts.maxAttempts, remaining),
          });
          if (!(await this.renewLease(runId))) return "stop";
          if (rec.status === "failed") {
            await this.transition(run, "failed", { currentStep: step.name });
            return "stop";
          }
        }

        run = await this.transition(run, this.steps[index + 1]?.runState ?? this.finalState);
        if (index + 1 >= this.steps.length) return "final";
        if (ran && this.continueElsewhere) return "handoff";
      }
    } catch (e) {
      threw = true;
      this.log("run error", { runId, step: current?.name, error: errorMessage(e) });
      await this.failAfterError(runId, current);
      throw e;
    } finally {
      try {
        await this.store.releaseLease(runId, this.owner);
      } catch (releaseError) {
        // Never mask an error from the body.
        if (!threw) throw releaseError;
      }
    }
  }

  // Re-enter a failed run at the step that failed.
  async resume(runId: string): Promise<void> {
    await this.prepareResume(runId);
    await this.advance(runId);
  }

  // The quick part of resume: move a failed run back to the state of its failed step and
  // start a fresh attempt budget for that step. Runs nothing; the run has no lease afterwards,
  // so the resume sweep (listResumable) picks it up.
  async prepareResume(runId: string): Promise<void> {
    const run = await this.mustGet(runId);
    if (run.state !== "failed") throw new Error(`Run ${runId} is not failed (state ${run.state})`);
    const step = this.steps.find((s) => s.name === run.currentStep);
    if (!step) throw new Error(`Run ${runId} has no resumable step: ${run.currentStep}`);
    const floor = (await this.store.listSteps(runId))
      .filter((r) => r.step === step.name)
      .reduce((max, r) => Math.max(max, r.attempt), 0);
    await this.transition(run, step.runState, { currentStep: undefined, attemptFloor: { step: step.name, attempt: floor } });
  }

  // Never throws for a single run's failure: records resume_error on it and moves on.
  async resumeAll(): Promise<void> {
    if (this.onFinalState) {
      for (const run of await this.store.listByState("awaiting_officer")) await this.fireFinal(run.runId);
    }
    for (const run of await this.store.listResumable(this.now())) {
      try {
        await this.advance(run.runId);
      } catch (e) {
        try {
          await this.store.appendAudit(run.runId, {
            at: this.now(),
            type: "resume_error",
            detail: { error: errorText(e).slice(0, MAX_ERROR_CHARS) },
          });
        } catch {
          // Best effort only.
        }
      }
    }
  }

  private async failCapped(run: Run, step: Step, attempt: number, used: number): Promise<void> {
    const at = this.now();
    const error = `Attempt cap reached: step ${step.name} already used ${used} attempts (cap ${this.maxTotalAttempts}), including attempts cut off by an invocation deadline; not retrying. Resume the run to try again.`;
    await this.store.appendStep({
      runId: run.runId,
      step: step.name,
      attempt,
      status: "failed",
      startedAt: at,
      endedAt: at,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      artifactRefs: {},
      error,
    });
    await this.store.appendAudit(run.runId, { at, type: "step_failed", detail: { step: step.name, attempt, error: error.slice(0, MAX_ERROR_CHARS) } });
  }

  private renewLease(runId: string): Promise<boolean> {
    return this.store.acquireLease(runId, this.owner, this.leaseMs, this.now());
  }

  // Best effort after an unexpected error: if we still hold the run, move it to
  // failed so it does not sit in a working state forever. Errors here are dropped;
  // the caller rethrows the original.
  private async failAfterError(runId: string, current: Step | undefined): Promise<void> {
    try {
      if (!(await this.renewLease(runId))) return;
      const run = await this.mustGet(runId);
      // A created run is left as is: a redelivered upload event retries it.
      if (run.state === "failed" || run.state === "created" || !canTransition(run.state, "failed")) return;
      const step = this.steps.find((s) => s.runState === run.state) ?? current;
      await this.transition(run, "failed", { currentStep: step?.name });
    } catch {
      // Best effort only.
    }
  }

  private async mustGet(runId: string): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (!run) throw new NotFound(`Run not found: ${runId}`);
    return run;
  }

  private async transition(run: Run, to: RunState, extra: Partial<Run> = {}): Promise<Run> {
    const from = run.state;
    if (!canTransition(from, to)) throw new Error(`Illegal transition for ${run.runId}: ${from} -> ${to}`);
    const updated = await this.store.updateRun(run.runId, { ...extra, state: to }, from);
    await this.store.appendAudit(run.runId, { at: this.now(), type: "run_state", detail: { from, to } });
    this.log("run state", { runId: run.runId, from, to, ...(extra.currentStep !== undefined ? { step: extra.currentStep } : {}) });
    return updated;
  }
}
