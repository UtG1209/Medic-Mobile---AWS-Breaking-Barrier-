import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.ts";
import { createApp } from "../src/server.ts";

const SAMPLE = new URL("../samples/cough-guideline-sample.pdf", import.meta.url);
let base = "";
let dir = "";
let app: Awaited<ReturnType<typeof createApp>>;

const freePort = () => new Promise<number>(r => { const s = createServer(); s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "pipeline-test-"));
  const port = await freePort();
  base = `http://localhost:${port}`;
  app = await createApp({ ...config, dataDir: dir, port, publicUrl: base, pollMs: 50 });
  await app.listen(port);
});
after(async () => { await app.stop(); await rm(dir, { recursive: true, force: true }); });

async function upload(fileName: string, body: Buffer) {
  const r = await fetch(base + "/guidelines/upload-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileName, size: body.length, contentType: "application/pdf" }) });
  assert.equal(r.status, 201);
  const j = await r.json() as { guideline: { id: string; status: string }; upload: { url: string; headers: Record<string, string> } };
  assert.equal(j.guideline.status, "Uploading");
  const put = await fetch(j.upload.url, { method: "PUT", headers: j.upload.headers, body: new Uint8Array(body) });
  assert.equal(put.status, 200);
  return j.guideline.id;
}
async function waitFor(id: string, done: (s: string) => boolean) {
  for (let i = 0; i < 100; i++) {
    const g = await (await fetch(`${base}/guidelines/${id}`)).json() as { status: string; steps: { key: string; state: string }[]; pages: number | null; error?: string };
    if (done(g.status)) return g;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for " + id);
}

test("PDF goes upload -> S3 event -> queue -> extract -> digest -> logic model", async () => {
  const id = await upload("Cough guideline (sample).pdf", await readFile(SAMPLE));
  const g = await waitFor(id, s => s === "Indexed" || s === "Failed" || s === "Unsupported");
  assert.equal(g.status, "Indexed", g.error);
  assert.equal(g.pages, 2);
  assert.deepEqual(g.steps.map(s => s.state), ["done", "done", "done", "done", "done"]);

  const env = await (await fetch(`${base}/guidelines/${id}/logic-model`)).json() as { format: string; source: string; summary: Record<string, number>; model: { pathway: string } };
  assert.equal(env.format, "logic-tree/2.0");
  assert.equal(env.source, "placeholder");
  assert.equal(env.model.pathway, "Child cough and fast breathing");
  assert.deepEqual(env.summary, { inputs: 20, derived: 3, nodes: 6, leaves: 7, actions: 7, flags: 11 });

  const digest = await (await fetch(`${base}/guidelines/${id}/digest`)).json() as { stats: { blocks: number } };
  assert.ok(digest.stats.blocks > 10);
});

test("unreadable file type ends Unsupported with a reason", async () => {
  const id = await upload("scan.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const g = await waitFor(id, s => s !== "Uploading" && s !== "Processing");
  assert.equal(g.status, "Unsupported");
  assert.match(g.error ?? "", /Textract/);
  assert.equal((await fetch(`${base}/guidelines/${id}/logic-model`)).status, 409);
});

test("upload URL with a bad signature is refused", async () => {
  const r = await fetch(base + "/guidelines/upload-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileName: "a.txt", size: 1 }) });
  const j = await r.json() as { upload: { url: string } };
  const bad = j.upload.url.replace(/X-Signature=[0-9a-f]+/, "X-Signature=" + "0".repeat(64));
  assert.equal((await fetch(bad, { method: "PUT", body: "x" })).status, 403);
  assert.equal((await fetch(base + "/local-s3/" + config.bucket + "/uploads/../../etc?X-Expires=1&X-Signature=00", { method: "PUT", body: "x" })).status >= 400, true);
});
