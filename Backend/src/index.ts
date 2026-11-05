import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { buildServer } from "./api/server.js";
import { S3ArtifactStore } from "./artifacts/s3ArtifactStore.js";
import { loadConfig } from "./config.js";
import { Orchestrator } from "./engine/engine.js";
import { startResumeSweep } from "./engine/sweep.js";
import { withDeadline } from "./shutdown.js";
import { createAgentCoreModelClient } from "./model/agentcore.js";
import { createStrandsModelClient } from "./model/strands.js";
import { OfficerAgent } from "./agent/officerAgent.js";
import { runBackground } from "./api/background.js";
import * as revisionEngine from "./revision/engine.js";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { InProcessDispatcher, LambdaAsyncDispatcher } from "./revision/dispatch.js";
import type { RevisionDispatcher } from "./revision/dispatch.js";
import { RevisionService } from "./revision/service.js";
import { Signoff } from "./signoff/signoff.js";
import { cognitoResolver } from "./auth/identity.js";
import { withScoring } from "./scoring/scoreVersion.js";
import { createChecksStep } from "./steps/checks.js";
import { createExtractStep } from "./steps/extract.js";
import { createFillLogicStep } from "./steps/fillLogic.js";
import { goldenNamingHint, goldenQuestions } from "./steps/goldenNames.js";
import { withCrossDraft } from "./steps/crossDraft.js";
import { defaultCheckInputs } from "./signoff/checkInputs.js";
import { createIngestStep, createPdfInfoPageCount, defaultExec } from "./steps/ingest.js";
import { parseModelValidator } from "./steps/logicModelValidator.js";
import { unpricedModelIds } from "./metrics/cost.js";
import { recordProcess } from "./metrics/record.js";
import { summarize } from "./metrics/usage.js";
import { DynamoStore } from "./store/dynamoStore.js";
import { createLogger } from "./observability/logger.js";
import { observeModel, observeStore } from "./observability/observe.js";
import { startQueueConsumer } from "./trigger/queueConsumer.js";

const PRESIGN_EXPIRES_SECONDS = 900;
const SERVER_CLOSE_TIMEOUT_MS = 5000;

