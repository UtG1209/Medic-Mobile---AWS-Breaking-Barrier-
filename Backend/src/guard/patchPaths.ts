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
// Codes whose allowed paths are the citation paths (SOURCES, which include /open_questions/*/source).
const CITATION_CODES: ReadonlySet<string> = new Set(Object.keys(PATCH_PATHS).filter((c) => PATCH_PATHS[c] === SOURCES));
// A citation (page, quote) of an open question: /open_questions/N/source and below.
const OPEN_QUESTION_SOURCE = /^\/open_questions\/(0|[1-9]\d*|-)\/source(\/|$)/;

export function opsAllowed(codes: readonly string[], ops: readonly GuardOp[], model?: { open_questions?: ReadonlyArray<{ route_to?: string }> }): boolean {
  return ops.every((o) => {
    if (model !== undefined && o.path.startsWith("/open_questions")) {
      // A citation under an open question is an ordinary citation: fixable for the citation codes, as SOURCES lists it.
      // (Without this the special case below refused it, so a wrong quote in an open question could never be fixed.)
      if (OPEN_QUESTION_SOURCE.test(o.path)) return codes.some((c) => CITATION_CODES.has(c) && isPathAllowed(c, o.path));
      return openQuestionOpAllowed(codes, o, model);
    }
    return codes.some((c) => isPathAllowed(c, o.path));
  });
}
