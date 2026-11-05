import { z } from "zod";
import { InvalidUserId, isReservedUserId, normaliseUserId } from "../signoff/identity.js";

export const RunState = z.enum([
  "created",
  "ingesting",
  "extracting",
  "filling_logic",
  "in_review",
  "checking",
  "awaiting_officer",
  "awaiting_clinician",
  "locked",
  "failed",
]);
export type RunState = z.infer<typeof RunState>;

// Sign-off (BRD AR-01 to AR-10, DEC-019). The two roles that sign a version, officer first.
export const SignerRole = z.enum(["program_officer", "clinician"]);
export type SignerRole = z.infer<typeof SignerRole>;

// A signer's id, normalised (NFKC, invisible characters removed, trimmed, lower case) and restricted
// to [a-z0-9._@-], so "Alice", " alice" and fullwidth "ａｌｉｃｅ" are one person (signoff/identity.ts, DEC-020).
// AUTH SEAM (DEC-015, not built): bind this to the Cognito token's `sub` instead of the body.
export const UserId = z
  .string()
  .max(512)
  .transform((raw, ctx) => {
    try {
      const id = normaliseUserId(raw);
      // DEC-038: the officer agent's id can never arrive in a request body.
      if (isReservedUserId(id)) {
        ctx.addIssue({ code: "custom", message: "this userId is reserved for the officer agent" });
        return z.NEVER;
      }
      return id;
    } catch (e) {
      ctx.addIssue({ code: "custom", message: e instanceof InvalidUserId ? e.message : "invalid userId" });
      return z.NEVER;
    }
  });

