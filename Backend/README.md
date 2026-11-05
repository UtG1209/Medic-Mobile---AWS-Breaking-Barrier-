# Orchestrator

Backend service that takes an uploaded clinical guideline PDF through a fixed flow (ingest, extract, fill logic, automatic checks), then through sign-off (program officer, then clinician, then lock; DEC-019), stores every run, step, version, comment and audit event in DynamoDB and S3, and exposes an HTTP API for the UI to create runs, save edited versions, comment and resume. Uploads are detected through an S3 event notification delivered to SQS.

## Develop

```
npm ci
npm test              # vitest run
npx tsc --noEmit      # typecheck
npm run build         # emits dist/ (tests excluded)
npm start             # node dist/index.js
npm run dev           # tsx watch src/index.ts
npm run dev:local     # the API with no AWS: in memory, fake model, CORS for the UI on :5173 (scripts/devLocal.ts)
npm run compile:demo  # logic model fixture -> CHT project -> real cht-conf (see compile-demo/README.md)
npm run pipeline:demo # whole chain with sign-off rules, in memory, FakeModelClient (see "Sign-off" below)
npm run compile:locked -- --run <id> --version <n> --settings <file> [--out <dir>]  # compile job (DynamoDB + S3)
```

## Sign-off (src/signoff, DEC-019)

Humans approve; code enforces BRD AR-01 to AR-10. Run states after fill_logic: `checking` (the `checks` step runs `runChecks` and stores the findings) -> `awaiting_officer` -> `awaiting_clinician` -> `locked`. Every version saved through the API goes back through `checking` to `awaiting_officer` (from any review state, `locked` included), via `onVersionSaved`.

- Findings: one artifact per content, `runs/<id>/checks/<modelSha>.json`, with every finding, the gates and the plain-language view per audience (`findingsFor`). Computed again on demand when missing, so a crash between save and check never lets a version be signed unchecked.
- Signature record `{runId, n, modelSha, role, userId, signedAt}` appended to the version item by `Store.addSignature`, an atomic conditional write (DynamoDB: a transaction with a ConditionCheck that the version is still the latest). The request names the `modelSha` the signer reviewed; any other sha is refused.
- Rules: officer first, clinician second (409 `officer_signature_required`); two different people (403 `separation_of_duties`); refused while the role's gate has blocking findings (422 `blocked`, with the blockers in plain words; officer: officer-owned blockers, clinician: clinical blockers including open questions routed to the clinician; an open question is settled by marking it resolved with a written resolution in a new version); only the latest version can be signed (409 `superseded`); a locked version takes no signature (409 `locked`); role in the body must match the endpoint (403 `role_mismatch`). Both signatures on the same sha set `status: "locked"`; a later save is a new version with zero signatures and the locked one stays the releasable one (`latestLocked` in the status view, AR-09).
- AUTH SEAM: `role` and `userId` come from the request body until Cognito is built (DEC-015). Separation of duties therefore holds only against honest callers for now.
- Compile guard: `compileSnapshot` with `buildKind: "release"` needs `approval: { snapshotSha, version }` and re-checks the lock evidence (`verifyLock`); `compileLockedVersion` (src/compiler/compileLocked.ts) reads it from the store. Preview builds stay unguarded and are stamped "not approved, not deployable".
- Compile is NOT a Lambda step (DEC-014). `scripts/compileLocked.ts` is the job for the build host (EC2, not built): it refuses an unlocked version before touching its output folder, builds the release project, runs cht-conf through `compile-demo/chtConf.ts` (shared with compile:demo) and stores the manifest and cht-conf outputs under `runs/<id>/compile/<modelSha>/`. Exit codes 0 pass, 2 usage, 3 refused, 4 cht-conf failed, 5 cht-conf not installed.
- `npm run pipeline:demo` runs the whole chain with the in-memory store and writes `pipeline-demo/output/` (TRACE.md, findings, summary, the locked version and the compiled project). Its edits come from `tests/helpers/resolveForDemo.ts`, which is TEST-ONLY: its answers to the open questions are placeholders, not clinical decisions. Without `compile-demo/tools` installed the cht-conf part is skipped with a message.

## CHT compiler (src/compiler)

`compileSnapshot(model, { projectDir, buildKind, settings, approval?, flowLimits? })` turns a parsed logic model (v1.json shape, DEC-017) into a CHT project directory that cht-conf compiles: `forms/app/<pathway_id>.xlsx` and `.properties.json`, `tasks.js` (scheduled follow-ups only), `targets.js`, `contact-summary.templated.js`, `app_settings/base_settings.json`, `.eslintrc`, `translations/messages-en.properties`, `sourcemap.json` and a README. It returns a manifest (file sha256s, formId, modelSha, buildKind, warnings, notCompiled, flow, sourcemap) and refuses with a `CompileError` (`result.compile_ready === false`, every missing field listed) when something it needs is absent. Compiler settings (form title, icon, team default task window, contact types, flowMode) are a separate settings JSON, not part of the model or of modelSha. Static project files are in `src/compiler/template/` (copied to `dist/` by `npm run build`). `npm run compile:demo` runs the real cht-conf 6.6.1 against the output; it is not part of `npm test`.