// A prompt the revision loop needs must exist at startup, with a message that names the file.
async function readPrompt(name: string, file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    throw new Error(`Cannot read the ${name} prompt file at ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const resumeSweepIntervalMs = (leaseMs: number): number => Math.max(1, Math.min(60000, Math.floor(leaseMs / 2)));

// Never log env values, request bodies or message bodies.
const logger = createLogger({ base: { service: "orchestrator" } });
const log = (msg: string, detail?: object): void => logger.info(msg, detail as Record<string, unknown>);

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const unpriced = unpricedModelIds(cfg.prices, [cfg.modelId, cfg.fillModelId]);
  if (unpriced.length > 0) log("warning: no price in PRICES_JSON for these models; their cost will be missing from totals", { models: unpriced });

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region }));
  // Every step, audit event, version, signature and model call is logged and measured (CloudWatch).
  const store = observeStore(new DynamoStore(doc, cfg.tables), logger);
  const s3 = new S3Client({ region: cfg.region });
  const artifacts = new S3ArtifactStore(s3, cfg.artifactBucket);
  const model = observeModel(
    cfg.modelBackend === "agentcore"
      ? createAgentCoreModelClient({ region: cfg.region, runtimeArn: cfg.agentCoreRuntimeArn as string })
      : createStrandsModelClient({ region: cfg.region }),
    logger,
  );

  // The officer agent is built after the orchestrator and signoff; the hooks below reach it through this holder.
  const triggers: { agent?: OfficerAgent } = {};
  const triggerAgent = (runId: string): Promise<void> => {
    const agent = triggers.agent;
    if (!agent) return Promise.resolve();
    // Idempotent: the agent's state record per base version stops a second run from doing the work twice.
    return runBackground(cfg.runMode, agent.onAwaitingOfficer(runId), (e) =>
      log("officer agent failed", { runId, error: e instanceof Error ? e.message : String(e) }),
    );
  };

  // The extract and fill options are shared with the second draft (src/steps/crossDraft.ts), which runs the same steps again.
  const extractOpts = { modelId: cfg.modelId, promptPath: cfg.extractPrompt };
  const fillOpts = {
    validator: parseModelValidator,
    modelId: cfg.fillModelId,
    promptPath: cfg.fillPrompt,
    // The ids the confirmed test cases use, from the same source the checks read (the run's file, else the bundled one).
    namingHint: async (runId: string) => goldenNamingHint((await defaultCheckInputs(artifacts)(runId)).goldenCases),
    requiredQuestions: async (runId: string) => goldenQuestions((await defaultCheckInputs(artifacts)(runId)).goldenCases),
  };
  const extractStep = createExtractStep(extractOpts);
  const fillStep = createFillLogicStep(fillOpts);
  const checksStep = cfg.scoring ? withScoring(createChecksStep(), { ...cfg.scoring, region: cfg.region }) : createChecksStep();

  const orchestrator = new Orchestrator({
    store,
    artifacts,
    model,
    steps: [
      createIngestStep({
        pythonBin: cfg.pythonBin,
        scriptPath: cfg.ingestScript,
        exec: defaultExec,
        maxPdfBytes: cfg.maxPdfBytes,
        maxPages: cfg.maxPages,
        pdfPageCount: createPdfInfoPageCount(),
      }),
      extractStep,
      fillStep,
      // Automatic checks on version 1 (BR-11); the run then waits for the program officer (DEC-019).
      // With JUDGE_MODEL_ID set, quote-support scoring runs after them (advisory; a failure never stops the run).
      // Before them, a second independent draft is made for the "two drafts agree" check (advisory too).
      cfg.crossDraft.enabled
        ? withCrossDraft(checksStep, { extract: createExtractStep(extractOpts), fill: createFillLogicStep(fillOpts), suppliedElsewhere: cfg.crossDraft.suppliedElsewhere })
        : checksStep,
    ],
    finalState: "awaiting_officer",
    onFinalState: triggerAgent,
    log,
    owner: randomUUID(),
    leaseMs: cfg.leaseMs,
    runnerOpts: {
      maxAttempts: 3,
      backoffMs: (a) => Math.min(30000, 1000 * 2 ** a),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      prices: cfg.prices,
      modelBackend: cfg.modelBackend,
      ...(cfg.runBudgetUsd !== undefined
        ? {
            runBudgetUsd: cfg.runBudgetUsd,
            // Revision model calls are not step records; `revisions` is created below, before any run starts.
            extraSpentUsd: async (runId: string) =>
              summarize(await revisions.usageRows(runId)).totals.costUsd ?? 0,
          }
        : {}),
      log,
    },
  });

  // Findings, status and signatures. Compile is not here: it runs on the build host (DEC-014),
  // see scripts/compileLocked.ts.
  const signoff = new Signoff({ store, artifacts });
  // The agent saves its fixes through saveVersion with signoff.onVersionSaved (no re-trigger: it loops itself).
  triggers.agent = new OfficerAgent({
    store,
    artifacts,
    signoff,
    model,
    modelId: cfg.officerAgentModelId,
    validator: parseModelValidator,
    saveDeps: { store, artifacts, validator: parseModelValidator, onVersionSaved: (runId, n) => signoff.onVersionSaved(runId, n), now: Date.now },
    now: Date.now,
    budgetUsd: cfg.officerAgentMaxCostUsd,
    prices: cfg.prices,
    leaseMs: cfg.leaseMs,
  });

  // Every saved version is checked and goes back to the program officer (AR-01, AR-02, GR-03).
  const onVersionSaved = async (runId: string, n: number): Promise<void> => {
    log("version saved", { runId, version: n });
    // Recorded as the "validate" process of this version (DEC-003).
    await recordProcess(store, { runId, process: "validate", versionId: String(n), now: Date.now }, () => signoff.onVersionSaved(runId, n));
    // The officer agent looks at every new version, including one made by an AI revision. Its own saves go
    // through signoff directly (see saveDeps), so it does not trigger itself.
    await triggerAgent(runId);
  };

  // Revision loop: the original fill prompt is step 2's system prompt, the addendum follows it.
  const prompts = {
    fill: await readPrompt("fill", cfg.fillPrompt),
    instruction: await readPrompt("revise instruction", cfg.reviseInstructionPrompt),
    revise: await readPrompt("revise", cfg.revisePrompt),
  };
  // Step 2 runs outside the HTTP request. Lambda freezes after the response, so it invokes itself
  // asynchronously (POST /events); other modes keep the process alive and run it in-process.
  let dispatcher: RevisionDispatcher;
  let inProcess: InProcessDispatcher | undefined;
  if (cfg.runMode === "lambda") {
    const fn = process.env["AWS_LAMBDA_FUNCTION_NAME"];
    if (!fn) throw new Error("RUN_MODE=lambda needs AWS_LAMBDA_FUNCTION_NAME (set by the Lambda runtime)");
    dispatcher = new LambdaAsyncDispatcher(new LambdaClient({ region: cfg.region }), fn);
  } else {
    inProcess = new InProcessDispatcher(
      (job) => revisions.runApply(job.runId, job.revisionId),
      (job, e) => log("revision background step failed", { runId: job.runId, revisionId: job.revisionId, errName: e instanceof Error ? e.name : "unknown" }),
    );
    dispatcher = inProcess;
  }
  const revisions = new RevisionService({
    dispatcher,
    logger: {
      warn: (d, m) => log(m, { level: "warn", ...d }),
      error: (d, m) => log(m, { level: "error", ...d }),
    },
    store,
    artifacts,
    model,
    engine: revisionEngine,
    modelId: cfg.fillModelId,
    prompts,
    onVersionSaved,
    prices: cfg.prices,
  });

  if (!cfg.cognito) log("warning: COGNITO_USER_POOL_ID is not set; the API has no sign-in and lists every run");
  const app = buildServer({
    ...(cfg.cognito ? { identity: cognitoResolver(cfg.cognito) } : {}),
    orchestrator,
    store,
    artifacts,
    // Versions saved through the API must parse as a logic model, the same check the AI draft passes.
    validator: parseModelValidator,
    presign: (key) =>
      getSignedUrl(s3, new PutObjectCommand({ Bucket: cfg.artifactBucket, Key: key, ContentType: "application/pdf" }), {
        expiresIn: PRESIGN_EXPIRES_SECONDS,
      }),
    onVersionSaved,
    onRejected: triggerAgent,
    signoff,
    revisions,
    chat: { model, modelId: cfg.chatModelId, prices: cfg.prices, maxCostUsd: cfg.chatMaxCostUsd, maxTokens: cfg.chatMaxTokens, ratePerMin: cfg.chatRatePerMin },
    maxPages: cfg.maxPages,
    runMode: cfg.runMode,
    // Request lines (method, path, status, time) and the API's error logs; bodies are never logged.
    logger: cfg.logLevel === "silent" ? false : { level: cfg.logLevel },
    observe: logger,
  });

  const abort = new AbortController();
  // In agentcore and lambda modes a trigger outside the process calls the API instead,
  // so there is no queue consumer and no resume sweep.
  const consumer: Promise<void> =
    cfg.runMode === "container" && cfg.uploadQueueUrl !== undefined
      ? startQueueConsumer({
          sqs: new SQSClient({ region: cfg.region }),
          queueUrl: cfg.uploadQueueUrl,
          onUploaded: (runId) => orchestrator.onUploaded(runId),
          signal: abort.signal,
          concurrency: cfg.sqsConcurrency,
          log,
        })
      : Promise.resolve();

  let stopSweep: (() => void) | undefined;
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log("shutting down", { signal });
    abort.abort();
    stopSweep?.();
    const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    // Do not wait for whole pipelines: give in-flight work SHUTDOWN_TIMEOUT_MS, then
    // exit. Interrupted runs keep their lease and the resume sweep of a later
    // process picks them up once it expires.
    void withDeadline(Promise.all([consumer, inProcess?.drain()]), cfg.shutdownTimeoutMs)
      .then((drained) => {
        if (!drained) log("shutdown deadline reached; in-flight runs left for the resume sweep", { timeoutMs: cfg.shutdownTimeoutMs });
      })
      .catch((e: unknown) => log("shutdown error", { error: errText(e) }))
      .then(() => withDeadline(app.close(), SERVER_CLOSE_TIMEOUT_MS))
      .catch((e: unknown) => log("server close error", { error: errText(e) }))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await app.listen({ host: cfg.host, port: cfg.port });
  log("listening", { host: cfg.host, port: cfg.port, runMode: cfg.runMode });

  // Lambda: no in-process trigger; SQS and the scheduled sweep arrive as POST events.
  if (cfg.runMode !== "container") return;

  try {
    await orchestrator.resumeAll();
  } catch (e) {
    log("resumeAll failed", { error: e instanceof Error ? e.message : String(e) });
  }

  // Runs left by a killed process keep that process's lease until it expires;
  // the sweep picks them up after that.
  if (!stopping) {
    stopSweep = startResumeSweep({
      resumeAll: () => orchestrator.resumeAll(),
      intervalMs: resumeSweepIntervalMs(cfg.leaseMs),
      log,
    });
  }
}

main().catch((e: unknown) => {
  log("startup failed", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
