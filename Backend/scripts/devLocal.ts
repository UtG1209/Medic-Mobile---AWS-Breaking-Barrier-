// Local development server: the real API (src/api/server.ts), orchestrator, checks and sign-off, with no AWS.
// In memory: MemoryStore, MemoryArtifactStore, FakeModelClient. Data is lost when the process stops.
//
// What is NOT real here:
// - ingest and extract do not read the uploaded PDF: they store the committed outputs of the public cough booklet
//   (extraction/input_blocks.json, extraction/extraction_output.json);
// - fill_logic gets the committed draft (tests/fixtures/fill/draft-cough.json) from a fake model;
// - the officer agent (src/agent/officerAgent.ts) is real, but its model call is faked: it answers every open
//   question routed to the program officer with a fixed sentence.
// So every upload produces the same cough logic model. Everything else (officer agent loop and signature,
// versions, findings, gates, clinician signature, lock) is the production code path.
//
// The presigned S3 URL is replaced by PUT /__upload/<key> on this server, which also stands in for the S3 event.
//
// Run: npm run dev:local   (then in Frontend: VITE_API_URL=http://localhost:8787 npm run dev)
// Env: PORT (default 8787), UI_ORIGIN (default http://localhost:5173).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer, type OrchestratorPort } from "../src/api/server.js";
import { MemoryArtifactStore, artifactKey, parseInputKey } from "../src/artifacts/artifactStore.js";
import { Orchestrator } from "../src/engine/engine.js";
import type { Step } from "../src/engine/step.js";
import type { ModelClient, ModelRequest } from "../src/model/modelClient.js";
import { parseModelJson } from "../src/model/modelClient.js";
import { OfficerAgent } from "../src/agent/officerAgent.js";
import { Signoff } from "../src/signoff/signoff.js";
import { createChecksStep } from "../src/steps/checks.js";
import { createFillLogicStep } from "../src/steps/fillLogic.js";
import { parseModelValidator } from "../src/steps/logicModelValidator.js";
import { MemoryStore } from "../src/store/memoryStore.js";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env["PORT"] ?? 8787);
const UI_ORIGIN = process.env["UI_ORIGIN"] ?? "http://localhost:5173";
const read = (p: string): string => readFileSync(path.join(BACKEND, p), "utf8");

const blocksText = read("extraction/input_blocks.json");
const extractionText = read("extraction/extraction_output.json");
const draftText = read("tests/fixtures/fill/draft-cough.json");

const store = new MemoryStore();
const artifacts = new MemoryArtifactStore();
/** Fake model: the officer agent gets a patch resolving the program officer's open questions; everything else gets the draft. */
const AGENT_ANSWER = "Answered by the officer agent from the guideline (dev:local stand-in for the model).";
const model: ModelClient = {
  async generateJson<T>(req: ModelRequest<T>) {
    const usage = { inputTokens: 0, outputTokens: 0, modelId: "fake.dev-local" };
    let raw = draftText;
    if (req.system.startsWith("You fix metadata problems")) {
      const text = req.content.map((c) => ("text" in c ? c.text : "")).join("\n");
      const m = /<data label="model">\n([\s\S]*?)\n<\/data>/.exec(text);
      const qs = (m ? (JSON.parse(m[1]!) as { open_questions?: { route_to: string; status: string }[] }).open_questions : undefined) ?? [];
      const ops = qs.flatMap((q, i) =>
        q.route_to === "program_officer" && q.status === "open"
          ? [{ op: "replace", path: `/open_questions/${i}/status`, value: "resolved" }, { op: "add", path: `/open_questions/${i}/resolution`, value: AGENT_ANSWER }]
          : [],
      );
      raw = JSON.stringify({ ops, explanation: "dev:local fake officer agent" });
    }
    return { value: parseModelJson(raw, req.schema, usage), usage, raw };
  },
};

/** Stores a committed output as this step's artifact, after a short pause so the UI can show progress. */
const provided = (name: string, runState: Step["runState"], key: string, body: string): Step => ({
  name,
  runState,
  async run(ctx) {
    const k = artifactKey(ctx.run.runId, ...key.split("/"));
    await artifacts.put(k, body, "application/json");
    await new Promise((r) => setTimeout(r, 500));
    return { artifactRefs: { [key]: k } };
  },
});