// AUTH SEAM (DEC-015, not built): role and userId are passed in the body for now. When Cognito is
// added they come from the verified token instead, and these two fields are dropped from the body.
export const SignRequest = z
  .object({
    role: SignerRole,
    userId: UserId,
    // The modelSha the signer reviewed (from the findings or status response). A different sha means
    // the content changed since they looked: the signature is refused (AR-07).
    modelSha: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type SignRequest = z.input<typeof SignRequest>;

// The clinician rejects a version with a comment on the rule (BRD AR-06), optionally marking the needed
// change urgent (RR-02). The version stays in the history and can never be signed or released; the
// officer's fix is a new version. AUTH SEAM as for SignRequest.
export const RejectRequest = z
  .object({
    role: z.literal("clinician"),
    userId: UserId,
    modelSha: z.string().regex(/^[0-9a-f]{64}$/),
    comment: z.string().trim().min(15).max(5000),
    // The rule or item the comment is about, for example "rules.R3".
    itemRef: z.string().min(1).max(500).optional(),
    urgent: z.boolean().default(false),
  })
  .strict();
export type RejectRequest = z.input<typeof RejectRequest>;

// The clinician accepts blocking findings they decide ("keep": this is correct) with a reason. The acceptance is
// recorded with their name and counts for the findings with those ids. AUTH SEAM as for SignRequest.
export const AcknowledgeRequest = z
  .object({
    role: z.literal("clinician"),
    userId: UserId,
    findingIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(200),
    note: z.string().trim().min(15).max(5000),
  })
  .strict();
export type AcknowledgeRequest = z.input<typeof AcknowledgeRequest>;

// Revision loop. AUTH SEAM (DEC-015): role and userId from the body until Cognito, as for SignRequest.
// Step 1: ask the AI to turn the comments on a version into a revision instruction.
export const CreateRevisionRequest = z
  .object({
    role: SignerRole,
    userId: UserId,
    // Restrict to the comments on these items (for example "rules.R3"); default: every comment.
    itemRefs: z.array(z.string().min(1).max(500)).min(1).max(200).optional(),
  })
  .strict();
export type CreateRevisionRequest = z.input<typeof CreateRevisionRequest>;

// Step 2: confirm the instruction (optionally as the person edited it) so the AI proposes edits.
// Answers 202 with the revision in status "applying"; the work runs in the background and the client polls
// GET /runs/:id/revisions/:rid until the status is applied, no_change or failed.
export const ConfirmRevisionRequest = z
  .object({
    role: SignerRole,
    userId: UserId,
    instruction: z.string().trim().min(15).max(5000).optional(),
  })
  .strict();
export type ConfirmRevisionRequest = z.input<typeof ConfirmRevisionRequest>;

export const FindingsQuery = z.object({ audience: SignerRole.optional() }).strict();
export type FindingsQuery = z.infer<typeof FindingsQuery>;

export const CreateRunRequest = z.object({
  pages: z
    .array(z.number().int().positive())
    .min(1, { message: "pages must not be empty; omit pages to use every page" })
    .refine((p) => new Set(p).size === p.length, { message: "pages must not contain duplicates" })
    .optional(),
  filename: z.string().min(1).max(255),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const CreateRunResponse = z.object({
  runId: z.string(),
  uploadUrl: z.string(),
});
export type CreateRunResponse = z.infer<typeof CreateRunResponse>;

export const SaveVersionRequest = z.object({
  parentVersion: z.number().int().nonnegative(),
  body: z.unknown(),
  author: z.string().min(1).max(200).refine((a) => !isReservedUserId(a), { message: "this author is reserved for the officer agent" }),
  // The role the author saves in (DEC-020): an open question counts as answered only in a version saved
  // by the role it is routed to. AUTH SEAM (DEC-015): from the token's group once Cognito is built.
  authorRole: SignerRole.optional(),
});
export type SaveVersionRequest = z.infer<typeof SaveVersionRequest>;

export const CreateCommentRequest = z.object({
  itemRef: z.string().min(1).max(500),
  text: z.string().min(1).max(10000),
  author: z.string().min(1).max(200).refine((a) => !isReservedUserId(a), { message: "this author is reserved for the officer agent" }),
});
export type CreateCommentRequest = z.infer<typeof CreateCommentRequest>;

// Amazon Bedrock AgentCore Runtime HTTP protocol: GET /ping and POST /invocations.
export const PingResponse = z.object({
  status: z.enum(["Healthy", "HealthyBusy"]),
  time_of_last_update: z.number().int().nonnegative().optional(),
});
export type PingResponse = z.infer<typeof PingResponse>;

export const INVOCATION_MAX_BODY_BYTES = 1024 * 1024;

export const InvocationRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("uploaded"), runId: z.string().regex(/^[A-Za-z0-9-]+$/).max(128) }),
  z.object({ action: z.literal("resume_all") }),
  z.object({
    action: z.literal("http"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().max(2048).startsWith("/"),
    headers: z
      .record(z.string().max(256), z.string().max(8192))
      .refine((h) => Object.keys(h).length <= 20, { message: "at most 20 headers" })
      .optional(),
    body: z.string().max(INVOCATION_MAX_BODY_BYTES).optional(),
  }),
]);
export type InvocationRequest = z.infer<typeof InvocationRequest>;

export const InvocationResponse = z.union([
  z.object({ accepted: z.literal(true) }),
  z.object({ statusCode: z.number().int(), headers: z.record(z.string(), z.string()), body: z.string() }),
]);
export type InvocationResponse = z.infer<typeof InvocationResponse>;

// Lambda Web Adapter pass-through: non-HTTP events (SQS, EventBridge schedule) arrive as POST /events.
export const LAMBDA_MAX_SQS_RECORDS = 100;

export const LambdaSqsRecord = z
  .object({ messageId: z.string().min(1).max(256), body: z.string().max(1024 * 1024) })
  .passthrough();
export type LambdaSqsRecord = z.infer<typeof LambdaSqsRecord>;

// Top level only: each record is validated on its own so one bad record cannot reject a batch.
export const LambdaSqsEnvelope = z.object({ Records: z.array(z.unknown()).min(1).max(LAMBDA_MAX_SQS_RECORDS) });
export type LambdaSqsEnvelope = z.infer<typeof LambdaSqsEnvelope>;

export const LambdaSqsEvent = z.object({ Records: z.array(LambdaSqsRecord).min(1).max(LAMBDA_MAX_SQS_RECORDS) });
export type LambdaSqsEvent = z.infer<typeof LambdaSqsEvent>;

export const LambdaScheduledEvent = z
  .object({ source: z.string().optional(), "detail-type": z.string().optional() })
  .passthrough()
  .refine((e) => e.source === "aws.events" || e["detail-type"] === "Scheduled Event", {
    message: "not a scheduled event",
  });
export type LambdaScheduledEvent = z.infer<typeof LambdaScheduledEvent>;

// The revision loop's asynchronous self-invoke (lambda mode): runs step 2 of a confirmed revision.
// Sent by LambdaAsyncDispatcher (src/revision/dispatch.ts); not an AWS event.
export const LambdaRevisionEvent = z
  .object({ source: z.literal("revision"), runId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), revisionId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/) })
  .strict();