### Question flow (which questions the form asks)

The form shows one question per screen. By default it asks only the questions whose answer can still change the outcome. `deriveFlow` (src/logic/flow.ts) works this out from the rule table at compile time. The flow is not part of the signed model. It is a deterministic artefact: anyone can rebuild it from modelSha, the flow mode and `FLOW_DERIVATION_VERSION` (currently `flow-2-is_no`). Its conditions use a flow-only type, `FlowCondition`. This type has the model's atoms plus `is_no`, which is true only when the answer is no; a blank answer never counts as no. It also has the constant `"never"`. The model's own condition vocabulary (is_yes, at_least, less_than, all, any) is unchanged. The compiler emits `is_no` as `${f} = 'no'` (never `not()`) and `"never"` as `false()`. Each question row and its page group get the authored shown_when AND the flow condition, so a skipped question's screen disappears.

`settings.flowMode` picks the flow, and the clinician chooses it:

- `minimal` (default): only the questions that can still change the outcome. On the v1 grid (6,400 points) this averages 4.67 questions instead of 8.92.
- `danger_signs_always`: like minimal, but every danger-sign question is always asked (8.20).
- `full`: the authored shown_when only, as before (8.92).

Under the final 7-rule model, rule R1 sends a child outside 2 to 59 months who has a danger sign to urgent referral (`refer_urgent_outside_age_range`), so the minimal flow still asks every child about cough and the danger signs. A 1-month-old with convulsions is asked about convulsions and is referred urgently; the old Q2 hazard (a lower-severity out-of-range result hiding a danger sign) is gone. `danger_signs_always` is kept for models where a rule can decide the outcome before a danger sign is asked.

Before emitting, `compileSnapshot` runs `verifyFlow` on every point of the exact answer grid. The short form must give the same outcome as answering every question. Any mismatch is refused with a `CompileError`, and so is a flow too large to derive (`flowLimits`). The manifest (`flow`), the project README and `sourcemap.json` record flowMode, the derivation version, the flow stats and the average question counts. The sourcemap marks question rows that carry a flow condition with `flowCondition`. The saved answer of a skipped question is blank.

## Environment variables

| Name | Required / default | Purpose |
| --- | --- | --- |
| TABLE_RUNS | required | DynamoDB table for runs |
| TABLE_STEPS | required | DynamoDB table for step records |
| TABLE_VERSIONS | required | DynamoDB table for logic model versions |
| TABLE_COMMENTS | required | DynamoDB table for comments |
| TABLE_AUDIT | required | DynamoDB table for the audit log |
| ARTIFACT_BUCKET | required | S3 bucket for uploads and step artifacts |
| RUN_MODE | container | `container` (SQS consumer and resume sweep run in-process), `agentcore` (see Running on AgentCore) or `lambda` (see Running on Lambda; LEASE_MS defaults to 960000 and must exceed 900000 there; the Docker `lambda` target sets it). Any other value fails startup |
| MODEL_BACKEND | bedrock | `bedrock` (Strands in this process) or `agentcore` (see Model backend). Any other value fails startup |
| AGENTCORE_RUNTIME_ARN | required when MODEL_BACKEND=agentcore | ARN of the AgentCore Runtime running the AgentService (service `bedrock-agentcore`); ignored otherwise |
| UPLOAD_QUEUE_URL | required when RUN_MODE=container (not used by agentcore or lambda) | SQS queue receiving S3 ObjectCreated notifications |
| MODEL_ID | required | Bedrock inference profile ID (us. prefix) |
| AWS_REGION | us-west-2 | AWS region for all clients |
| PORT | 8080 | HTTP port |
| HOST | 0.0.0.0 | HTTP bind address |
| LEASE_MS | 900000 | Run lease duration; must exceed the longest single step |
| MAX_PAGES | 200 | Maximum page number accepted when creating a run, and the largest page count (`pdfinfo`, whole document) ingest will render |
| MAX_PDF_BYTES | 52428800 | Largest input PDF ingest will download (S3 HeadObject size check before the download); over it the step fails permanently |
| SQS_CONCURRENCY | 4 | Messages processed in parallel |
| SHUTDOWN_TIMEOUT_MS | 25000 | On SIGTERM/SIGINT, how long to wait for in-flight upload handling before closing the server and exiting 0 |
| PYTHON_BIN | python3 | Python executable for ingest |
| INGEST_SCRIPT | extraction/prepare_input.py next to the build | Ingest script path |
| EXTRACT_PROMPT | extraction/final_prompt.txt next to the build | Extraction system prompt path |
| FILL_PROMPT | extraction/fill_prompt.txt next to the build | fill_logic (draft) system prompt path |
| REVISE_INSTRUCTION_PROMPT | extraction/revise_instruction_prompt.txt next to the build | Revision loop step 1 (comments to instruction) system prompt path |
| REVISE_PROMPT | extraction/revise_prompt.txt next to the build | Revision loop step 2 (edit proposal) prompt path; the static addendum that follows the original fill prompt in `system` (the confirmed instruction goes in a delimited data block, not here) |
| FILL_MODEL_ID | MODEL_ID | Bedrock model for the fill_logic draft. Infra grants Bedrock access to MODEL_ID only, so a different value also needs the IAM policy widened |
| GOLDEN_CASES_PATH | tests/fixtures/logic/golden-testcases.json (GF01 to GF12 Medic confirmed, g01 to g20 awaiting Medic; TODO DEC-020) | Golden cases for the checks when the run has no `runs/<id>/inputs/golden_cases.json`. `none` switches them off; a set path that is missing is an error. Missing default (Lambda image): the findings say the test-case check did not run |
| COMPILE_SETTINGS_PATH | compile-demo/settings.demo.json (TODO DEC-020) | Compile settings for the checks when the run has no `runs/<id>/inputs/compile_settings.json`. Their sha256 is recorded on each signature; a release build must use the same settings |
| CROSS_CHECK_MODEL_PATH | not set (DEC-035) | A second, independent logic model for the cross-check comparison, used when the run has no `runs/<id>/inputs/cross_check_model.json`. `none` switches it off; a set path that is missing is an error. Without a second draft the comparison does not run and the findings say so. Its differences are warnings decided by the clinician and never block signing |
| PRICES_JSON | none | JSON map of model ID to `{inPerMTok, outPerMTok}` for cost metrics. A configured model with no entry is logged at startup and named in `unpricedModels` |
| RUN_BUDGET_USD | none | Optional cap on the recorded cost of one run (step records plus revision calls). When reached, the next attempt is refused with `Run budget exceeded` and the run fails; raise the cap and resume. Counts step records plus revision model calls. Infra context key `runBudgetUsd` sets it |
| CHAT_MAX_TOKENS | 200000 | Per-run chat token cap, used when PRICES_JSON has no price for the chat model |
| OFFICER_AGENT_MODEL_ID | MODEL_ID | Model of the officer agent |
| OFFICER_AGENT_MAX_COST_USD | 2 | Max model cost per run for the officer agent |

