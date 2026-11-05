# Frontend: guideline to form review

React 19 + Vite. The clinician reviews the logic model (View tab: flowchart, test patients, six checks; Edit tab: rule table; edits show in the View flowchart) and talks to an assistant. The backend's officer agent stands in for the program officer. The IT approver deploys.

## Run

```
npm ci
npm run dev                                   # against the deployed API (VITE_API_URL in Frontend/.env)
VITE_API_URL= npm run dev                     # sample data, no backend
VITE_API_URL=<APIURL> npm run dev             # against another orchestrator API (Backend/src)
npm run build && npm run lint
```

Locally, with no AWS (main's real API, pipeline and sign-off code in memory; every upload gives the same cough draft from a fake model):

```
cd Backend && npm ci && npm run dev:local                          # API on http://localhost:8787
cd Frontend && VITE_API_URL=http://localhost:8787 npm run dev      # UI on http://localhost:5173
```

Behind a single port (remote container, port-forward or preview pane): the UI proxies `/api` to dev:local, so the browser only needs 5173.

```
cd Backend && PUBLIC_API_URL=/api npm run dev:local
cd Frontend && VITE_API_URL=/api npm run dev:proxy
```

`<APIURL>` is the `APIURL` output of `OrchestratorLambdaStack` (DEPLOYMENT.md), without the trailing slash. The API allows the origins in the CDK context `uiOrigins` (default `http://localhost:5173`). Optional: `VITE_CLINICIAN_ID` is the clinician's user id for signatures (default `clinician`).

## How it uses the backend (live mode)

| UI step | API calls (Backend/src/contract/routes.ts) |
|---|---|
| Upload a guideline | `POST /runs {filename}`, then `PUT` the PDF to the returned presigned URL (Content-Type `application/pdf`). The backend reads every page. |
| Library and progress | `GET /runs`, `GET /runs/:id` (state and steps) |
| Start the review | `GET /runs/:id/versions`, `GET /runs/:id/versions/:n`, `GET .../findings?audience=clinician` and `program_officer` |
| Approve | `POST /runs/:id/versions` saved by the clinician (edits and the clinician's answers); the backend's officer agent then signs it as `program_officer` (the API refuses that role from the UI); the UI polls `GET .../status` until it reads `awaiting_clinician`, then `POST .../signatures/clinician`. The version is then locked. |

Edits, the assistant and the in-browser checks run locally; nothing reaches the backend until Approve. Every open question is written into the model as resolved with a written answer, saved by the role it is routed to, as the backend's open-question check requires. The backend refuses a signature while its gate has blocking findings; the refusal and its blockers show as an error banner.

Not wired yet: quote check and cross check in the browser need the guideline text and draft B, which the API does not return (the backend runs its own quote grounding; see the findings in the assistant). Release (synthetic check, IT approve) is local; the release build runs on the build host (`npm run compile:locked` in Backend).

## Code

- `src/domain/agent.ts`: the AI agent's pass (checks 1 to 3, safe fixes) and the assistant.
- `src/domain/workflow.ts`: state machine none -> clinician -> verify -> deploy -> done.
- `src/api/index.ts`: the only file that talks to the backend.
- `../shared/pathway`: the logic model types, evaluator and compiler (`toGraph` builds the flowchart graph); tests: `cd shared && npm test`.
