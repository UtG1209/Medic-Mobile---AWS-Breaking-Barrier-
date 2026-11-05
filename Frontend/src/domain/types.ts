/* Workflow types. The logic model itself is the pathway spec (shared/pathway/types.ts), the same JSON the
   backend pipeline produces. Everything here must survive JSON round-trips (stored by the backend later). */
import type { Answers, ItemId, Page, Patch, Spec } from "../../../shared/pathway/index.ts";

export type { Answers, ItemId, Patch, Spec };
/** The logic model under review: a pathway spec. */
export type Model = Spec;
export type Role = "clinician" | "it";

export interface Patient { id: string; answers: Answers }
export interface Classification { out: string | null; rule: string | null }

export type Severity = "blocking" | "warning";
export type CheckKey = "schema" | "quote" | "number" | "logic" | "golden" | "cross";
export interface Check { sev: Severity; id: ItemId; text: string; kind?: CheckKey }
/** What the checks compare the draft against. */
export interface Evidence {
  /** Guideline text by page, for the quote check. Null when not loaded. */
  pages: Page[] | null; pagesFrom: string;
  /** Draft B for the cross check. Null when the pipeline gave none. */
  draftB: Spec | null; draftBFrom: string;
  /** Live mode: the backend's own cross-check of the loaded version (GET /runs/:id/versions/:n/flags).
      Used instead of draftB when present; null when the route could not be read. */
  cross?: CrossFlags | null;
  /** Live mode: the backend's own golden-case result for the loaded version (from its findings). Used instead of the
      small built-in table when present; null/undefined when the backend gave no golden-case findings. */
  golden?: BackendGolden | null;
}

/** The backend's golden-case result (Backend/src/validation/checks/goldenCases.ts), as the golden card shows it. */
export interface BackendGolden {
  n: number;
  /** How many cases were run and how many gave the expected result (from the backend's own count). Undefined when no count was reported. */
  run?: number; passed?: number;
  /** Every finding of the golden-case check except the plain count, de-duplicated. */
  issues: { sev: "blocking" | "warning"; text: string }[];
}

/** One flag of the backend's flags document (Backend/src/validation/flags.ts), as the cross check shows it. */
export interface CrossFlag { severity: "blocking" | "warning" | "info"; code: string; subjects: { kind: string; id: string }[]; messages: { clinician: string; program_officer: string } }
/** The backend's flags document, the parts the front end reads. */
export interface CrossFlags {
  n: number; comparison: "ran" | "not_run" | "second_draft_invalid"; notice: string;
  summary: { flagCount: number; compared?: number; differing?: number; skipped?: number; groups?: number };
  flags: CrossFlag[];
  /** How many of the confirmed test cases each draft gets right. Absent without a second draft or without cases. */
  golden?: { cases: number; first: number; second: number } | null;
}

/** An open question from the logic model, put to the clinician by the AI agent. */
export interface Flag {
  id: string; about: ItemId; title: string; src: string; why: string;
  res?: { choice: "keep" | "change"; note: string; by: string };
}

/** A change the assistant proposes; applied only when the clinician clicks Apply. */
export interface Proposal { label: string; item: ItemId; field: string; patch: Patch; impact: string; state: "open" | "applied" | "dismissed" }
export interface ChatMsg {
  id: number; from: "agent" | "clinician"; text: string;
  /** Step to show on the flow. */
  select?: ItemId;
  proposals?: Proposal[];
  /** An open question the clinician answers from the chat. */
  ask?: string;
  /** Live mode: the AI's plan for the clinician's feedback (backend revision loop). Applied only on Confirm. */
  revision?: { rid: string; state: "ready" | "applying" | "applied" | "no_change" | "failed" | "cancelled" };
}
/** Something the AI agent fixed or checked on its own, before the clinician sees the draft. */
export interface AgentFix { item: ItemId; check: CheckKey; text: string }

export type WfState = "none" | "clinician" | "verify" | "deploy" | "done";

export interface AuditRow { t: string; actor: string; event: string; ver: string; hash: string; note: string }
export interface VersionRow { ver: string; event: string; meta: string }
export interface VerifyResult { match: number; total: number; cov: number; covTotal: number; tasks: number; mut: number; mutTotal: number }

/** A finding from the backend's checks (GET /runs/:id/versions/:n/findings), worded for one role. */
export interface RemoteFinding { severity: "blocking" | "warning" | "info"; message: string; check: string; role: "program_officer" | "clinician" }
/** Live mode: the backend run and version this workflow was loaded from. */
export interface Remote { runId: string; n: number; modelSha: string; base: Model; claimText: string; findings: RemoteFinding[] }

/** One scored item of GET /runs/:id/versions/:n/scores (Backend/scoring/score_version.py). */
export interface ScoreItem {
  /** The scorer's path: scope, questions/X, derived/X, rules/X, outcomes/X, outcomes/X/actions/i, outcomes/X/follow_up. */
  item: string; kind: string;
  score: number | null; flag: boolean; why?: string | null;
  agreement?: number | null; lowest_reason?: string; pages?: number[]; quotes?: string[];
}
/** Advisory quote-support scores: a model's opinion of each quote, never a check or a gate (Medic rule 6).
    `base` is the logic model that was scored; an item that differs from it now has an out-of-date score. */
export type QuoteScores =
  | { status: "scored"; n: number; modelSha: string; notice: string; summary: { scored: number; flagged: number; not_scored: number }; items: ScoreItem[]; base: Model; sample?: boolean }
  | { status: "not_scored"; n: number }
  | { status: "failed"; n: number; error?: string };

/** Live: the officer agent stopped on version n without signing and left this for a person (its comment, plus
    the blocking findings only the program officer decides). The clinician clears them by editing. */
export interface Escalation { n: number; text: string; items: { message: string; about: ItemId | null }[] }

export interface Workflow {
  id: string;
  guideline: { id: string; name: string; pathway: string; pages: number[] } | null;
  state: WfState;
  rev: number;
  model: Model;
  evidence: Evidence;
  /** The logic model as the AI agent handed it over, before any clinician edit. "Edited" markers compare against it. */
  draft: Model;
  flags: Flag[];
  chat: ChatMsg[];
  agent: AgentFix[];
  /** Models before each clinician edit, newest last. */
  undo: Model[];
  audit: AuditRow[];
  versions: VersionRow[];
  clock: number;
  verify: VerifyResult | null;
  approved: { ver: string; hash: string; locked?: { n: number; modelSha: string } } | null;
  lastKey: string | null;
  /** Set in live mode only. */
  remote: Remote | null;
  /** Quote-support scores for the reviewed version, when the backend has them. Advisory only. */
  scores?: QuoteScores | null;
  /** Set when the officer agent escalated the newest version. */
  escalation?: Escalation | null;
}

export type GuidelineType = "PDF" | "Word" | "Spreadsheet" | "Image" | "Web or text" | "Other";
export type GuidelineStatus = "Uploading" | "Processing" | "Indexed" | "Uploaded" | "Unsupported" | "Failed";
/** One step of the intake pipeline: upload, S3 event, extract, digest, logic model. Set by the backend. */
export interface PipelineStep { key: string; label: string; state: "pending" | "running" | "done" | "failed"; startedAt?: string; endedAt?: string; detail?: string }
export interface Guideline {
  id: string; name: string; type: GuidelineType; meta: string; status: GuidelineStatus; pages: number | null;
  /** Present only for files that went through the backend pipeline. */
  steps?: PipelineStep[];
  error?: string;
  s3Uri?: string;
  /** Live: the clinician approved this run and the backend locked a version; the IT approver can open it at Release. */
  locked?: boolean;
}
