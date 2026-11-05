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

/** The draft's questions that the confirmed cases do not answer (by id). The cases cannot run on a draft that asks one. */
export function extraQuestions(draft: readonly { id: string }[], required: readonly RequiredQuestion[]): string[] {
  const ids = new Set(required.map((r) => r.id));
  return draft.filter((q) => !ids.has(q.id)).map((q) => q.id);
}

/** The text of the one correction call: what is missing, what is extra, and how to put it right. */
export function namingRepairText(missing: readonly RequiredQuestion[], extra: readonly string[] = []): string {
  const lines: string[] = [];
  if (missing.length > 0) {
    lines.push(
      "The team's confirmed test cases answer these questions by id and answer type, and your draft does not have them:",
      ...missing.map((q) => `- ${q.id} (${q.answer_type})`),
      "Add them, or rename the draft's question for the same thing, with exactly these ids and answer types.",
      "A cut-off on a number (for example 14 days or more) is a threshold on the number question, not a yes/no question of its own: ask the number and read the cut-off from it.",
    );
  }
  if (extra.length > 0) {
    lines.push(
      "Your draft asks these questions, which the confirmed test cases do not answer, so the cases cannot be run on it:",
      ...extra.map((id) => `- ${id}`),
      "The form asks exactly the questions the test cases answer and no others. Remove each of these questions and take it out of every rule and derived item that reads it. A sign the guideline lists but this form does not ask is left out; the clinician is told which.",
    );
  }
  lines.push("Return the whole corrected draft as one JSON object. Change only what this needs.");
  return lines.join("\n");
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
    "The form asks exactly the questions listed below, with exactly these ids and answer types, and no other question: the cases answer these and nothing else, so any other question would stop them from running.",
    "A sign the guideline lists that has no question below is left out of the form; the clinician is told which.",
    "A cut-off on a number (for example 14 days or more) is a threshold on the number question, not a yes/no question of its own: ask the number and read the cut-off from it.",
    "When your draft has a result for the same thing as one of the results below, give it exactly this id. Results the guideline needs that are not listed may be added.",
    "Question ids (id: answer_type):",
    ...[...questions].map(([id, t]) => `- ${id}: ${t}`),
    "Result ids (id: what it means):",
    ...[...results].map(([id, d]) => `- ${id}${d !== "" ? ": " + d : ""}`),
  ].join("\n");
}