Startup fails with a list of the names of any missing required variables.

## Revision loop (comments -> AI -> new version)

Officer and clinician comments on a logic model version can be turned into a new version in two steps. Types: `src/revision/types.ts`.

1. Instruction. `POST /runs/:id/versions/:n/revisions` (body: `userId`, `role`, optional `itemRefs` to use only the comments on those items) gathers the comments on version n (and a rejection comment, if any), and the model writes a revision instruction in plain words plus its reading of each comment. The result is stored with status `instruction_ready` and shown to the person, who can edit it. `GET /runs/:id/versions/:n/revisions` lists the revisions of a version and `GET /runs/:id/revisions/:rid` reads one.
2. Confirm, then poll. `POST /runs/:id/revisions/:rid/confirm` (body: `userId`, `role`, optionally the edited `instruction`, 15 to 5000 characters) answers **202** at once with the revision in status `applying`. The work (model call, edits, new version, checks) runs in the background because API Gateway cuts an HTTP request at 30 seconds. The UI polls `GET /runs/:id/revisions/:rid` (small requests, for example every 2 to 3 seconds) until `status` is `applied`, `no_change` or `failed`. Step 2 sends the model the ORIGINAL fill prompt followed by the static revise addendum (`REVISE_PROMPT`) as `system`; the comments and the confirmed instruction go in delimited data blocks of the user content, never into `system`. The model proposes structured edits; deterministic code applies them to the current model and saves a new version (author `ai`, `meta.created_by` `ai_draft`, `meta.version` = n+1, `meta.parent_version` = n). Before saving, the service validates the engine's model with the same validator as the API and checks those two meta numbers; if either fails the revision is `failed` and nothing is saved. The saved version then goes through `onVersionSaved` (checks, back to `awaiting_officer`). Step 1 stays synchronous (one small call).

What the UI should show: `instruction_ready` the instruction with an edit box and a Confirm button; `applying` a progress state (disable Confirm); `applied` the list `applied`, `refused`, `questionsAdded` and a link to version `toVersion`; `no_change` the same lists and "nothing could be changed"; `failed` the `error` text and a Confirm again button. A step 1 call that fails (502) still leaves a `failed` revision (empty `instruction`, listed, its cost counted); the 502 body carries its `revisionId`; confirm it only with a new `instruction`.

Stale `applying`: if the background step never finishes (the process died, the Lambda was killed), a revision still `applying` more than `APPLYING_STALE_MS` (13 minutes, `src/revision/types.ts`; longer than the 12 minute revision lease so confirm does not answer `busy`) after `applyingSince` is reported as `failed` with the error "The background step did not finish; confirm again." by every read (GET one, list, confirm); confirm then works again. A revision can also stay `applying` until then when the run lease was busy for every retry of the worker (a check run or a signature held it), the process was killed, or the Lambda call was lost; nothing retries it automatically. The correction is computed on read and written with the next confirm.

