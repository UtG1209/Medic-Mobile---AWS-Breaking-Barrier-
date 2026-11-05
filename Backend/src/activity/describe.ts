import type { RunState } from "../contract/schemas.js";
import type { AuditEvent } from "../store/store.js";

export type Actor = "pipeline" | "officer_agent" | "clinician" | "it";
export interface ActivityItem {
  /** Position in the run's audit list; the cursor is the last seq + 1. */
  seq: number;
  at: number;
  actor: Actor;
  kind: string;
  text: string;
}
export interface ActivityFeed {
  items: ActivityItem[];
  /** Pass back as `after` to get only newer items. */
  cursor: number;
  runState: RunState;
}

const STATE_WORDS: Record<string, string> = {
  created: "created",
  ingesting: "reading the guideline",
  extracting: "extracting the guideline content",
  filling_logic: "building the decision logic",
  in_review: "in review",
  checking: "running checks",
  awaiting_officer: "waiting for the program officer",
  awaiting_clinician: "waiting for the clinician",
  locked: "locked",
  failed: "failed",
};
const STEP_WORDS: Record<string, string> = {
  ingest: "reading the guideline",
  extract: "extracting the guideline content",
  fill_logic: "building the decision logic",
};
const step = (s: unknown): string => STEP_WORDS[String(s)] ?? String(s).replace(/_/g, " ");
const state = (s: unknown): string => (s === null || s === undefined ? "nothing" : (STATE_WORDS[String(s)] ?? String(s)));
const roleActor = (r: unknown): Actor => (r === "clinician" ? "clinician" : r === "program_officer" ? "officer_agent" : "it");
const roleWord = (r: unknown): string => (r === "clinician" ? "clinician" : "officer agent");

type D = Record<string, unknown>;

function describeOne(e: AuditEvent): { actor: Actor; kind: string; text: string } {
  const d: D = typeof e.detail === "object" && e.detail !== null ? (e.detail as D) : {};
  const v = d.n !== undefined ? ` version ${String(d.n)}` : "";
  switch (e.type) {
    case "run_state":
      return { actor: "pipeline", kind: "state", text: d.from === null ? "Run created." : `Run moved from ${state(d.from)} to ${state(d.to)}.` };
    case "run_state_healed":
      return { actor: "pipeline", kind: "state", text: `Run state corrected to ${state(d.to)} to match the newest version.` };
    case "step_started":
      return { actor: "pipeline", kind: "step", text: `Started ${step(d.step)}.` };
    case "step_succeeded":
      return { actor: "pipeline", kind: "step", text: `Finished ${step(d.step)}.` };
    case "step_failed":
      return { actor: "pipeline", kind: "step", text: `Problem while ${step(d.step)}: ${String(d.error ?? "unknown error").slice(0, 200)}` };
    case "step_retry":
      return { actor: "pipeline", kind: "step", text: `Retrying ${step(d.step)} (attempt ${String(d.nextAttempt)}).` };
    case "resume_error":
      return { actor: "pipeline", kind: "error", text: "Could not resume the run after a restart." };
    case "compiled":
      return { actor: "pipeline", kind: "compiled", text: `Built the form from${v || " the locked version"}.` };
    case "signature":
      return { actor: roleActor(d.role), kind: "signed", text: `The ${roleWord(d.role)} signed${v}.` };
    case "version_locked":
      return { actor: "pipeline", kind: "locked", text: `Both sign-offs done:${v || " version"} is locked.` };
    case "version_rejected":
      return { actor: "clinician", kind: "rejected", text: `Rejected${v}${d.urgent === true ? " as urgent" : ""}; sent back for changes.` };
    case "officer_agent_started":
      return { actor: "officer_agent", kind: "agent_started", text: "The review agent started checking the draft." };
    case "officer_agent_fix":
      // The agent also records refused attempts under this type (with `refused`); never call those a fix.
      if (typeof d.refused === "string") return { actor: "officer_agent", kind: "agent_note", text: `The review agent's proposed fix${v ? ` to${v}` : ""} was not applied: ${d.refused}.` };
      return { actor: "officer_agent", kind: "agent_fix", text: typeof d.summary === "string" ? `The review agent fixed: ${d.summary}` : `The review agent fixed an issue${typeof d.newVersion === "number" ? ` and saved version ${String(d.newVersion)}` : ""}.` };
    case "officer_agent_signed":
      return { actor: "officer_agent", kind: "agent_signed", text: `The review agent signed off${v}.` };
    case "officer_agent_escalated":
      // The agent writes the cause under `why` (older records may have `reason`).
      return { actor: "officer_agent", kind: "agent_escalated", text: typeof (d.why ?? d.reason) === "string" ? `The review agent needs a person: ${String(d.why ?? d.reason)}` : "The review agent needs a person to look at this." };
    case "officer_agent_refused_paths":
      return { actor: "officer_agent", kind: "agent_note", text: "The review agent's proposed fix was refused because it touched parts of the model it may not change." };
    default:
      return { actor: "pipeline", kind: e.type, text: e.type.replace(/_/g, " ") + "." };
  }
}

/** Plain-words activity lines in audit order. `after` is a previous cursor: only events at or past it are returned. */
export function describeAudit(events: readonly AuditEvent[], runState: RunState, opts: { after?: number } = {}): ActivityFeed {
  const after = Number.isInteger(opts.after) && (opts.after as number) > 0 ? (opts.after as number) : 0;
  const items: ActivityItem[] = [];
  for (let i = after; i < events.length; i++) {
    const e = events[i]!;
    items.push({ seq: i, at: e.at, ...describeOne(e) });
  }
  return { items, cursor: events.length, runState };
}
