# End-to-end deployment on AWS

How to deploy the backend (data layer, Lambda, API) to an AWS account, test it, and tear it down. Written against the code on branch `logic-model-checks-compiler`. Everything marked **Verified** was run locally or in CI; everything marked **Unverified** has never run against real AWS (see [What is not verified](#9-what-is-not-verified)).

Detail lives next to the code: [`Infra/README.md`](Infra/README.md) (resources, context keys, env mapping), [`Infra/DEPLOY_CHECKLIST.md`](Infra/DEPLOY_CHECKLIST.md) (short tick list), [`Backend/README.md`](Backend/README.md) (env vars, API, sign-off rules).

---

## 1. What gets deployed

```
Browser ──HTTPS──▶ API Gateway (HTTP API, 13 explicit routes, no catch-all)
                        │
                        ▼
                  Lambda (Docker image, ARM64, 2 GB RAM, 2 GB /tmp, 15 min)
                  Fastify behind the Lambda Web Adapter, RUN_MODE=lambda
                     │         │              │
                     ▼         ▼              ▼
             DynamoDB x5   S3 artifact     Bedrock (Claude)
             (on demand)   bucket          InvokeModel
                               │
                               │ ObjectCreated  runs/*/input/guideline.pdf
                               ▼
                         SQS upload queue ──▶ same Lambda (batch 1, max concurrency 5)
                               │ after 5 failed receives
                               ▼
                              DLQ (14 days)

EventBridge rate(5 minutes) ──▶ same Lambda ──▶ resume cut-off runs
```

A run: `POST /runs` returns a presigned S3 upload URL → the browser PUTs the PDF → S3 notifies SQS → the Lambda runs **ingest → extract → fill_logic → checks**, then the run waits for sign-off (`awaiting_officer` → `awaiting_clinician` → `locked`).

CDK stacks (all in `Infra/`, region **us-west-2**, tag `project=no-code-cht-config`):

| Stack | Creates |
|---|---|
| `OrchestratorDataStack` | S3 bucket, SQS queue + DLQ, 5 DynamoDB tables, 2 IAM managed policies (app, Bedrock) |
| `OrchestratorLambdaStack` | Lambda (Docker image), SQS event source, 5-minute EventBridge rule, HTTP API, throttling, CORS |
| `OrchestratorAgentCoreStack` | **Optional, off by default.** AgentCore Runtime for `AgentService/`. Only with `-c modelBackend=agentcore`. Not organiser-approved (DEC-008); skip it for the first deploy. |

Not deployed (does not exist in the CDK yet): authentication, the compile build host, the frontend upload (the web stack exists; see Frontend/README.md), a VPC, CloudWatch alarms. See [section 8](#8-before-you-share-the-url).

---

## 2. Prerequisites

| Need | Check |
|---|---|
| AWS account, sandbox or dev, with permission to create IAM, Lambda, API Gateway, S3, SQS, DynamoDB, EventBridge, CloudFormation, ECR | |
| Organiser sign-off that API Gateway and EventBridge are allowed (DEC-011) | |
| Node 22+ and npm | `node -v` |
| AWS CLI v2 | `aws --version` |
| **Docker Desktop, running** (the Lambda image is built and pushed at deploy time) | `docker info` |
| Bedrock model access enabled in **us-west-2** for your model | Bedrock console → Model access |
| A test PDF | `Guideline_Docs/Cough_Guideline.pdf` |

Apple Silicon builds the ARM64 image natively. On an amd64 host Docker needs QEMU: `docker run --privileged --rm tonistiigi/binfmt --install arm64`.

Confirm the model ID is still available before you deploy (the code default is `us.anthropic.claude-haiku-4-5-20251001-v1:0`):

```bash
aws bedrock list-inference-profiles --region us-west-2 --query "inferenceProfileSummaries[].inferenceProfileId"
```

Use an ID that starts with `us.`. The IAM policy is scoped to exactly that one model, so the same ID is used for every model call.

---

## 3. Verify locally first (about 3 minutes)

Run these before spending anything. **Verified:** all pass on this branch and in CI.

```bash
cd Backend      && npm ci && npx tsc --noEmit && npm test && npm run build
cd ../Infra     && npm ci && npx tsc --noEmit && npm test
CDK_DEFAULT_ACCOUNT=111111111111 AWS_REGION=us-west-2 npx cdk synth --quiet
```

Expected: Backend 1329 passed / 33 skipped (the skipped ones need DynamoDB Local), Infra 61 passed, synth succeeds. The CDK stack synthesises without Docker; only `deploy` needs it.

Optional, only if Docker is running:

```bash
docker build --target lambda --platform linux/arm64 -t orchestrator-lambda ./Backend
```

---

## 4. Deploy

### 4.1 Log in

```bash
aws sso login --profile <profile>
export AWS_PROFILE=<profile>
export AWS_REGION=us-west-2          # the CDK ignores CDK_DEFAULT_REGION on purpose
aws sts get-caller-identity          # confirm the account
```

### 4.2 Bootstrap (once per account and region)

```bash
cd Infra
npx cdk bootstrap aws://<ACCOUNT_ID>/us-west-2
```

### 4.3 Choose your settings

| Context key | Default | Notes |
|---|---|---|
| `modelId` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Must be a `us.` inference profile you have access to |
| `uiOrigins` | `http://localhost:5173` | Origin(s) of your UI, for CORS on the API **and** the S3 bucket. One origin, a comma-separated list, or a JSON array string. `http(s)://host`, no path, no `*`. A malformed value fails the synth. |
| `prices` | none | Optional JSON, model ID to `{inPerMTok, outPerMTok}`, enables cost figures |
| `modelBackend` | `bedrock` | `agentcore` is optional and unapproved |

Set them once in `Infra/cdk.json` under `context`, or pass `-c key=value` on every synth and deploy.

Check the CORS value before deploying. If it is wrong the UI is blocked after deploy with no error:

```bash
npx cdk synth --quiet -o /tmp/cdkout -c uiOrigins=https://app.example.org
grep -h -A1 AllowOrigins /tmp/cdkout/OrchestratorLambdaStack.template.json
```

### 4.4 Deploy

```bash
npx cdk deploy --all \
  -c modelId=<model-id> \
  -c uiOrigins=https://app.example.org
```

This deploys `OrchestratorDataStack`, then `OrchestratorLambdaStack`. Docker must be running. The first deploy builds the image and pushes it to the bootstrap ECR repository; expect several minutes. CDK shows the IAM changes and asks for confirmation.

If the Docker build fails, copy the error text and stop. Do not retry blindly.

### 4.5 Save the outputs

```bash
aws cloudformation describe-stacks --stack-name OrchestratorLambdaStack --query "Stacks[0].Outputs" --output table
aws cloudformation describe-stacks --stack-name OrchestratorDataStack   --query "Stacks[0].Outputs" --output table
```

| Output | Use |
|---|---|
| `APIURL` | Base URL for the API (ends in `/`) |
| `FUNCTIONNAME` | For `aws logs tail` |
| `TABLE*`, `ARTIFACTBUCKET`, `UPLOADQUEUEURL` | Already wired into the Lambda environment by the CDK. You only need them for debugging, or if you later run the app somewhere else. |
| `UPLOADDLQURL` | Watch this for failed uploads |

No `.env` is needed for the Lambda deployment. The CDK sets every variable (see the mapping in `Infra/README.md`).

---

## 5. Smoke test

```bash
export API=<APIURL without trailing slash>

# 1. Create a run. Pick a small page range first: the whole document goes to the model in ONE call.
curl -s -X POST $API/runs -H 'content-type: application/json' \
  -d '{"filename":"Cough_Guideline.pdf","pages":[1,2,3]}'
# -> {"runId":"<id>","uploadUrl":"https://...presigned..."}   (URL valid 15 minutes)

# 2. Upload the PDF. The Content-Type must be exactly application/pdf or the signature fails.
curl -s -X PUT "<uploadUrl>" -H 'content-type: application/pdf' \
  --data-binary @Guideline_Docs/Cough_Guideline.pdf

# 3. Watch the run. Expect: created -> ingesting -> extracting -> filling_logic -> checking -> awaiting_officer
watch -n 10 "curl -s $API/runs/<id> | python3 -m json.tool | head -40"
```

Omit `pages` to process every page (max 200 pages and 50 MB).

When the run reaches `awaiting_officer`:

```bash
curl -s $API/runs/<id>/versions                       # version 1 = the AI draft
curl -s "$API/runs/<id>/versions/1/findings?audience=program_officer"
curl -s $API/runs/<id>/versions/1/status               # includes the modelSha you sign
```

`GET /runs/<id>` also returns per-step tokens, cost and latency; record them for the README (DEC-003).

If it fails:

```bash
# The CDK gives the function its own log group, so look the name up first:
LOG=$(aws lambda get-function-configuration --function-name <FUNCTIONNAME> --query LoggingConfig.LogGroup --output text)
aws logs tail "$LOG" --follow
aws sqs get-queue-attributes --queue-url <UPLOADDLQURL> --attribute-names ApproximateNumberOfMessages
curl -s -X POST $API/runs/<id>/resume                        # a failed run; the 5-minute sweep picks it up
```

---

## 6. How a run survives the 15-minute limit

Lambda stops at 15 minutes. The design copes:

- Steps are idempotent and a succeeded step is never re-run.
- A DynamoDB lease (`LEASE_MS` = 960000, above the Lambda timeout) stops two invocations advancing the same run.
- The scheduled sweep (every 5 minutes) resumes any run whose lease has expired.
- Each step may use at most **6 attempts in total**, cut-off attempts included. After that it fails with `Attempt cap reached`; `POST /runs/<id>/resume` gives it a fresh budget.
- The SQS visibility timeout is 5400 s (6x the function timeout). Keep it above `LEASE_MS` if you change either.

A very large document can use several invocations. Ingest has a 5-minute limit and each model call a 6-minute limit.

---

## 7. Day-two operations

| Task | How |
|---|---|
| Redeploy after a code change | `cd Infra && npx cdk deploy --all` (same `-c` flags) |
| See what will change | `npx cdk diff` |
| Tail logs | Find the log group with `aws lambda get-function-configuration --function-name <FUNCTIONNAME> --query LoggingConfig.LogGroup`, then `aws logs tail <group> --follow` (2-week retention) |
| Replay a stuck upload | A run stuck in `created` has no automatic recovery. Fix the cause, then redrive the message from the DLQ. |
| Change CORS origins | Redeploy with the new `uiOrigins` |
| Use a different model | Redeploy with `-c modelId=...`. `FILL_MODEL_ID` cannot differ from `MODEL_ID` without widening `BedrockInvokePolicy` in `data-stack.ts`. |

### Tear down

```bash
cd Infra && npx cdk destroy --all
```

The five DynamoDB tables and the S3 bucket are `RETAIN`: they survive `destroy`. Delete them by hand if you want them gone. They hold run data and uploaded guidelines.

---

## 8. Before you share the URL

The deployed API is **open to anyone who has the URL**. Every run triggers paid Bedrock calls.

1. **Add authentication.** Cognito groups `program_officer`, `clinician`, `it` plus a JWT authorizer on the HTTP API (DEC-015). Until then `role` and `userId` in sign-off requests come from the request body, so separation of duties is not enforced against a malicious caller. Not built.
2. **Set an AWS Budget alarm** on the account. The stage throttle (burst 50, rate 25) and SQS max concurrency 5 limit speed, not spend.
3. **Add alarms** on DLQ depth and Lambda errors. None exist.
4. Do not publish the URL, and never expose `/events`, `/invocations` or a `{proxy+}` route. The CDK deliberately routes only the 13 contract paths.

---

## 9. What is not verified

| Item | State |
|---|---|
| Backend, Infra and AgentService tests, type checks, builds, `cdk synth` | **Verified** (local and CI) |
| Docker builds (container, `lambda` target, AgentService, amd64 and arm64) | **Verified in CI.** Not built locally. |
| Anything against real AWS: Lambda Web Adapter start-up, S3 to SQS to Lambda, Bedrock permissions, API Gateway | **Unverified.** Expect fixes on the first deploy. |
| DynamoDB conditional transactions (version chain, signatures) | **Unverified.** The 33 tests that cover them run only against DynamoDB Local (`DYNAMODB_ENDPOINT`) and are skipped. |
| One model call carrying one image per page | **Unverified** against Bedrock's image-count and payload limits for large page ranges. Start small. |
| Default model ID availability | **Unverified.** Check with `list-inference-profiles`. |

## 10. Not built yet

- Authentication and authorizer (DEC-015).
- The compile build host (DEC-014). `Backend/scripts/compileLocked.ts` needs a host with cht-conf; compile is not a Lambda step, so a locked model cannot yet be turned into a CHT project in AWS.
- The check inputs: the Lambda image does not bundle the golden test cases or the compile settings. Until you upload `runs/<id>/inputs/golden_cases.json` and `compile_settings.json` to the bucket, the findings say the test-case and form-readiness checks did not run.
- The frontend build is not uploaded by the CDK. Build it with `VITE_API_URL=<APIURL>` and sync `Frontend/dist` to the web stack bucket (Frontend/README.md).
- VPC and endpoints, CloudWatch alarms and dashboards.
- Reject, urgent marking, release to IT and the single-editor lock are partly or not built on the Backend side (see `Backend/README.md`).
