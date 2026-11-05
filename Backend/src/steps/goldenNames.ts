import type { GoldenCase } from "../validation/context.js";

/**
 * The names the team's confirmed test cases use (DEC-020), as a hint for the fill prompt. The cases refer to
 * questions and results by exact id, but the AI draft names its own, so every case reported "expects a result
 * the draft does not have" and none could run. The hint gives the ids and what each result means, and says
 * nothing about which child gets which result: the cases stay an independent check, not a spec to write to.
 */
export interface RequiredQuestion {
  id: string;
  answer_type: "yes_no" | "integer";
}

/** The questions the cases answer, by id and answer type (a number is an integer, anything else yes_no). */
export function goldenQuestions(cases: readonly GoldenCase[] | undefined): RequiredQuestion[] {
  const out = new Map<string, RequiredQuestion["answer_type"]>();
  for (const c of cases ?? []) {
    for (const [id, v] of Object.entries(c.answers)) if (!out.has(id)) out.set(id, typeof v === "boolean" ? "yes_no" : "integer");
  }
  return [...out].map(([id, answer_type]) => ({ id, answer_type }));
}

/** The required questions the draft does not have under that id and answer type. */
export function missingQuestions(draft: readonly { id: string; answer_type: string }[], required: readonly RequiredQuestion[]): RequiredQuestion[] {
  return required.filter((r) => !draft.some((q) => q.id === r.id && q.answer_type === r.answer_type));
}

/** The text of the one correction call: what is missing and how to put it right. */
export function namingRepairText(missing: readonly RequiredQuestion[]): string {
  return [
    "The team's confirmed test cases answer these questions by id and answer type, and your draft does not have them:",
    ...missing.map((q) => `- ${q.id} (${q.answer_type})`),
    "Add them, or rename the draft's question for the same thing, with exactly these ids and answer types.",
    "A cut-off on a number (for example 14 days or more) is a threshold on the number question, not a yes/no question of its own: ask the number and read the cut-off from it.",
    "Return the whole corrected draft as one JSON object. Change only what this needs.",
  ].join("\n");
}

export function goldenNamingHint(cases: readonly GoldenCase[] | undefined): string | undefined {
  if (cases === undefined || cases.length === 0) return undefined;

  const questions = new Map(goldenQuestions(cases).map((q) => [q.id, q.answer_type] as const));

  const results = new Map<string, string>();
  for (const c of cases) {
    if (results.has(c.expected_outcome)) continue;
    const note = c.note ?? "";
    const i = note.indexOf("Expected decision:");
    results.set(c.expected_outcome, i >= 0 ? note.slice(i + "Expected decision:".length).trim() : "");
  }

  return [
    "Names used by the team's confirmed test cases. The cases only check your draft; this does not say which child gets which result.",
    "When your draft has a question or a result for the same thing as one below, give it exactly this id (do not rename it).",
    "Ask every question below that the guideline's logic uses, with exactly this id and answer type.",
    "A cut-off on a number (for example 14 days or more) is a threshold on the number question, not a yes/no question of its own: ask the number and read the cut-off from it.",
    "Do not add a question or a result only to use a name, and do not drop one the guideline needs because it is not listed.",
    "Question ids (id: answer_type):",
    ...[...questions].map(([id, t]) => `- ${id}: ${t}`),
    "Result ids (id: what it means):",
    ...[...results].map(([id, d]) => `- ${id}${d !== "" ? ": " + d : ""}`),
  ].join("\n");
}