How step 2 is started (`src/revision/dispatch.ts`): in `container` and `agentcore` modes `InProcessDispatcher` runs `RevisionService.runApply` after the response in the same process (an in-flight set; graceful shutdown waits for it within `SHUTDOWN_TIMEOUT_MS`). In `lambda` mode the process is frozen once the response is sent, so `LambdaAsyncDispatcher` invokes the SAME function asynchronously (`@aws-sdk/client-lambda` `InvokeCommand`, `InvocationType: "Event"`, function name from `AWS_LAMBDA_FUNCTION_NAME`, which the Lambda runtime sets) with the payload `{"source":"revision","runId":"...","revisionId":"..."}`. The Lambda Web Adapter forwards it to `POST /events`, which calls `runApply`, waits for it (14 minute deadline, like the other events) and answers `200 {"ok":true}`. It answers 200 even after a failure, because `runApply` records `failed` on the revision itself and a 5xx would only make Lambda retry. The function's role needs `lambda:InvokeFunction` on its own ARN. `runApply` is idempotent: it does nothing unless the revision is `applying`, takes the run lease for the model call, the edits and the save (12 minutes, `DEFAULT_REVISION_LEASE_MS`; the checks of the new version run after the lease is released, in `onVersionSaved`) and writes nothing when the lease is still busy after its retries, so a Lambda async retry or a duplicate job cannot make two versions. If the dispatch itself fails, the revision goes back to `failed` and the API answers 502 `dispatch_failed`.

Rules (design rules, `src/revision/types.ts`):

- The model writes ids only (item, rule, outcome, extraction id, threshold index) and a fixed reason code for what it cannot do. Code copies every number, quote and clinical text from the extraction or the current model, and builds the text of every open question itself. Severity is not editable by the AI (it is owned elsewhere); a request about it becomes an open question.
- The four edit types: `set_threshold` (replace the cut-off of one condition leaf with an extraction threshold; operator, number and age band copied by code), `set_rule_outcome` (point a rule at another outcome), `replace_action` (replace one action of an outcome with an extraction action or advice node; text, quote and dose table copied by code), `set_follow_up` (use an extraction follow-up, or remove it, which adds a code-built question "Follow-up removed from <outcome>; please confirm.").
- Scope: an edit may only touch items the comments point at; anything else is refused (`outside_comment_scope`). A comment on a rule unlocks only that rule (`set_threshold` on its condition, `set_rule_outcome`); a comment on an outcome unlocks only that outcome (`replace_action`, `set_follow_up`); a comment never unlocks the outcome a rule leads to, or the rules that lead to an outcome.
- Provenance: `set_rule_outcome` marks the rule `origin: "team"` (a routing change with no booklet quote); an edit never turns a `team` row into `guideline`; a refused edit changes nothing. The proposal is not checked for whether an extraction action belongs to the outcome it replaces into: the golden cases, the number checks and the signers catch a wrong context.
- Rows decided by the clinician (origin `clinician`) are never changed silently; the edit is refused (`clinician_decided`) and listed.
- A comment the edit types cannot express safely, or that the extraction does not support, becomes an open question, not an invented value.
- The result is a new version with zero signatures that goes through the normal save path and the same checks as a hand edit. If nothing could be applied the status is `no_change` and no version is saved.
- Same model and IAM as fill_logic (MODEL_ID / FILL_MODEL_ID / MODEL_BACKEND); the Bedrock policy covers MODEL_ID only.

Data stored: each revision is an S3 artifact `runs/<runId>/revisions/<id>.json` (no new DynamoDB table, no index file). The list of a version's revisions is read from the run's audit events. Audit events: `revision_requested` (carries the revision id, so it is the list index), `revision_confirmed` (who confirmed, whether the instruction was edited), `revision_applied`, `revision_no_change`, `revision_failed`, and `revision_usage` (one per paid model call: tokens, cost, latency). Comment text is never put in an audit event. `GET /runs/:id` takes the revision cost from the `revision_usage` events (one audit read), never from the revision files, so it stays cheap and a damaged revision file cannot break it. A revision file that is missing, not JSON or the wrong shape is skipped in lists (logged as a warning without its content) and gives 404 on its own GET.

Statuses: `instruction_ready`, `applying`, `applied`, `no_change`, `failed`. A `failed` or `instruction_ready` revision can be confirmed (again); `applying` (not stale) answers 409 `already_applying`; `applied` and `no_change` are final. A model or engine error in step 2 sets status `failed` with a short generic `error` that names the error class only (for example "The AI service did not answer (ThrottlingException); confirm again."); the detail is logged on the server and nothing is saved. A paid call whose result was unusable still counts in the cost totals.

Errors (`{error, message}`): 400 bad body; 404 `not_found` (run, version or revision); 409 `not_latest` (only the latest version can be revised), `locked`, `superseded` (a newer version appeared before confirm), `already_final`, `already_applying`, `busy` (run lease held for a moment; try again); 422 `no_comments`, `no_instruction`, `invalid_logic_model`; 502 `model_output_invalid`, `model_unavailable` (both step 1, body includes `revisionId`), `dispatch_failed` (confirm). A version number taken while step 2 runs (`conflict`) is not an HTTP error any more: the revision becomes `failed` with the reason.

