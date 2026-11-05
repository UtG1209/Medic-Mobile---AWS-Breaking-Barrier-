# Infra: OrchestratorDataStack, OrchestratorLambdaStack, and OrchestratorWebStack

AWS CDK v2 (TypeScript) for the data layer (`OrchestratorDataStack`), Lambda hosting (`OrchestratorLambdaStack`, see "Lambda stack" below), and static web delivery (`OrchestratorWebStack`, see "Web stack" below) of the Backend orchestrator. Region us-west-2. Every resource is tagged `project=no-code-cht-config`. No account IDs or ARNs are hard-coded.

## What it creates

- S3 artifact bucket: public access blocked, SSE-S3, SSL enforced, versioning off, RETAIN, CORS (PUT/GET/HEAD from `uiOrigins`, header `*`, exposes ETag, max age 3000), aborts incomplete multipart uploads after 1 day. ObjectCreated events for keys `runs/*/input/guideline.pdf` go to the upload queue.
- SQS upload queue (SSE-SQS, SSL enforced, visibility timeout 5400 s, 6x the 15 min Lambda timeout and above `LEASE_MS`) and a DLQ (14 day retention, `maxReceiveCount` 5).
- Five DynamoDB tables, on-demand, point-in-time recovery, RETAIN, generated names:
  - runs: `runId` (S)
  - steps: `runId` (S) + `sk` (S)
  - versions: `runId` (S) + `n` (N). Sign-off (DEC-019) adds non-key attributes to the version items (`signatures` list, `status`, `lockedAt`), written only by a conditional transaction; no key or index change, so no table change. DEC-020 adds more non-key attributes the same way (`bodySha256`, `authorRole`, `rejection`, `status` "rejected", `settingsSha` on each signature); the rejection is one more ConditionCheck + Update transaction, covered by the existing policy.
  - comments: `runId` (S) + `sk` (S)
  - audit: `runId` (S) + `sk` (S)
- Managed policy (CDK-generated name; logical id `OrchestratorAppPolicy`), scoped to exactly those resources: DynamoDB Get/Put/Update/ConditionCheck/Query/Scan on the tables (`dynamodb:ConditionCheckItem` is needed by the signature transaction, which checks that the version is still the latest); `s3:GetObject` and `s3:PutObject` on bucket objects plus `s3:ListBucket` on the bucket (so a missing key is a 404, not a 403); SQS Receive/Delete on the upload queue. The stack exposes it as `appPolicy` and as the `APPPOLICYARN` output so a future compute role can attach it.
- Second managed policy (logical id `BedrockInvokePolicy`, exposed as `bedrockPolicy`): `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the `us.` inference profile and on `arn:aws:bedrock:*::foundation-model/<base id>`. It is separate so the Lambda role only gets it when `modelBackend=bedrock`; with `agentcore` the Lambda has no Bedrock invoke permission, only `InvokeAgentRuntime`.

## Context

| Key | Default | Meaning |
|-----|---------|---------|
| `uiOrigins` | `["http://localhost:5173"]` | Allowed CORS origins (a wildcard is rejected) |
| `modelId` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Bedrock inference profile ID |
| `region` | `AWS_REGION`, else `us-west-2` | Target region |

`uiOrigins` can be set in `cdk.json` as an array, or on the command line as one origin, a comma separated list or a JSON array string: `npx cdk synth -c uiOrigins=https://app.example.org` or `-c 'uiOrigins=["https://a.example","https://b.example"]'`. An entry must be `http(s)://host` with no path; a wildcard or a malformed value fails the synth (it never silently falls back to localhost). Only an unset or empty value gives the localhost default. `CDK_DEFAULT_REGION` is ignored on purpose, because the CDK CLI fills it with us-east-1 when no profile region is set.

## Commands

```
npm install
npm run build     # type check
npm test          # vitest, offline
npm run synth     # cdk synth, offline
```

Deploy is done by a human with their own AWS credentials: `AWS_REGION=us-west-2 npx cdk bootstrap` (once per account/region), then `npx cdk deploy`. Do not deploy from automation without review. Tables and the bucket are RETAIN, so `cdk destroy` leaves them behind.

## Outputs to Backend env vars

| Output | Backend env var |
|--------|-----------------|
| TABLERUNS | TABLE_RUNS |
| TABLESTEPS | TABLE_STEPS |
| TABLEVERSIONS | TABLE_VERSIONS |
| TABLECOMMENTS | TABLE_COMMENTS |
| TABLEAUDIT | TABLE_AUDIT |
| ARTIFACTBUCKET | ARTIFACT_BUCKET |
| UPLOADQUEUEURL | UPLOAD_QUEUE_URL |
| MODELID | MODEL_ID |
| UPLOADDLQURL | none (monitoring) |
| APPPOLICYARN | none (attach to the compute role) |

