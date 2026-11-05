import { z } from "zod";
import { FindingSchema } from "./finding.js";
import type { Finding } from "./finding.js";
import { render } from "./messages.js";

/**
 * Flags: the findings of the cross-check (the comparison of two logic models), in the form the front end reads.
 * A flag is a Finding plus its message worded for each role and a status. The same builder is used by the pipeline (the
 * flags.json stored with each version, see signoff/checks.ts) and by scripts/crossCheckFlags.ts, so both give one format.
 */

const Messages = z.object({ clinician: z.string().min(1), program_officer: z.string().min(1) }).strict();

export const FlagSchema = FindingSchema.extend({
  /** The same text rendered for each role (the finding's own message is for its first audience). */
  messages: Messages,
  /** Every flag starts open; a person closes it (not built yet). */
  status: z.literal("open"),
}).strict();
export type Flag = z.infer<typeof FlagSchema>;

const Count = z.number().int().min(0);
export const FlagsSummarySchema = z
  .object({
    flagCount: Count,
    bySeverity: z.object({ blocking: Count, warning: Count, info: Count }).strict(),
    byCode: z.record(z.string(), Count),
    /** From the comparison's own summary finding; absent when the combinations were not compared. */
    compared: Count.optional(),
    differing: Count.optional(),
    skipped: Count.optional(),
    groups: Count.optional(),
  })
  .strict();
export type FlagsSummary = z.infer<typeof FlagsSummarySchema>;

const Sha = z.string().regex(/^[0-9a-f]{64}$/);

/** The document stored per version (artifact "flags") and served by GET /runs/:id/versions/:n/flags. */
export const FlagsDocumentSchema = z
  .object({
    mode: z.literal("logic_models"),
    runId: z.string().min(1),
    /** The version whose content was checked first with these inputs. */
    n: z.number().int().min(1),
    modelSha: Sha,
    checksVersion: z.string().min(1),
    inputsSha: Sha,
    /** ran: both drafts were compared. not_run: no second draft was supplied. second_draft_invalid: it could not be read. */
    comparison: z.enum(["ran", "not_run", "second_draft_invalid"]),
    /** modelSha of the second draft, when it could be read. */
    secondDraftSha: Sha.nullable(),
    /**
     * How many of the confirmed test cases each draft gets right (the same check on both). The cross-check cannot say which draft is
     * right; the cases, written by people, can. Absent when there is no second draft or no cases.
     */
    golden: z.object({ cases: z.number().int().min(0), first: z.number().int().min(0), second: z.number().int().min(0) }).nullable().optional(),
    checkedAt: z.number(),
    summary: FlagsSummarySchema,
    notice: z.string().min(1),
    flags: z.array(FlagSchema),
  })
  .strict();
export type FlagsDocument = z.infer<typeof FlagsDocumentSchema>;

export const FLAGS_NOTICE =
  "No flags means the two drafts agree. It does not mean either is right; both could repeat the same mistake, and a person still reviews the draft. Every flag here is a warning decided by the clinician; none blocks signing.";

const SEVERITY_RANK = { blocking: 0, warning: 1, info: 2 } as const;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Findings to flags: most severe first, then by code and id, so the same findings always give the same list. */
export function buildFlags(findings: readonly Finding[]): { flags: Flag[]; summary: FlagsSummary } {
  const sorted = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || cmp(a.code, b.code) || cmp(a.id, b.id));
  const flags: Flag[] = sorted.map((f) => ({
    ...f,
    messages: { clinician: render(f.code, f.params, "clinician"), program_officer: render(f.code, f.params, "program_officer") },
    status: "open" as const,
  }));
  const bySeverity = { blocking: 0, warning: 0, info: 0 };
  const byCode: Record<string, number> = {};
  for (const f of flags) {
    bySeverity[f.severity]++;
    byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  }
  const s = flags.find((f) => f.code === "CROSS_CHECK_SUMMARY");
  const num = (k: string): number | undefined => (typeof s?.params[k] === "number" ? (s.params[k] as number) : undefined);
  const optional = (k: "compared" | "differing" | "skipped" | "groups"): Partial<FlagsSummary> => (num(k) !== undefined ? { [k]: num(k) as number } : {});
  return {
    flags,
    summary: { flagCount: flags.length, bySeverity, byCode, ...optional("compared"), ...optional("differing"), ...optional("skipped"), ...optional("groups") },
  };
}