| Request | Answer |
| --- | --- |
| `POST /runs/:id/versions/:n/revisions` | 201 revision (`instruction_ready`); 502 `model_output_invalid` or `model_unavailable` with `revisionId`; 404, 409, 422 as above |
| `GET /runs/:id/versions/:n/revisions` | 200 list |
| `GET /runs/:id/revisions/:rid` | 200 revision (stale `applying` shown as `failed`); 404 |
| `POST /runs/:id/revisions/:rid/confirm` | 202 revision (`applying`); 502 `dispatch_failed`; 404, 409, 422 |
| `POST /events` `{source:"revision",runId,revisionId}` (lambda mode only) | 200 `{ok:true}`; 400 bad payload |

AUTH SEAM: `role` and `userId` come from the request body until Cognito (DEC-015). Anyone with the API URL can request or confirm a revision as either role.

Wiring: `src/index.ts` reads the three prompt files at startup (a missing file stops startup with an error naming it), picks the dispatcher by `RUN_MODE` (lambda needs `AWS_LAMBDA_FUNCTION_NAME`, else startup fails), builds the `RevisionService` with the real engine, the same model client and `FILL_MODEL_ID`, and passes it to `buildServer`; the routes work in container, lambda and agentcore modes. The Lambda self-invoke has never run against real Lambda (tests use a fake invoker and `app.inject`); the stack still needs `lambda:InvokeFunction` on itself. The flow is tested end to end with a fake model (`tests/integration/revisionLoop.test.ts`). It has not been verified against real Bedrock or S3, and the Docker image with the two new prompt files has not been built. Exact request fields: `src/contract/schemas.ts`.

## Cost and latency metrics (DEC-003)

`GET /runs/:id` returns `totals`, `byProcess` and `byVersion` next to `run` and `steps`. Each has `inputTokens`, `outputTokens`, `costUsd` (`null` when nothing was priced), `latencyMs` and `unpricedModels`. All of it is computed by `summarize` in `src/metrics/usage.ts` from the step records plus the revision model calls.

- Processes that record: `ingest`, `extract`, `fill_logic`, `checks` (pipeline steps, through `runStep`), `validate` (every saved version, `recordProcess` in `src/index.ts`), `revision` (each revision model call) and `compile` (`scripts/compileLocked.ts`). `validate` and `compile` carry latency only: they call no model.
- `latencyMs` is the sum of process time, not wall-clock time.
- `byVersion` is keyed by version number as a string. Pipeline steps have no version, so they appear only in `byProcess`.
- A model with no entry in `PRICES_JSON` has tokens but no cost. `costUsd` then covers only the priced calls, so check `unpricedModels` before trusting it.
- Failed attempts that already paid for a model call count in the totals.
- The Python scripts in `extraction/` and `cross-check/` write their own `run_metrics.json` but now price calls from the same `PRICES_JSON` (shared helper `extraction/usage_cost.py`, tests: `cd extraction && python3 -m unittest test_usage_cost`); the older `PRICE_IN_PER_MTOK` / `PRICE_OUT_PER_MTOK` still work when `PRICES_JSON` is unset.
- Concurrent workers: `appendStep` refuses a step and attempt that already exist (`AlreadyExists`), and `recordProcess` takes the next free number, so two workers never overwrite each other's record.
- Not covered: the later build-and-test (browser) stage is not built; it should use `recordProcess` with `process: "build_test"`.

## Shutdown

On SIGTERM or SIGINT the process stops polling SQS and the resume sweep, waits up to `SHUTDOWN_TIMEOUT_MS` for in-flight upload handling to finish, closes the HTTP server (waiting at most 5 s) and exits 0 even if work is still running. A pipeline cut off this way keeps its lease; the periodic resume sweep of a later process resumes it once the lease has expired (up to `LEASE_MS` later). Set the container stop grace period above `SHUTDOWN_TIMEOUT_MS` plus 5 s.

## HTTP API

Route names and request/response shapes are defined only in `src/contract/` (`routes.ts`, `schemas.ts`). The API covers creating a run (returning a presigned upload URL), reading a run, saving versions, comments, resuming a run, and sign-off: `GET .../versions/:n/findings[?audience=program_officer|clinician]`, `GET .../versions/:n/status`, `POST .../versions/:n/signatures/:role` with body `{role, userId, modelSha}` (201, or 400/403/404/409/422 as listed under "Sign-off"). See that folder for the exact paths.

## For the frontend

Exact shapes live in `src/contract/` (`routes.ts`, `schemas.ts`). Until Cognito is added (DEC-015, DEC-038) `userId` and `role` are sent in the body. All clinician routes use `role: "clinician"`; unknown run 404, unknown version 404, bad body 400.

