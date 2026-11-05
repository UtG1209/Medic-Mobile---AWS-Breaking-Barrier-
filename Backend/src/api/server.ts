import { visibleRuns, type IdentityResolver } from "../auth/identity.js";
import { enforceRequestIdentity } from "../auth/requestIdentity.js";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodType } from "zod";
import { inputPdfKey, NotFound } from "../artifacts/artifactStore.js";
import type { ArtifactStore } from "../artifacts/artifactStore.js";
import { routes } from "../contract/routes.js";
import { buildRunMetrics } from "../metrics/analyze.js";
import { loadAwsRates } from "../metrics/awsRates.js";
import { withDeadline } from "../shutdown.js";
import { parseS3Event } from "../trigger/s3Event.js";
import { saveNewVersion } from "./saveVersion.js";
import { registerClinicianRoutes, type ClinicianDeps } from "./clinicianRoutes.js";
import { LAMBDA_BACKGROUND_DEADLINE_MS, runBackground } from "./background.js";
import type { Logger } from "../observability/logger.js";
import type { RunMode } from "./background.js";
import {
  ConfirmRevisionRequest,
  CreateCommentRequest,
  CreateRevisionRequest,
  CreateRunRequest,
  FindingsQuery,
  INVOCATION_MAX_BODY_BYTES,
  InvocationRequest,
  LambdaRevisionEvent,
  LambdaScheduledEvent,
  LambdaOfficerEvent,
  LambdaSqsEnvelope,
  LambdaSqsRecord,
  RejectRequest,
  AcknowledgeRequest,
  SaveVersionRequest,
  SignRequest,
} from "../contract/schemas.js";
import type { CreateRunResponse, InvocationResponse, LambdaEventResponse, PingResponse } from "../contract/schemas.js";
import type { Run } from "../domain/types.js";
import { rowFromStep, summarize } from "../metrics/usage.js";
import { RevisionError } from "../revision/service.js";
import type { RevisionService } from "../revision/service.js";
import { readScores } from "../scoring/scoreVersion.js";
import { VersionNotFound } from "../signoff/checks.js";
import { Signoff, SignoffError } from "../signoff/signoff.js";
import type { LogicModelValidator } from "../steps/logicModelValidator.js";
import { Conflict } from "../store/store.js";
import type { Store } from "../store/store.js";

// Narrow view of the Orchestrator so the API depends on only what it calls.
export interface OrchestratorPort {
  createRun(pages: number[] | undefined, filename: string, createdBy?: string): Promise<Run>;
  resume(runId: string): Promise<void>;
  prepareResume(runId: string): Promise<void>;
  onUploaded(runId: string): Promise<void>;
  resumeAll(): Promise<void>;
  activeCount(): number;
  lastStatusChange(): number | undefined;
}

export interface ServerDeps {
  // Sign-in (DEC-015). When set, POST /runs and GET /runs need a valid Cognito ID token: the run records who
  // created it and the list shows each person the runs for their role. Absent (tests, dev:local): no sign-in.
  identity?: IdentityResolver;
  orchestrator: OrchestratorPort;
  store: Store;
  artifacts: ArtifactStore;
  validator: LogicModelValidator;
  presign: (key: string) => Promise<string>;
  onVersionSaved: (runId: string, n: number) => Promise<void>;
  // Sign-off service (findings, status, signatures). Default: one over the same store and artifacts.
  signoff?: Signoff;
  // Revision loop (comments -> AI instruction -> confirm -> new version). The routes exist only when given.
  revisions?: RevisionService;
  maxPages: number;
  now?: () => number;
  maxInvocationResponseBytes?: number;
  // false (default, tests) or the pino level of the request and error log.
  logger?: boolean | { level: string };
  // Structured request logs and latency/error metrics (CloudWatch). /ping is not logged.
  observe?: Logger;
  // Default "container". In "lambda" mode background work is awaited before responding
  // and POST /events (Lambda Web Adapter pass-through) is registered.
  runMode?: RunMode;
  eventsConcurrency?: number;
  eventsDeadlineMs?: number;
  backgroundDeadlineMs?: number;
  // Called after a clinician reject returned the run to awaiting_officer (re-triggers the officer agent). Errors are logged.
  onRejected?: (runId: string) => Promise<void>;
  // Called by the POST /events handler (lambda mode) when an officer async-invoke event arrives.
  onOfficerEvent?: (runId: string) => Promise<void>;
  // Chat settings; without them POST /runs/:id/chat answers 503.
  chat?: ClinicianDeps["chat"];
}