export type LambdaRevisionEvent = z.infer<typeof LambdaRevisionEvent>;

// Officer agent asynchronous self-invoke (lambda mode): runs the officer agent after a version is saved.
// Decouples the agent from the POST /versions response so API Gateway's 30 s timeout is not hit.
export const LambdaOfficerEvent = z
  .object({ source: z.literal("officer"), runId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) })
  .strict();
export type LambdaOfficerEvent = z.infer<typeof LambdaOfficerEvent>;

// Pipeline hand-off (lambda mode): the next step of a run, in a fresh invocation with its own 15 minutes.
export const LambdaContinueEvent = z
  .object({ source: z.literal("continue"), runId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) })
  .strict();
export type LambdaContinueEvent = z.infer<typeof LambdaContinueEvent>;

export const LambdaEvent = z.union([LambdaSqsEvent, LambdaScheduledEvent, LambdaRevisionEvent, LambdaOfficerEvent, LambdaContinueEvent]);
export type LambdaEvent = z.infer<typeof LambdaEvent>;

export const LambdaEventResponse = z.object({
  batchItemFailures: z.array(z.object({ itemIdentifier: z.string() })),
});
export type LambdaEventResponse = z.infer<typeof LambdaEventResponse>;

// Clinician features (activity, chat, tree edits, restore). AUTH SEAM as for SignRequest: role and userId come from the body.
export const ActivityQuery = z.object({ after: z.coerce.number().int().nonnegative().optional() }).strict();
export type ActivityQuery = z.infer<typeof ActivityQuery>;

export const ChatRequest = z
  .object({
    userId: UserId,
    role: z.literal("clinician"),
    messages: z.array(z.object({ from: z.enum(["user", "assistant"]), text: z.string().min(1).max(4000) }).strict()).min(1).max(20),
    // What the clinician has open on screen (the review page): the answers are grounded in it, not in the chat history.
    context: z
      .object({
        version: z.number().int().min(1),
        /** Edits on the page that are not saved yet: a keep would replace them, so it is refused. */
        unsavedEdits: z.boolean().optional(),
        selected: z.string().max(200).optional(),
        /** JSON of the selected rule, question, result or value as loaded on the page (unsaved edits included). */
        selectedItem: z.string().max(8000).optional(),
        /** n = the number the clinician sees on the question card ("Question 11 of 14"). */
        openQuestions: z.array(z.object({ n: z.number().int().min(1).optional(), id: z.string().min(1).max(200), title: z.string().max(500), answered: z.boolean() }).strict()).max(60),
        findings: z.array(z.object({ severity: z.string().max(20), message: z.string().max(600) }).strict()).max(80),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ChatRequest = z.input<typeof ChatRequest>;

// The closed set of tree edits (src/edit/treeEdits.ts). Any other op is refused with 422 unsupported_edit.
export const TreeEditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("setQuestionLabel"), questionId: z.string().min(1).max(200), text: z.string().min(1).max(2000) }).strict(),
  z.object({ op: z.literal("setThreshold"), questionId: z.string().min(1).max(200), ruleId: z.string().min(1).max(200), from: z.number().finite(), to: z.number().finite() }).strict(),
  z.object({ op: z.literal("setOutcomeText"), ruleId: z.string().min(1).max(200), field: z.enum(["title", "action"]), actionIndex: z.number().int().nonnegative().optional(), text: z.string().min(1).max(4000) }).strict(),
  z.object({ op: z.literal("setFollowUpDays"), ruleId: z.string().min(1).max(200), days: z.number().int().min(0).max(3650) }).strict(),
]);
export type TreeEditInput = z.infer<typeof TreeEditSchema>;

export const PreviewEditsRequest = z
  .object({ userId: UserId, role: z.literal("clinician"), edits: z.array(TreeEditSchema).min(1).max(50) })
  .strict();
export type PreviewEditsRequest = z.input<typeof PreviewEditsRequest>;

export const SaveEditsRequest = z
  .object({ userId: UserId, role: z.literal("clinician"), edits: z.array(TreeEditSchema).min(1).max(50), modelSha: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
export type SaveEditsRequest = z.input<typeof SaveEditsRequest>;

export const RestoreRequest = z.object({ userId: UserId, role: z.literal("clinician") }).strict();
export type RestoreRequest = z.input<typeof RestoreRequest>;