- `GET /runs/:id/activity[?after=<cursor>]` returns `{items:[{seq, at, actor, kind, text}], cursor, runState}`. Poll with the last `cursor`. Actors: pipeline, officer_agent, clinician, it.
- `POST /runs/:id/chat` with `{userId, role, messages:[{from:"user"|"assistant", text}]}` (1 to 20 messages) returns `{reply, citations:[{kind, ref, quote?}]}`. Answers only, never changes anything. Errors: 429 `rate_limited` or `chat_budget_exceeded`, 503 `chat_unavailable`.
- `GET /runs/:id/versions/:n/flow` returns `{flow, nodes:[{nodeId, kind, questionId?, ruleId?, label, editable:[...]}], modelSha}`. Send `modelSha` back when saving edits.
- `POST /runs/:id/versions/:n/edits/preview` with `{userId, role, edits:[...]}` returns `{flow, nodes, paths, behaviourChanges, findings}`. `findings` is what the edited model would get as the next version (`{status, blocking, gates, checksNotRun, clinician:[groups], program_officer:[groups]}`); nothing is saved. Edit ops: `setQuestionLabel {questionId,text}`, `setThreshold {questionId,ruleId,from,to}`, `setOutcomeText {ruleId,field:"title"|"action",actionIndex?,text}`, `setFollowUpDays {ruleId,days}`. Any other op: 422 `unsupported_edit`.
- `POST /runs/:id/versions/:n/edits` with `{userId, role, edits, modelSha}` (optional `Idempotency-Key` header) saves a new version (origin `tree_edit`) and returns 201 `{n, checks_status, behaviourChanges}`. Only the latest version can be edited: a stale `n` or `modelSha` gives 409 `conflict`. The new version goes to the officer agent, which fixes and signs it, then to the clinician.
- `GET /runs/:id/versions/:a/diff/:b` returns `{a, b, structural:{changes, total, truncated}, behaviourChanges}`.
- `GET /runs/:id/versions/:n/change` returns the stored change record of a version (who, what, behaviour changes, agent details).
- `POST /runs/:id/versions/:n/restore` with `{userId, role}` copies version n into a new latest version (origin `restore`) and returns 201 `{n, checks_status, restoredFrom}`.
- Unchanged: `GET .../findings`, `GET .../status`, `POST .../signatures/clinician` `{role, userId, modelSha}`, and `POST .../reject` `{role:"clinician", userId, modelSha, comment (15+ chars), itemRef?, urgent?}`.
- Officer sign is now agent-only: `POST .../signatures/program_officer` and saving a version with `authorRole: "program_officer"` answer 403 `agent_only`. The officer agent runs by itself after the pipeline, after every saved version and after a reject; watch `activity` for `agent_fix`, `agent_signed` and `agent_escalated`. An escalation comment (itemRef `agent:escalation`) lists what a person must still do.

The cross-check flags (the differences between the draft and a second, independent logic model, DEC-035) are stored with every version's checks as `flags.json` in the run's artifacts (`runs/<id>/flags/<checks version>/<modelSha>-<inputs>.json`, a derived document that is recomputed when missing) and served by `GET /runs/:id/versions/:n/flags`. The document holds `comparison` (`ran`, `not_run` when no second draft was supplied, or `second_draft_invalid`), a `summary`, a `notice` and the `flags`: each is a Finding with its message worded for the clinician and for the program officer and a status; all are warnings decided by the clinician and none blocks signing. `python3 validation/compare_outputs.py --first ... --second ...` produces the same flags for two logic model files.

## Docker

`docker build -t orchestrator .` from this folder. The Dockerfile is written to install `poppler-utils` and `python3` for ingest, to run as the non-root `node` user and to copy no credentials into the image; supply AWS credentials through the runtime (for example an instance or task role). The image has not been built or scanned, so none of this has been verified.

## Model backend