const BODY_LIMIT = 5 * 1024 * 1024;

function parseBody<T>(schema: ZodType<T>, body: unknown, reply: FastifyReply): T | undefined {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  void reply.code(400).send({ error: "invalid_request", issues });
  return undefined;
}

function parseVersionNumber(raw: string, reply: FastifyReply): number | undefined {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
  }
  void reply.code(400).send({ error: "invalid_request", issues: ["n: must be an integer"] });
  return undefined;
}

// Pattern segments (":id") become a strict single-segment class, so encoded or
// dotted tricks cannot reach another route through an "http" invocation.
const proxiableRegexes = routes.proxiable.map((p) => new RegExp("^" + p.replace(/:[A-Za-z]+/g, "[A-Za-z0-9_-]+") + "$"));
const selfPaths: readonly string[] = [routes.pattern.ping, routes.pattern.invocations];
const DROPPED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);

const messageIdOf = (rec: unknown): string | undefined => {
  const id = typeof rec === "object" && rec !== null ? (rec as { messageId?: unknown }).messageId : undefined;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

const errName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

// Runs fn over items with at most `limit` in flight; fn must not throw.
async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { orchestrator, store, artifacts, validator, presign, onVersionSaved, maxPages } = deps;
  const now = deps.now ?? Date.now;
  const runMode = deps.runMode ?? "container";
  const bgDeadline = deps.backgroundDeadlineMs ?? LAMBDA_BACKGROUND_DEADLINE_MS;
  const background = (work: Promise<unknown>, onError: (e: unknown) => void, onDeadline?: () => void): Promise<void> =>
    runBackground(runMode, work, onError, bgDeadline, onDeadline);
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: BODY_LIMIT });
  // With sign-in on, author / userId / role in request bodies come from the verified token (DEC-015).
  if (deps.identity) enforceRequestIdentity(app, deps.identity);
  const obs = deps.observe;
  if (obs) {
    app.addHook("onResponse", async (req, reply) => {
      const route = req.routeOptions.url ?? "unmatched";
      if (route === routes.pattern.ping) return;
      const ms = Math.round(reply.elapsedTime);
      const fields = { method: req.method, route, status: reply.statusCode, durationMs: ms, runId: (req.params as { id?: string } | undefined)?.id };
      if (reply.statusCode >= 500) obs.error("http.request", fields);
      else if (reply.statusCode >= 400) obs.warn("http.request", fields);
      else obs.info("http.request", fields);
      obs.metric("HttpLatencyMs", ms, "Milliseconds", { Route: `${req.method} ${route}` });
      if (reply.statusCode >= 500) obs.metric("Http5xx", 1, "Count", { Route: `${req.method} ${route}` });
      else if (reply.statusCode >= 400) obs.metric("Http4xx", 1, "Count", { Route: `${req.method} ${route}` });
    });
  }
  const signoff = deps.signoff ?? new Signoff({ store, artifacts, now });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof SignoffError) {
      const detail = typeof err.detail === "object" && err.detail !== null ? err.detail : {};
      return reply.code(err.status).send({ ...detail, error: err.code, message: err.message });
    }
    if (err instanceof RevisionError) return reply.code(err.status).send({ ...err.detail, error: err.code, message: err.message });
    if (err instanceof Conflict) {
      req.log.debug({ detail: err.message }, "conflict");
      return reply.code(409).send({ error: "conflict" });
    }
    if (err instanceof NotFound) return reply.code(404).send({ error: "not_found" });
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      if (status === 413) return reply.code(413).send({ error: "payload_too_large" });
      if (status === 415) return reply.code(415).send({ error: "unsupported_media_type" });
      return reply.code(status).send({ error: "invalid_request", issues: [] });
    }
    req.log.error({ errName: err.name }, "unhandled error");
    // The cause of the 5xx for CloudWatch (name and a short message; no request data).
    obs?.error("http.unhandled", { route: req.routeOptions.url, method: req.method, errName: err.name, error: err.message.slice(0, 300) });
    return reply.code(500).send({ error: "internal" });
  });

  app.post(routes.pattern.runs, async (req, reply) => {
    const body = parseBody(CreateRunRequest, req.body, reply);
    if (!body) return reply;
    const tooBig = (body.pages ?? []).filter((p) => p > maxPages);
    if (tooBig.length > 0) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: [`pages exceed maximum of ${maxPages}: ${tooBig.join(", ")}`],
      });
    }
    const who = deps.identity ? await deps.identity(req.headers.authorization) : undefined;
    if (who === null) return reply.code(401).send({ error: "unauthorized" });
    const run = await orchestrator.createRun(body.pages, body.filename, who?.userId);
    const uploadUrl = await presign(inputPdfKey(run.runId));
    const res: CreateRunResponse = { runId: run.runId, uploadUrl };
    return reply.code(201).send(res);
  });

  app.get(routes.pattern.runs, async (req, reply) => {
    const who = deps.identity ? await deps.identity(req.headers.authorization) : undefined;
    if (who === null) return reply.code(401).send({ error: "unauthorized" });
    const runs = await store.listRuns();
    return (who ? visibleRuns(runs, who) : runs).sort((a, b) => b.createdAt - a.createdAt);
  });

  app.get<{ Params: { id: string } }>(routes.pattern.run, async (req, reply) => {
    const run = await store.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    const steps = await store.listSteps(run.runId);
    // Revision model calls are not pipeline steps (DEC-003). Their usage comes from the audit trail (one read),
    // never from the revision artifacts, so a poll of this route does not grow with the number of revisions
    // and a damaged revision cannot break it.
    const revisionRows = deps.revisions ? await deps.revisions.usageRows(run.runId) : [];
    const { totals, byProcess, byVersion } = summarize([...steps.map(rowFromStep), ...revisionRows]);
    return { run, steps, totals, byProcess, byVersion };
  });

  app.get<{ Params: { id: string } }>(routes.pattern.metrics, async (req, reply) => {
    const run = await store.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    return buildRunMetrics(run, await store.listSteps(run.runId), { rates: loadAwsRates() });
  });

  app.get<{ Params: { id: string } }>(routes.pattern.versions, async (req, reply) => {
    if (!(await store.getRun(req.params.id))) return reply.code(404).send({ error: "not_found" });
    return store.listVersions(req.params.id);
  });

  app.get<{ Params: { id: string; n: string } }>(routes.pattern.version, async (req, reply) => {
    const n = parseVersionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    const version = await store.getVersion(req.params.id, n);
    if (!version) return reply.code(404).send({ error: "not_found" });
    const bytes = await artifacts.get(version.artifactKey);
    return { version, body: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  });

  app.post<{ Params: { id: string } }>(routes.pattern.versions, async (req, reply) => {
    const runId = req.params.id;
    if (!(await store.getRun(runId))) return reply.code(404).send({ error: "not_found" });
    const versions = await store.listVersions(runId);
    const latest = versions[versions.length - 1];
    if (!latest) return reply.code(409).send({ error: "no_base_version" });
    const req_ = parseBody(SaveVersionRequest, req.body, reply);
    if (!req_) return reply;
    if (req_.authorRole === "program_officer") return reply.code(403).send({ error: "agent_only" });
    if (req_.parentVersion !== latest.n) {
      req.log.debug({ parentVersion: req_.parentVersion, latest: latest.n }, "stale parentVersion");
      return reply.code(409).send({ error: "conflict" });
    }
    const result = validator.validate(req_.body);
    if (!result.ok) return reply.code(422).send({ error: "invalid_logic_model", issues: result.issues });

    const n = latest.n + 1;
    // The body must say where it sits in the chain: the store assigns n and the parent (AR-01), and a body
    // claiming another lineage would carry a misleading version into the README and the signatures (DEC-020).
    const meta = (req_.body as { meta?: { version?: unknown; parent_version?: unknown } }).meta ?? {};
    if (meta.version !== n || meta.parent_version !== latest.n) {
      return reply.code(422).send({
        error: "version_mismatch",
        issues: [`meta.version must be ${n} and meta.parent_version must be ${latest.n} (got ${String(meta.version)} and ${String(meta.parent_version)})`],
        expected: { version: n, parent_version: latest.n },
      });
    }
    await saveNewVersion(
      { store, artifacts, now },
      { runId, n, parent: latest.n, author: req_.author, ...(req_.authorRole !== undefined ? { authorRole: req_.authorRole } : {}), body: req_.body },
    );
    try {
      await onVersionSaved(runId, n);
    } catch (err) {
      req.log.error({ runId, n, errName: err instanceof Error ? err.name : "unknown" }, "onVersionSaved failed");
      // Saved, but the checks did not finish: never report plain success. The run is either failed at the
      // checks step (POST /resume runs them again) or keeps its state; findings are recomputed on the next read.
      return reply.code(201).send({
        n,
        checks_status: "failed",
        message: "The version was saved but its checks did not finish. They run again when the version is opened; if the run shows failed, resume it.",
      });
    }
    return reply.code(201).send({ n, checks_status: "ok" });
  });

  app.post<{ Params: { id: string; n: string } }>(routes.pattern.comments, async (req, reply) => {
    const n = parseVersionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    if (!(await store.getVersion(req.params.id, n))) return reply.code(404).send({ error: "not_found" });
    const body = parseBody(CreateCommentRequest, req.body, reply);
    if (!body) return reply;
    const comment = {
      runId: req.params.id,
      n,
      itemRef: body.itemRef,
      author: body.author,
      text: body.text,
      createdAt: now(),
    };
    await store.addComment(comment);
    return reply.code(201).send(comment);
  });

  app.get<{ Params: { id: string; n: string } }>(routes.pattern.comments, async (req, reply) => {
    const n = parseVersionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    if (!(await store.getVersion(req.params.id, n))) return reply.code(404).send({ error: "not_found" });
    return store.listComments(req.params.id, n);
  });

  // ---------- sign-off (BRD AR-01 to AR-10, DEC-019) ----------

  app.get<{ Params: { id: string; n: string }; Querystring: Record<string, string> }>(routes.pattern.findings, async (req, reply) => {
    const n = parseVersionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    const q = parseBody(FindingsQuery, req.query ?? {}, reply);
    if (!q) return reply;
    return signoff.findingsView(req.params.id, n, q.audience);
  });

  // The stored flags.json of a version (cross-check flags, one document per content and inputs).
  app.get<{ Params: { id: string; n: string } }>(routes.pattern.flags, async (req, reply) => {
    const n = parseVersionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    return signoff.flagsDocument(req.params.id, n);
  });

  app.get<{ Params: { id: string; n: string } }>(routes.pattern.status, async (req, reply) => {
    const n = parseVersionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    return signoff.status(req.params.id, n);
  });

  // Advisory quote-support scores for the current content of version n (src/scoring). Read only: scoring
  // runs in the pipeline after the checks. "not_scored" when scoring is off, failed or not run for this content.
  app.get<{ Params: { id: string; n: string } }>(routes.pattern.scores, async (req, reply) => {
    const n = parseVersionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    let found: Awaited<ReturnType<typeof readScores>>;
    try {
      found = await readScores({ store, artifacts }, req.params.id, n);
    } catch (e) {
      if (e instanceof VersionNotFound || e instanceof NotFound) return reply.code(404).send({ error: "not_found" });
      throw e;
    }
    if (!found) return { runId: req.params.id, n, status: "not_scored" };
    return { runId: req.params.id, n, status: "scored", modelSha: found.modelSha, ...found.scores };
  });

  app.post<{ Params: { id: string; n: string; role: string } }>(routes.pattern.sign, async (req, reply) => {
    const n = parseVersionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    // AUTH SEAM (DEC-015, not built): role and userId are taken from the body. With Cognito they come from
    // the verified JWT (group -> role, sub -> userId) and the body carries only modelSha. The role check
    // against the endpoint and every sign-off rule stay server-side in Signoff.sign either way.
    const body = parseBody(SignRequest, req.body, reply);
    if (!body) return reply;
    const res = await signoff.sign(req.params.id, n, req.params.role, body);
    return reply.code(201).send(res);
  });

  // AR-06, RR-02 (DEC-020): the clinician rejects the officer-signed version with a comment on the rule.
  app.post<{ Params: { id: string; n: string } }>(routes.pattern.reject, async (req, reply) => {
    const n = parseVersionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    // AUTH SEAM (DEC-015): role and userId from the body until Cognito, as for signatures.
    const body = parseBody(RejectRequest, req.body, reply);
    if (!body) return reply;
    const res = await signoff.reject(req.params.id, n, body);
    if (deps.onRejected) {
      const runId = req.params.id;
      await background(deps.onRejected(runId), (err) => app.log.error({ runId, errName: errName(err) }, "onRejected failed"));
    }
    return reply.code(201).send(res);
  });

  // The clinician accepts blocking findings they decide ("keep"): recorded with name and reason, then they stop blocking.
  app.post<{ Params: { id: string; n: string } }>(routes.pattern.acknowledge, async (req, reply) => {
    const n = parseVersionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    // AUTH SEAM (DEC-015): role and userId from the body until Cognito, as for signatures.
    const body = parseBody(AcknowledgeRequest, req.body, reply);
    if (!body) return reply;
    return reply.code(201).send(await signoff.acknowledge(req.params.id, n, body));
  });

  // ---------- revision loop ----------
  const revisions = deps.revisions;
  if (revisions) {
    // AUTH SEAM (DEC-015): role and userId from the body until Cognito, as for signatures.
    app.post<{ Params: { id: string; n: string } }>(routes.pattern.revisions, async (req, reply) => {
      const n = parseVersionNumber(req.params.n, reply);
      if (n === undefined) return reply;
      const body = parseBody(CreateRevisionRequest, req.body, reply);
      if (!body) return reply;
      const rev = await revisions.requestRevision(req.params.id, n, { role: body.role, userId: body.userId, ...(body.itemRefs !== undefined ? { itemRefs: body.itemRefs } : {}) });
      return reply.code(201).send(rev);
    });

    app.get<{ Params: { id: string; n: string } }>(routes.pattern.revisions, async (req, reply) => {
      const n = parseVersionNumber(req.params.n, reply);
      if (n === undefined) return reply;
      return revisions.listRevisions(req.params.id, n);
    });

    app.get<{ Params: { id: string; rid: string } }>(routes.pattern.revision, async (req) => revisions.getRevision(req.params.id, req.params.rid));

    app.post<{ Params: { id: string; rid: string } }>(routes.pattern.revisionConfirm, async (req, reply) => {
      const body = parseBody(ConfirmRevisionRequest, req.body, reply);
      if (!body) return reply;
      // 202: step 2 runs in the background (API Gateway cuts a request at 30 s). Poll GET revision.
      const rev = await revisions.confirmRevision(req.params.id, req.params.rid, { role: body.role, userId: body.userId, ...(body.instruction !== undefined ? { instruction: body.instruction } : {}) });
      return reply.code(202).send(rev);
    });
  }

  app.post<{ Params: { id: string } }>(routes.pattern.resume, async (req, reply) => {
    const run = await store.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    if (run.state !== "failed") return reply.code(409).send({ error: "not_failed" });
    const runId = run.runId;
    if (runMode === "lambda") {
      // An HTTP API gives up after 30 s and Lambda freezes work once the response is sent, so do
      // only the quick failed -> step-state transition. The run is then in a work state with no
      // lease and the scheduled sweep (listResumable) advances it within minutes.
      await orchestrator.prepareResume(runId);
      return reply.code(202).send({ runId });
    }
    await background(orchestrator.resume(runId), (err) => app.log.error({ runId, errName: errName(err) }, "resume failed"), () =>
      app.log.warn({ runId }, "resume still running at the lambda deadline; response sent anyway"),
    );
    return reply.code(202).send({ runId });
  });

  registerClinicianRoutes(app, { store, artifacts, signoff, validator, onVersionSaved, now, ...(deps.chat ? { chat: deps.chat } : {}) });

  // AgentCore Runtime HTTP contract. The busy flag comes from the in-process active set.
  app.get(routes.pattern.ping, async () => {
    const status: PingResponse["status"] = orchestrator.activeCount() > 0 ? "HealthyBusy" : "Healthy";
    const changed = orchestrator.lastStatusChange();
    const res: PingResponse = changed === undefined ? { status } : { status, time_of_last_update: Math.floor(changed / 1000) };
    return res;
  });

  if (runMode === "agentcore") {
  const maxResponseBytes = deps.maxInvocationResponseBytes ?? INVOCATION_MAX_BODY_BYTES;
  const accepted: InvocationResponse = { accepted: true };
  app.post(routes.pattern.invocations, async (req, reply) => {
    const body = parseBody(InvocationRequest, req.body, reply);
    if (!body) return reply;
    if (body.action === "uploaded") {
      const runId = body.runId;
      await background(orchestrator.onUploaded(runId), (err) =>
        app.log.error({ runId, errName: errName(err) }, "onUploaded failed"),
      );
      return reply.code(202).send(accepted);
    }
    if (body.action === "resume_all") {
      await background(orchestrator.resumeAll(), (err) => app.log.error({ errName: errName(err) }, "resumeAll failed"));
      return reply.code(202).send(accepted);
    }
    const pathname = body.path.split(/[?#]/)[0] ?? "";
    if (selfPaths.includes(pathname.replace(/\/+$/, ""))) {
      return reply.code(400).send({ error: "path_not_allowed" });
    }
    if (!proxiableRegexes.some((re) => re.test(pathname))) return reply.code(404).send({ error: "not_found" });
    const headers = Object.fromEntries(Object.entries(body.headers ?? {}).filter(([k]) => !DROPPED_HEADERS.has(k.toLowerCase())));
    const inner = await app.inject({
      method: body.method,
      url: body.path,
      headers,
      ...(body.body === undefined ? {} : { payload: body.body }),
    });
    if (Buffer.byteLength(inner.body) > maxResponseBytes) return reply.code(502).send({ error: "response_too_large" });
    const contentType = inner.headers["content-type"];
    const out: InvocationResponse = {
      statusCode: inner.statusCode,
      headers: typeof contentType === "string" ? { "content-type": contentType } : {},
      body: inner.body,
    };
    return reply.code(200).send(out);
  });
  }

  if (runMode === "lambda") {
    // Non-HTTP Lambda events forwarded by the Lambda Web Adapter. Everything is awaited:
    // Lambda freezes the process once this response is sent.
    const concurrency = deps.eventsConcurrency ?? 4;
    const eventsDeadline = deps.eventsDeadlineMs ?? LAMBDA_BACKGROUND_DEADLINE_MS;
    app.post(routes.pattern.events, async (req, reply) => {
      // The revision loop's own asynchronous invoke (LambdaAsyncDispatcher). runApply is idempotent and writes
      // "failed" itself, so the answer is 200 even after a failure: a 5xx would only make Lambda retry (twice).
      const rev = LambdaRevisionEvent.safeParse(req.body);
      if (rev.success) {
        if (!revisions) return reply.code(400).send({ error: "invalid_request", issues: ["revision loop not configured"] });
        const { runId, revisionId } = rev.data;
        const work = revisions.runApply(runId, revisionId).catch((e: unknown) => {
          req.log.error({ runId, revisionId, errName: errName(e) }, "revision runApply threw");
        });
        if (!(await withDeadline(work, eventsDeadline))) {
          req.log.error({ runId, revisionId }, "revision step reached the events deadline; it is reported as failed once stale");
        }
        return reply.code(200).send({ ok: true });
      }
      const envelope = LambdaSqsEnvelope.safeParse(req.body);
      if (envelope.success) {
        const ids = new Map<number, string>();
        const finished = new Set<number>();
        const failed = new Set<number>();
        let stopped = false;
        const indexes = envelope.data.Records.map((_, i) => i);
        const work = forEachLimited(indexes, concurrency, async (i) => {
          if (stopped) return;
          const parsed = LambdaSqsRecord.safeParse(envelope.data.Records[i]);
          if (!parsed.success) {
            req.log.warn({ index: i }, "malformed record; consumed");
            finished.add(i);
            return;
          }
          const rec = parsed.data;
          ids.set(i, rec.messageId);
          try {
            const runIds = [...new Set(parseS3Event(rec.body).map((o) => o.runId))];
            if (runIds.length === 0) req.log.info({ messageId: rec.messageId }, "record has no uploaded input; consumed");
            for (const runId of runIds) {
              try {
                await orchestrator.onUploaded(runId);
              } catch (e) {
                if (!(e instanceof NotFound)) throw e;
                req.log.warn({ messageId: rec.messageId }, "unknown run; consumed");
              }
            }
            finished.add(i);
          } catch (e) {
            req.log.error({ messageId: rec.messageId, errName: errName(e) }, "record failed; left for redelivery");
            failed.add(i);
          }
        });
        const completed = await withDeadline(work, eventsDeadline);
        if (!completed) {
          stopped = true;
          req.log.error({ unfinished: indexes.length - finished.size - failed.size }, "events deadline reached; unfinished records left for redelivery");
        }
        const items = indexes
          .filter((i) => failed.has(i) || !finished.has(i))
          .flatMap((i) => {
            const id = ids.get(i) ?? messageIdOf(envelope.data.Records[i]);
            return id === undefined ? [] : [{ itemIdentifier: id }];
          });
        const res: LambdaEventResponse = { batchItemFailures: items };
        return reply.code(200).send(res);
      }
      if (LambdaScheduledEvent.safeParse(req.body).success) {
        // Same deadline as the batch handling: an invocation killed at the Lambda timeout is retried by Lambda.
        if (!(await withDeadline(orchestrator.resumeAll(), eventsDeadline))) {
          req.log.error("scheduled resume-all reached the deadline; remaining runs left for the next sweep");
        }
        const res: LambdaEventResponse = { batchItemFailures: [] };
        return reply.code(200).send(res);
      }
      const officer = LambdaOfficerEvent.safeParse(req.body);
      if (officer.success) {
        // Officer agent async self-invoke: decoupled from POST /versions so the route responds before the
        // agent runs and does not hit the API Gateway 30 s integration timeout.
        const { runId } = officer.data;
        if (deps.onOfficerEvent) {
          const work = deps.onOfficerEvent(runId).catch((e: unknown) => {
            req.log.error({ runId, errName: errName(e) }, "officer agent event threw");
          });
          if (!(await withDeadline(work, eventsDeadline))) {
            req.log.error({ runId }, "officer agent event reached the events deadline");
          }
        }
        return reply.code(200).send({ ok: true });
      }
      return reply.code(400).send({ error: "invalid_request", issues: ["unrecognised event"] });
    });
  }

  return app;
}
