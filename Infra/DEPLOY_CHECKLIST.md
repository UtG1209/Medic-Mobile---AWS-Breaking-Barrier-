# Deploy checklist (AWS sandbox, us-west-2)

Run by a human with sandbox credentials. Nothing here has been run on real AWS yet. Do not paste credentials anywhere.

## Before you start
- [ ] Organisers have confirmed API Gateway and EventBridge are allowed (DEC-011). AgentCore is optional and off by default (DEC-008).
- [ ] Node 22 or newer, AWS CLI v2, Docker Desktop installed and **running** (the Lambda image is built at deploy time).
- [ ] Logged in: `aws sso login --profile <profile>` then `export AWS_PROFILE=<profile>`; check with `aws sts get-caller-identity`.
- [ ] Bedrock console, region us-west-2: access enabled for your model. Note its exact ID (default in code: `us.anthropic.claude-haiku-4-5-20251001-v1:0`).
- [ ] Decide the UI origin for CORS (default `http://localhost:5173`).
- [ ] A synthetic or public test PDF (for example `Guideline_Docs/Cough_Guideline.pdf`).

## Deploy
- [ ] `cd Infra && npm install`
- [ ] `npx cdk bootstrap aws://<ACCOUNT_ID>/us-west-2` (once per account)
- [ ] `npx cdk deploy --all -c modelId=<model-id> -c uiOrigins=<ui-url>` (several origins: a comma separated list or a JSON array string; a typo fails the synth instead of falling back to localhost)
- [ ] If the Docker build fails, copy the error text and stop; do not retry blindly.
- [ ] Save the stack outputs: API URL, bucket, queue URL, table names.

## Smoke test
- [ ] `POST <API URL>/runs` with the pages to process; note the run ID and the upload URL.
- [ ] `PUT` the PDF to the upload URL with header `Content-Type: application/pdf` exactly.
- [ ] Poll `GET <API URL>/runs/<id>`: expect ingesting, extracting, filling_logic, in_review.
- [ ] Check CloudWatch logs of the Lambda if a run fails. Check the dead-letter queue is empty.
- [ ] Look at the per-step tokens, cost and latency on the run for the README (DEC-003).

## Known gaps (do not share the API URL yet)
- [ ] The API has NO authentication and every run is a paid model call: add an authorizer or WAF and an AWS Budget alarm first.
- [ ] Nothing here is tested on real AWS; expect fixes on the first deploy.

## Optional: AgentCore
- [ ] Only after organiser approval: `npx cdk deploy --all -c modelBackend=agentcore ...`

## Tear down
- [ ] `npx cdk destroy --all`. The bucket and tables are RETAIN: delete them by hand if you want them gone.