`MODEL_BACKEND=bedrock` (default) runs the Strands agent call in this process against Amazon Bedrock. `MODEL_BACKEND=agentcore` sends it to an AgentCore Runtime hosting the AgentService instead, via `InvokeAgentRuntime` (`src/model/agentcore.ts`). `MODEL_ID` is still the model id, and is passed to the agent service in the request. The wire contract (`src/model/agentcoreWire.ts`) must match `AgentService/src/contract.ts`. Each call uses a fresh random runtime session id and a 6 minute timeout (constructor option `timeoutMs`; the Bedrock path has the same default, implemented with the Strands `cancelSignal` plus a non-cancelling `Promise.race` backstop). AgentCore turns a container 4xx/5xx into an opaque `RuntimeClientError` (HTTP 424), so the AgentService always answers HTTP 200 with an envelope: `{ok:true, raw, usage}` or `{ok:false, kind:"transient"|"permanent"|"invalid_request", message}`. `transient` becomes a retryable `TransientError`; the other kinds are plain permanent errors. A `RuntimeClientError` whose message matches `Received error (429|5xx)`, any error or response `statusCode` of 429/5xx, throttling, quota, retryable conflict, timeouts and network errors also become `TransientError`s; validation, access denied, not found and other 4xx are permanent. The wire limits (at most 700 content blocks, derived from 3 blocks per page plus 2 for the default 200 pages; at most 90 MiB of JSON, below AgentCore's 100 MB payload cap) are mirrored in `agentcoreWire.ts` and checked before sending, so an oversized extract fails with a clear permanent message instead of a round trip. The drift test in `AgentService/tests/wireDrift.test.ts` imports `agentcoreWire.ts`, so the CI `agentservice` job must run `npm ci` in `Backend` as well as in `AgentService`. A model answer that is not valid JSON for the step still records the usage of the call. The orchestrator's IAM role needs `bedrock-agentcore:InvokeAgentRuntime` on the runtime. The AgentCore path is unverified on real AWS: tests use a mocked SDK client.

## Running on AgentCore

The same image can run as an Amazon Bedrock AgentCore Runtime agent (HTTP protocol contract) by setting `RUN_MODE=agentcore` (`/invocations` exists only in this mode). Nothing here has been run on real AWS.

- The server listens on `0.0.0.0:8080`. The image must be ARM64: `docker buildx build --platform linux/arm64 -t orchestrator .`
- `GET /ping` returns `{status: "Healthy"}` when this process is advancing no run and `{status: "HealthyBusy"}` while it is, so a busy session is kept alive. `time_of_last_update` (unix seconds) changes only when the status changes, not on each ping.
- `POST /invocations` takes a JSON body validated against `InvocationRequest` in `src/contract/schemas.ts`: `{action:"uploaded", runId}` and `{action:"resume_all"}` run in the background and answer 202 `{accepted:true}`; `{action:"http", method, path, headers?, body?}` replays the request against the normal API in-process and answers `{statusCode, headers: {content-type}, body}`. Only the API routes in the contract are reachable that way: `/ping` and `/invocations` are refused and responses over 1 MiB give 502.
- In this mode `UPLOAD_QUEUE_URL` is not required, and the SQS consumer, the startup resume and the periodic resume sweep are not started. Something outside the process (for example a Lambda fed by the upload queue, calling the runtime with SigV4) must invoke `uploaded` and, periodically, `resume_all`.
- Sessions can be stopped when idle. A run cut off that way keeps its lease and is picked up by a later `resume_all` once the lease expires. The in-process active set stops one process advancing a run twice at once, and the DynamoDB lease stops two sessions advancing the same run at once, so duplicate invocations across sessions do not duplicate work.
- Like the container mode, the API has no authentication of its own; access control is the SigV4 invocation of the runtime.

## Running on Lambda

The same image runs as an AWS Lambda container image with `RUN_MODE=lambda`, using the AWS Lambda Web Adapter (extension at `/opt/extensions/lambda-adapter`). Build it with `docker build --target lambda .` (the Dockerfile's last stage is `container`, so a plain `docker build .` still gives the container image). The `lambda` target sets `AWS_LWA_PORT=8080`, `AWS_LWA_READINESS_CHECK_PATH=/ping`, `AWS_LWA_PASS_THROUGH_PATH=/events`, `AWS_LWA_ERROR_STATUS_CODES=500-599` (so a 5xx answer to a non-HTTP event makes Lambda retry it) and `RUN_MODE=lambda`. Nothing here has been run on real AWS, and the Docker build of this target has not been verified (no Docker daemon was available); only the adapter tag `public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1` was confirmed to exist.

- API Gateway HTTP events reach the Fastify routes as ordinary HTTP. Non-HTTP events (SQS, EventBridge schedule) are forwarded by the adapter as `POST /events`, a route registered only when `RUN_MODE=lambda` (404 in other modes).
- SQS event source: enable `ReportBatchItemFailures`. Each record body is parsed as an S3 notification; every uploaded input is advanced to completion before the response. A record whose handling throws is returned in `batchItemFailures` and redelivered; unparseable or irrelevant records are consumed. Batch size up to 100 is accepted (Lambda default 10).
- A revision event (`{"source":"revision","runId":...,"revisionId":...}`, sent by the function to itself, see "Revision loop") runs `RevisionService.runApply`; it is accepted in lambda mode only.
- A scheduled event (EventBridge rule, `source: aws.events`) runs `resumeAll`. There is no startup resume and no in-process sweep in lambda mode, so this schedule IS the recovery mechanism after a hard cut.
- Lambda freezes the process after the response, so in lambda mode `POST /runs/{id}/resume` does only the quick `failed` -> step-state transition (`Orchestrator.prepareResume`, which also gives the step a fresh attempt budget) and answers 202 at once; it does not run the pipeline. The run is then in a work state with no lease, so `listResumable` returns it and the scheduled sweep (at most one schedule period later, 5 minutes in the default stack) advances it. `/invocations` is registered only when `RUN_MODE=agentcore` (404 otherwise); `/ping` exists in every mode. `/events` has one overall 14 minute deadline per batch, and the scheduled `resumeAll` has the same 14 minute deadline: records or runs unfinished at that point are returned in `batchItemFailures` or left for the next sweep. A record for an unknown run is consumed, and one malformed or oversized record does not reject the batch. Container and agentcore behaviour is unchanged.
- The partial-batch reply key is `batchItemFailures` (checked against `SQSBatchResponse` from `@types/aws-lambda` in `tests/contract/lambda.test.ts`); a different key makes Lambda treat the whole batch as successful.
- Work that is still running after the 14 minute deadline is not cancelled: Lambda freezes it when the response is sent and it may thaw in a later invocation of the same container, stale. The lease owner checks stop a stale run from transitioning a run another owner has taken over, but it can still write an attempt record or artifact; those writes are idempotent and are superseded by the new owner's attempt.
- Lambda allows at most 15 minutes per invocation. The engine's steps are idempotent and a lease that expires lets the next invocation resume the run. In lambda mode `LEASE_MS` defaults to 960000 and any explicit value of 900000 or less fails startup; keep it above the function timeout so a live invocation is never taken over; after a hard cut the run is picked up by the scheduled sweep once the lease expires.

Security: there is no authentication on the API yet. `/events` must not be reachable from the internet: the API Gateway integration must expose only the explicit contract routes (`/runs...`) and never `/events`; `/invocations` must not be exposed either. Do not use a greedy `{proxy+}` route to the function.

## Attempt cap, timeouts and input bounds

- Each step may use at most 6 attempts in total (`DEFAULT_MAX_TOTAL_ATTEMPTS`, option `maxTotalAttempts` on the Orchestrator), counting attempts abandoned by an invocation that was cut off. Past the cap the step fails with an `Attempt cap reached` message instead of being retried, so a document that always outlives the invocation cannot loop and be billed forever. A manual resume starts a fresh budget for that step (`attemptFloor` on the run).
- Ingest refuses an input PDF over `MAX_PDF_BYTES` (checked with a size lookup through `ArtifactStore.size`, before downloading) and one with more than `MAX_PAGES` pages (`pdfinfo` from poppler, before `pdftoppm` renders anything). Both fail the step permanently with a clear message. The page limit applies to the whole document even when `pages` selects a few, because the whole document is rendered.
- Not done: the proper upload cap is a presigned POST with a `content-length-range` condition. It is deferred because it changes the create-run response contract (a URL plus form fields instead of a plain PUT URL). Until then a presigned PUT can upload a larger object; ingest refuses it before use, but it is still stored.

## CI

`.github/workflows/ci.yml` runs on push and pull_request with read-only permissions: backend typecheck, tests and build, Infra typecheck, tests and `cdk synth` (dummy account, no credentials), and a Docker build of the image for linux/amd64 and linux/arm64 without pushing. CI runs tests only; deploys are manual.

## Not verified / known gaps

- Nothing has run against real DynamoDB, S3, SQS or Bedrock. Unit tests use in-memory stores and mocked AWS clients.
- The DynamoStore contract suite runs only when `DYNAMODB_ENDPOINT` is set.
- The Docker image was not built: the Docker daemon was not running when this was written.
- The API has NO authentication. Do not expose it publicly.
- Hosting is undecided. Project rules say EC2 containers; the team prefers Strands on AgentCore. See `docs/superpowers/specs/2026-11-03-orchestrator-design.md` (OI-6, OI-7).
- The lease can lapse during a single very long step, so `LEASE_MS` must exceed the longest step.
- Ingest kills `prepare_input.py` after 5 minutes (`DEFAULT_EXEC_TIMEOUT_MS` in `src/steps/ingest.ts`; pass `createDefaultExec({ timeoutMs })` to change it). A very long PDF can exceed this; the step then fails non-transiently.
- Version bodies (the fill_logic draft and versions saved through the API) are validated with `parseModelValidator` (the logic model schema, `src/logic/schema.ts`); the checks run after fill_logic (`checks` step) and on every save (`onVersionSaved`, synchronously inside the save request).
- Sign-off has no real identity yet (DEC-015): role and user are taken from the request body. Reject (BR-17, AR-06), urgent marking (RR-02), release to IT and the single-editor lock (BR-10) are not built.
- fill_logic: the model returns a draft that names extraction items by id and thresholds by index (`src/logic/fill/draftSchema.ts`); `src/logic/fill/resolve.ts` writes every number, operator, quote and the meta, adds the out-of-age-range and catch-all rules (origin team) and lists team choices and every unclear item as open questions. Draft problems get one repair call, then the step fails. The live Bedrock run (`npm run fill:live`, needs AWS credentials) has not been run.
- The upload queue MUST have a redrive policy with a dead-letter queue and a `maxReceiveCount` (suggested: 5). This is infrastructure the IaC must create; this repo does not. When `onUploaded` throws, the consumer leaves the message on the queue so SQS redelivers it, and without a dead-letter queue a poison message is redelivered forever. A poison message looks like a message that keeps reappearing with the same run ID in the "onUploaded failed" log, for example a stray `runs/<id>/input/guideline.pdf` upload for a run that does not exist, or an event that arrives before the run row is written.
- A run stuck in `created` (its upload event failed every delivery and went to the dead-letter queue) has no automatic recovery: the resume sweep does not start runs in `created`. Replay the upload event, for example by redriving it from the dead-letter queue, once the cause is fixed.
- The SQS visibility timeout (default 900 s here) and `LEASE_MS` must BOTH exceed the longest single step. Redelivery of a message whose run is already running or finished is harmless, because the engine ignores a start for a run that is no longer `created`.
- If the process is killed mid-run (SIGKILL), the run keeps the dead process's lease until it expires. Every process runs `resumeAll` once at startup and then on a periodic resume sweep every `min(60 s, LEASE_MS / 2)`; the sweep picks the run up once the dead owner's lease has expired, so recovery can take up to `LEASE_MS` (plus one sweep interval) after the kill. Succeeded steps are not re-run; the interrupted step's running record is marked abandoned and the step runs again.
