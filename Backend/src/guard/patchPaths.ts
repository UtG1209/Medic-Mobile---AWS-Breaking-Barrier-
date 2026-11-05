/**
 * LLM05/LLM06: allowlist of model paths (JSON pointers) the officer agent may patch, per finding code.
 * Only citations, metadata and open-question bookkeeping. Rule conditions, outcomes, severities,
 * thresholds, questions, derived definitions and action text are never allowed.
 * A "*" segment matches one array index; a pattern also covers everything below it.
 */
const SOURCES = [
  "/questions/*/source",
  "/derived/*/source",
  "/outcomes/*/source",
  "/outcomes/*/actions/*/source",
  "/outcomes/*/follow_up/source",
  "/rules/*/source",
  "/scope/source",
  "/open_questions/*/source",
];
const OPEN_Q = ["/open_questions"];
const NOTE = ["/meta/change_note"];

export const PATCH_PATHS: Readonly<Record<string, readonly string[]>> = {
  HALLUCINATED_CITATION: SOURCES,
  EMPTY_QUOTE: SOURCES,
  QUOTE_TOO_SHORT: SOURCES,
  SOURCE_PAGE_MISSING: SOURCES,
  UNCITED_PASSAGE: SOURCES,
  QUOTE_DROPS_NEGATION: SOURCES,
  // A number not in the item's quotes: the fix is a citation that carries it (re-checked against the PDF).
  UNGROUNDED_NUMBER: SOURCES,
  GUIDELINE_FILE_MISMATCH: ["/meta/guideline/file_sha256"],
  TEAM_TEXT_TO_CONFIRM: OPEN_Q,
  TEAM_THRESHOLD_UNCONFIRMED: OPEN_Q,
  TEAM_DEFAULT_WINDOW: OPEN_Q,
  ENTRY_LIMIT_TEAM_CHOICE: OPEN_Q,
  INCLUSIVITY_ASSUMED: OPEN_Q,
  CONTEXT_NOT_PROVIDED: [...OPEN_Q, ...NOTE],
};

function segs(p: string): string[] | undefined {
  return p.startsWith("/") ? p.slice(1).split("/") : undefined;
}

export function isPathAllowed(code: string, path: string): boolean {
  if (!Object.hasOwn(PATCH_PATHS, code)) return false;
  const p = segs(path);
  if (!p || p.some((s) => s === "__proto__" || s === "constructor" || s === "prototype")) return false;
  return PATCH_PATHS[code]!.some((pat) => {
    const q = segs(pat)!;
    return (
      p.length >= q.length &&
      q.every((s, i) => (s === "*" ? /^(\d+|-)$/.test(p[i]!) : s === p[i]))
    );
  });
}

const OPEN_Q_CODES = ["OPEN_QUESTION", "OPEN_QUESTION_NO_RESOLUTION", "OPEN_QUESTION_TRIVIAL_RESOLUTION"];

export interface GuardOp {
  op?: string;
  path: string;
  value?: unknown;
}

/**
 * Open questions: the agent may only answer a question routed to the program officer, and only by setting
 * its status to "resolved" and writing its resolution. The target's route_to is read from the model the
 * patch is applied to, never from the patch. route_to, id, question text and affects are never writable.
 */
function openQuestionOpAllowed(codes: readonly string[], o: GuardOp, model: { open_questions?: ReadonlyArray<{ route_to?: string }> }): boolean {
  if (!codes.some((c) => OPEN_Q_CODES.includes(c))) return false;
  const m = /^\/open_questions\/(0|[1-9]\d*)\/(status|resolution)$/.exec(o.path);
  if (!m) return false;
  const q = (model.open_questions ?? [])[Number(m[1])];
  if (!q || q.route_to !== "program_officer") return false;
  if (o.op !== "replace" && o.op !== "add") return false;
  return m[2] === "status" ? o.value === "resolved" : typeof o.value === "string";
}

/**
 * True when every op is allowed for at least one of the targeted finding codes. Pass the model the patch
 * applies to: ops under /open_questions are then judged by the target question's route_to.
 */
export function opsAllowed(codes: readonly string[], ops: readonly GuardOp[], model?: { open_questions?: ReadonlyArray<{ route_to?: string }> }): boolean {
  return ops.every((o) => opAllowed(codes, o, model));
}

function opAllowed(codes: readonly string[], o: GuardOp, model?: { open_questions?: ReadonlyArray<{ route_to?: string }> }): boolean {
  if (model !== undefined && o.path.startsWith("/open_questions")) return openQuestionOpAllowed(codes, o, model);
  return codes.some((c) => isPathAllowed(c, o.path));
}

/**
 * The allowed part of a patch: every op opsAllowed would accept on its own, with an open question's
 * status and resolution kept only as a pair (a question is never left resolved without its answer, or
 * answered but still open). `dropped` lists the paths left out. The kept ops still pass every later check.
 */
export function allowedOps<T extends GuardOp>(codes: readonly string[], ops: readonly T[], model: { open_questions?: ReadonlyArray<{ route_to?: string }> }): { kept: T[]; dropped: string[] } {
  const ok = ops.filter((o) => opAllowed(codes, o, model));
  const q = (o: GuardOp): { i: string; field: string } | undefined => {
    const m = /^\/open_questions\/(0|[1-9]\d*)\/(status|resolution)$/.exec(o.path);
    return m ? { i: m[1] as string, field: m[2] as string } : undefined;
  };
  const fields = new Map<string, Set<string>>();
  for (const o of ok) {
    const x = q(o);
    if (x) fields.set(x.i, (fields.get(x.i) ?? new Set()).add(x.field));
  }
  const kept = ok.filter((o) => {
    const x = q(o);
    return x === undefined || fields.get(x.i)?.size === 2;
  });
  return { kept, dropped: ops.filter((o) => !kept.includes(o)).map((o) => o.path) };
}
