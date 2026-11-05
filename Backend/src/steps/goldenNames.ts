import type { GoldenCase } from "../validation/context.js";

/**
 * The names the team's confirmed test cases use (DEC-020), as a hint for the fill prompt. The cases refer to
 * questions and results by exact id, but the AI draft names its own, so every case reported "expects a result
 * the draft does not have" and none could run. The hint gives the ids and what each result means, and says
 * nothing about which child gets which result: the cases stay an independent check, not a spec to write to.
 */
export function goldenNamingHint(cases: readonly GoldenCase[] | undefined): string | undefined {
  if (cases === undefined || cases.length === 0) return undefined;

  const questions = new Map<string, string>();
  for (const c of cases) {
    for (const [id, v] of Object.entries(c.answers)) {
      if (!questions.has(id)) questions.set(id, typeof v === "boolean" ? "yes_no" : "integer");
    }
  }

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
    "Do not add a question or a result only to use a name, and do not drop one the guideline needs because it is not listed.",
    "Question ids (id: answer_type):",
    ...[...questions].map(([id, t]) => `- ${id}: ${t}`),
    "Result ids (id: what it means):",
    ...[...results].map(([id, d]) => `- ${id}${d !== "" ? ": " + d : ""}`),
  ].join("\n");
}