// As in src/index.ts: the officer agent runs when a run reaches awaiting_officer and after every saved version.
const triggers: { agent?: OfficerAgent } = {};
const triggerAgent = async (runId: string): Promise<void> => {
  await triggers.agent?.onAwaitingOfficer(runId).catch((e: unknown) => console.error(`officer agent failed on ${runId}:`, e instanceof Error ? e.message : e));
};

const orchestrator = new Orchestrator({
  store,
  artifacts,
  model,
  steps: [
    provided("ingest", "ingesting", "ingest/input_blocks.json", blocksText),
    provided("extract", "extracting", "extract/extraction_output.json", extractionText),
    createFillLogicStep({
      validator: parseModelValidator,
      modelId: "fake.dev-local",
      promptPath: path.join(BACKEND, "extraction", "fill_prompt.txt"),
      pathwayId: "cough_fast_breathing",
      guideline: { title: "Caring for the sick child in the community: Chart booklet" },
    }),
    createChecksStep(),
  ],
  finalState: "awaiting_officer",
  onFinalState: triggerAgent,
  owner: "dev-local",
  leaseMs: 60_000,
  runnerOpts: { maxAttempts: 1, backoffMs: () => 0, sleep: async () => {}, prices: {} },
});
const signoff = new Signoff({ store, artifacts });
const onVersionSaved = async (runId: string, n: number): Promise<void> => {
  await signoff.onVersionSaved(runId, n);
  await triggerAgent(runId);
};
triggers.agent = new OfficerAgent({
  store,
  artifacts,
  signoff,
  model,
  modelId: "fake.dev-local",
  validator: parseModelValidator,
  saveDeps: { store, artifacts, validator: parseModelValidator, onVersionSaved: (runId, n) => signoff.onVersionSaved(runId, n), now: Date.now },
  now: Date.now,
  budgetUsd: 1,
  prices: { "fake.dev-local": { inPerMTok: 0, outPerMTok: 0 } }, // the budget check needs a price for the model
  leaseMs: 60_000,
});
const port: OrchestratorPort = {
  createRun: (pages, filename) => orchestrator.createRun(pages, filename),
  resume: (id) => orchestrator.resume(id),
  prepareResume: (id) => orchestrator.prepareResume(id),
  onUploaded: (id) => orchestrator.onUploaded(id),
  resumeAll: () => orchestrator.resumeAll(),
  activeCount: () => orchestrator.activeCount(),
  lastStatusChange: () => orchestrator.lastStatusChange(),
};

const app = buildServer({
  orchestrator: port,
  store,
  artifacts,
  validator: parseModelValidator,
  // PUBLIC_API_URL: where the browser reaches this server (e.g. /api behind a Vite proxy); default direct.
  presign: async (key) => `${process.env["PUBLIC_API_URL"] ?? `http://localhost:${PORT}`}/__upload/${encodeURIComponent(key)}`,
  onVersionSaved,
  onRejected: triggerAgent,
  signoff,
  maxPages: 200,
  logger: false,
});

// CORS for the UI, as API Gateway does for uiOrigins in the deployed stack.
app.addHook("onRequest", async (req, reply) => {
  reply
    .header("Access-Control-Allow-Origin", UI_ORIGIN)
    .header("Access-Control-Allow-Headers", "content-type")
    .header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  if (req.method === "OPTIONS") return reply.code(204).send();
});
app.options("/*", async (_req, reply) => reply.code(204).send());

// Stands in for the presigned S3 PUT and the S3 event: store the PDF, then start the run.
app.addContentTypeParser("application/pdf", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
app.put<{ Params: { "*": string } }>("/__upload/*", async (req, reply) => {
  const key = decodeURIComponent(req.params["*"]);
  const runId = parseInputKey(key);
  if (!runId) return reply.code(400).send({ error: "not an input key" });
  await artifacts.put(key, req.body as Buffer, "application/pdf");
  console.log(`upload received for run ${runId}; running ingest -> extract -> fill_logic -> checks -> officer agent`);
  void orchestrator.onUploaded(runId).catch((e: unknown) => console.error(`run ${runId} failed:`, e instanceof Error ? e.message : e));
  return reply.code(200).send();
});

await app.listen({ host: "127.0.0.1", port: PORT });
console.log(`dev:local API on http://localhost:${PORT} (in memory, fake model, CORS for ${UI_ORIGIN})`);
console.log(`Frontend: cd Frontend && VITE_API_URL=http://localhost:${PORT} npm run dev`);