The web stack additionally outputs `WEBURL`, `WEBASSETBUCKET`, and `BACKENDAPIURL`. Build the frontend with `BACKENDAPIURL`, upload the compiled assets to `WEBASSETBUCKET`, and use `WEBURL` as the production browser origin for `uiOrigins`.

Also set `AWS_REGION=us-west-2` for the app. Keep `LEASE_MS` below the queue visibility timeout (5400 s); raise both together.

The browser PUT to the presigned upload URL must send exactly `Content-Type: application/pdf`, because the URL is signed with that content type. Any other value fails signature validation.

The Bedrock foundation-model ARN uses a region wildcard on purpose: a `us.` cross-region inference profile can route to the foundation model in any US region.

## Lambda stack (OrchestratorLambdaStack)

WARNING: the HTTP API has NO authentication yet. Anyone who learns the URL can create runs and call Bedrock at your cost. Throttling (burst 50, rate 25) is the only protection. Do not publish the URL; add an authorizer before real use.

Created by `lib/lambda-stack.ts`, wired after the data stack in `bin/app.ts`:

- Docker-image Lambda built from `../Backend` with Docker target `lambda`, ARM_64 (asset platform `linux/arm64`), 2048 MB memory, 2048 MB ephemeral storage, 15 minute timeout, log group with 2 week retention. The data stack's `OrchestratorAppPolicy` is attached to the function role.
- Revision confirm runs in the background (DEC-037). API Gateway HTTP APIs cut a request at 30 seconds (the maximum; the integration `TimeoutInMillis` is set to 30000 and must not be lowered), and the Bedrock proposal call (step 2) can take longer, so `POST /runs/{id}/revisions/{rid}/confirm` answers `202` and the UI polls `GET /runs/{id}/revisions/{rid}`. A Lambda freezes after it responds, so in lambda mode the app invokes itself asynchronously (`InvocationType: Event`, payload `{"source":"revision","runId":...,"revisionId":...}`; the Web Adapter forwards it to `POST /events`). The function role therefore has one extra statement `InvokeSelfAsync`: `lambda:InvokeFunction` on the function's own ARN, nothing else. To avoid a circular dependency (role -> policy -> function -> role) the function has a fixed name `<stack name>-orchestrator` and the ARN is built as a string; changing the name later replaces the function. Step 1 (instruction from comments) stays synchronous: its prompt is small. An `EventInvokeConfig` sets `retryAttempts: 0` for async invokes: the worker is idempotent, but a retry could repeat a paid Bedrock call; the 5 minute schedule is unaffected in practice (it fires again). The 15 minute function timeout covers the worker; `LEASE_MS` is 960000 (above it), and the Backend revision lease (default 5 minutes) is shorter than the function timeout, so a crashed worker can be taken over while a live one (normally minutes) is not.
- SQS event source mapping from the upload queue: batch size 1, `ReportBatchItemFailures`, max concurrency 5. The queue visibility timeout (5400 s) is 6x the function timeout (15 min), per AWS guidance; recovery of a cut-off run is the 5 minute schedule, so the longer redelivery wait is acceptable. Duplicate delivery is harmless (the engine ignores a start for a run no longer `created`; the DynamoDB lease stops double advancement).
- EventBridge rule `rate(5 minutes)` with constant input `{"source":"aws.events","detail-type":"Scheduled Event"}` (the Backend `LambdaScheduledEvent` shape). It runs `resumeAll`, the recovery path for cut-off runs in lambda mode. `POST /runs/{id}/resume` is a fast `202` (the work is picked up asynchronously), so it does not hold an API request open; the route list is unchanged and still equals the contract.
- HTTP API (API Gateway v2, payload format 2.0, `$default` stage with burst 50 / rate 25, CORS from `uiOrigins`) with one explicit route per public contract route: POST/GET `/runs`, GET `/runs/{id}`, GET/POST `/runs/{id}/versions`, GET `/runs/{id}/versions/{n}`, GET/POST `/runs/{id}/versions/{n}/comments`, GET `/runs/{id}/versions/{n}/findings`, GET `/runs/{id}/versions/{n}/flags`, GET `/runs/{id}/versions/{n}/status`, POST `/runs/{id}/versions/{n}/signatures/{role}` (sign-off, DEC-019), POST `/runs/{id}/versions/{n}/reject` (the clinician's rejection with a comment, AR-06, DEC-020), POST/GET `/runs/{id}/versions/{n}/revisions`, GET `/runs/{id}/revisions/{rid}` and POST `/runs/{id}/revisions/{rid}/confirm` (revision loop, DEC-025; revisions are S3 artifacts under `runs/<id>/revisions/`, covered by the existing object policy, no new table), POST `/runs/{id}/resume`. There is no catch-all, and `/events`, `/invocations` and `/ping` are deliberately not routed (`/events` is the unauthenticated pass-through for non-HTTP events). `test/lambda-stack.test.ts` compares the route list with `Backend/src/contract/routes.ts`.
- Outputs: `APIURL`, `FUNCTIONNAME`. Tag `project=no-code-cht-config`.

A Fargate or EC2 host is NOT used; the app runs only as this Lambda.

## Web stack (OrchestratorWebStack)

Created by `lib/web-stack.ts` and wired from `bin/app.ts`:

- Private S3 bucket for compiled frontend assets with public access blocked, SSL enforcement, SSE-S3, and `RETAIN` removal policy.
- CloudFront distribution using S3 Origin Access Control, so the bucket is readable through CloudFront but not directly public.
- HTTP-to-HTTPS redirect and SPA fallback from 403/404 responses to `/index.html`.
- Outputs `WEBURL` and `WEBASSETBUCKET`.

The stack intentionally does not create a custom domain, ACM certificate, DNS record, or frontend build. Those can be added after the frontend domain is chosen. For the current stack, upload the build output with:

```bash
aws s3 sync Frontend/dist s3://<WEBASSETBUCKET> --delete
```

The frontend should receive the backend `APIURL` as a build-time configuration value. With the generated CloudFront hostname, bootstrap in two deploys: deploy once to obtain `WEBURL`, then deploy again with `uiOrigins` set to that exact origin. With a preselected custom domain, pass that domain as `uiOrigins` from the first deploy.

Extra context keys: `prices` (object or JSON string; becomes `PRICES_JSON`). Set a price for every model id in use, or run cost totals name it as unpriced. `runBudgetUsd` (positive number; becomes `RUN_BUDGET_USD`, an optional cap on the recorded cost of one run). `uiOrigins` and `modelId` are shared with the data stack.

### Environment variable mapping (function)

| Env var | Source |
|---------|--------|
| RUN_MODE | `lambda` |
| TABLE_RUNS / STEPS / VERSIONS / COMMENTS / AUDIT | data stack tables |
| ARTIFACT_BUCKET | data stack bucket |
| MODEL_ID | context `modelId` (same default as the data stack) |
| LEASE_MS | `960000` (above the 900 s timeout) |
| TMPDIR | `/tmp` (ingest writes page images with `os.tmpdir()`) |
| PRICES_JSON | optional, context `prices` |
| RUN_BUDGET_USD | optional, context `runBudgetUsd` |
| REVISE_INSTRUCTION_PROMPT / REVISE_PROMPT | not set: the image bundles `extraction/revise_instruction_prompt.txt` and `extraction/revise_prompt.txt`; the revision steps use the same model as fill_logic, so the Bedrock policy needs no change |
| FILL_PROMPT / FILL_MODEL_ID | not set: the image bundles `extraction/fill_prompt.txt` and fill_logic uses MODEL_ID, which is the only model the Bedrock policy allows. Setting FILL_MODEL_ID to another model needs that policy widened here first |
| GOLDEN_CASES_PATH / COMPILE_SETTINGS_PATH | not set (DEC-020): the checks first read `runs/<id>/inputs/golden_cases.json` and `compile_settings.json` from the artifact bucket, then these files, then the repository defaults (`tests/fixtures/logic/golden-testcases.json`, `compile-demo/settings.demo.json`). The image does not bundle the defaults, so in Lambda the findings say plainly that the test-case and form-readiness checks did not run until a run's inputs are uploaded; "none" switches one off |
| CROSS_CHECK_MODEL_PATH | not set (DEC-035): the checks read the second, independent logic model from `runs/<id>/inputs/cross_check_model.json` in the artifact bucket (no new permission: same bucket and prefix as the other check inputs); without one the cross-check comparison does not run and the findings say so |
| AWS_REGION | set by the Lambda runtime |
| UPLOAD_QUEUE_URL | not set (not used in lambda mode) |

### Deploying (human steps)

1. Start Docker locally: the image is built (and pushed to the bootstrap ECR repository) at deploy time. `cdk synth` and the tests only hash the Backend folder and need no Docker.
2. `aws sso login --profile <your profile>` and export the profile.
3. `AWS_REGION=us-west-2 npx cdk bootstrap` (once per account/region).
4. `AWS_REGION=us-west-2 npx cdk deploy --all`.
5. Read `APIURL`, `FUNCTIONNAME`, and `WEBURL` from the outputs. Set the UI origin with `-c uiOrigins=https://app.example.org` on every synth/deploy (or once in `cdk.json`), and check synthesized CORS `AllowOrigins` before deploying.
6. With the generated CloudFront hostname, deploy again with `AWS_REGION=us-west-2 npx cdk deploy --all -c 'uiOrigins=["https://<cloudfront-domain>"]'`.
7. Build the frontend against `APIURL`, upload `Frontend/dist` to `WEBASSETBUCKET`, and use `WEBURL` as the browser URL.

CI (`.github/workflows/ci.yml`) runs Infra `tsc`, tests and `cdk synth` with a dummy account and no credentials; it never deploys.

## Cost and abuse guardrails

- The HTTP API is public and has no authentication. Every run triggers paid model calls (Bedrock or AgentCore), so anyone with the URL can spend money.
- The SQS event source `maxConcurrency` of 5 limits how many runs execute in parallel, and the stage throttle (burst 50 / rate 25) limits request rate. Neither is a spending cap.
- Before sharing the URL, add an authorizer (or put a WAF in front) and create an AWS Budget alarm for the account.
- The signature route trusts the `role` and `userId` in the request body (auth seam, DEC-015 not built). Anyone with the URL can sign as either role, so separation of duties is NOT enforced against a malicious caller until Cognito and a JWT authorizer are added here.
- Reserved Lambda concurrency is deliberately not set: new sandbox accounts can have very low concurrency quotas, and reserving capacity could make the deploy fail or starve other functions.

## Deliberately missing

- API authentication (the Lambda stack's API is open). Cognito with the groups program_officer, clinician and it plus a JWT authorizer (DEC-015) belongs here when built; the Backend then reads role and user from the token.
- The build host for compile (DEC-014). Compile is not a Lambda step: `Backend/scripts/compileLocked.ts` builds a locked version and runs cht-conf (Python, later Chromium for the test harness) as a job. It needs the same table and bucket env vars and the app policy (Get/Query on versions, Get/Put on bucket objects, Put on audit). An EC2 container host (or similar) will run it; nothing for it exists in this CDK app yet.
- Networking (VPC, endpoints, security groups).
- CloudWatch alarms and dashboards, notably on the DLQ depth.

## AgentCore model backend (optional, off by default)

`lib/agentcore-stack.ts` (`OrchestratorAgentCoreStack`) hosts the `../AgentService` container (ARM64) on Amazon Bedrock AgentCore Runtime (`AWS::BedrockAgentCore::Runtime`, via `aws_bedrockagentcore.CfnRuntime`). It is created only when the context flag `modelBackend=agentcore` is set; the default is `bedrock` and then the synthesized Lambda stack has no AgentCore env vars or permissions and no AgentCore stack exists.

Enable: `npx cdk deploy -c modelBackend=agentcore --all` (Docker is needed at deploy time to build and push the ARM64 image; `cdk synth` does not need a Docker daemon).

With the flag on:
- Runtime name `orchestrator_agent_<8 hex chars>` (a hash of the stack's construct path, so it is stable per stack but unique; a fixed name would block CloudFormation replacement; it matches `[a-zA-Z][a-zA-Z0-9_]{0,47}`), public network mode, HTTP protocol, env `AWS_REGION` and `MODEL_ID` (context `modelId`). Outputs `RUNTIMEARN` and `RUNTIMEID`; tagged `project=no-code-cht-config`.
- Execution role: trust principal `bedrock-agentcore.amazonaws.com` with `aws:SourceAccount` and `aws:SourceArn` (`arn:...:bedrock-agentcore:<region>:<account>:*`) conditions. Permissions follow the AgentCore runtime-permissions docs: ECR pull on the asset repository, CloudWatch Logs under `/aws/bedrock-agentcore/runtimes/*`, workload identity tokens (the `ForUserId` variant is left out on purpose), and Bedrock invoke on the same two ARNs as the data stack app policy. Wildcard resources remain only where the docs require them: `ecr:GetAuthorizationToken`, X-Ray write actions, `cloudwatch:PutMetricData` (namespace-conditioned `bedrock-agentcore`) and `logs:DescribeLogGroups`.
- The Lambda gets `MODEL_BACKEND=agentcore`, `AGENTCORE_RUNTIME_ARN`, and `bedrock-agentcore:InvokeAgentRuntime` on the runtime ARN and `<arn>/runtime-endpoint/*`.

Caveats: AgentCore is NOT approved by the organisers yet (DEC-008). This stack has only been synthesized and unit tested, never deployed, so it is unverified on real AWS. Check that AgentCore Runtime is available in your region before deploying (us-west-2 is assumed, not confirmed). The `InvokeAgentRuntime` resource format is confirmed by the AWS Service Authorization Reference (https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock-agentcore.html): `arn:aws:bedrock-agentcore:<region>:<account>:runtime/<RuntimeId>` and `arn:aws:bedrock-agentcore:<region>:<account>:runtime/<RuntimeId>/runtime-endpoint/<Name>`, which is what the Lambda grant uses.

Building the arm64 image: Apple Silicon hosts build it natively. On an amd64 host Docker needs QEMU/binfmt emulation (`docker buildx`, for example `docker run --privileged --rm tonistiigi/binfmt --install arm64`), otherwise the deploy-time image build fails or is very slow.
