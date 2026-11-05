// Live run of the fill_logic step against real Amazon Bedrock, on the real extraction
// (extraction/extraction_output.json, public WHO/UNICEF booklet, no patient data).
// Run from Backend/:  npm run fill:live [-- --out <dir>]
// Needs AWS credentials (SSO profile or role) with Bedrock access in AWS_REGION (default us-west-2).
// Without credentials it prints a note and exits 0 without calling anything.
// Writes the draft, the resolved logic model and the run's usage to <dir> (default: a new temp folder).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryArtifactStore, artifactKey } from "../src/artifacts/artifactStore.js";
import { createStrandsModelClient } from "../src/model/strands.js";
import { createFillLogicStep } from "../src/steps/fillLogic.js";
import { parseModelValidator } from "../src/steps/logicModelValidator.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { cost as costOf, loadPrices } from "../src/metrics/cost.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, "..");

function hasAwsCredentials(env: NodeJS.ProcessEnv): boolean {
  if (env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE || env.AWS_WEB_IDENTITY_TOKEN_FILE || env.AWS_CONTAINER_CREDENTIALS_FULL_URI || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) return true;
  const aws = path.join(homedir(), ".aws");
  return existsSync(path.join(aws, "credentials")) || existsSync(path.join(aws, "config"));
}

async function main(): Promise<void> {
  if (!hasAwsCredentials(process.env)) {
    console.log("fill:live skipped: no AWS credentials found (set AWS_PROFILE after `aws sso login`, or run with a role).");
    return;
  }
  const outFlag = process.argv.indexOf("--out");
  const outDir = outFlag > 0 && process.argv[outFlag + 1] ? path.resolve(process.argv[outFlag + 1] as string) : mkdtempSync(path.join(tmpdir(), "fill-live-"));
  mkdirSync(outDir, { recursive: true });

  const region = process.env.AWS_REGION || "us-west-2";
  const modelId = process.env.FILL_MODEL_ID || process.env.MODEL_ID || "us.anthropic.claude-haiku-4-5-20251001-v1:0";
  const runId = "fill-live";

  const artifacts = new MemoryArtifactStore();
  await artifacts.put(artifactKey(runId, "extract", "extraction_output.json"), readFileSync(path.join(backend, "extraction", "extraction_output.json")));
  const blocks = path.join(backend, "extraction", "input_blocks.json");
  if (existsSync(blocks)) await artifacts.put(artifactKey(runId, "ingest", "input_blocks.json"), readFileSync(blocks));

  const step = createFillLogicStep({
    validator: parseModelValidator,
    modelId,
    promptPath: process.env.FILL_PROMPT || path.join(backend, "extraction", "fill_prompt.txt"),
    pathwayId: "cough_fast_breathing",
  });
  const store = new MemoryStore();
  const started = Date.now();
  const res = await step.run({
    run: { runId, state: "filling_logic", createdAt: started },
    store,
    artifacts,
    model: createStrandsModelClient({ region }),
    now: () => Date.now(),
  });
  const latencyMs = Date.now() - started;

  const read = async (k: string): Promise<string> => new TextDecoder().decode(await artifacts.get(k));
  for (const [name, key] of Object.entries(res.artifactRefs)) writeFileSync(path.join(outDir, `${name}.json`), await read(key));
  for (const raw of ["raw_response.txt", "raw_repair.txt"]) {
    const k = artifactKey(runId, "fill_logic", raw);
    if (await artifacts.exists(k)) writeFileSync(path.join(outDir, raw), await read(k));
  }
  const prices = loadPrices(process.env);
  const cost = res.usage ? costOf(prices, res.usage.modelId, res.usage.inputTokens, res.usage.outputTokens) : undefined;
  const usage = { ...res.usage, latencyMs, ...(cost !== undefined ? { costUsd: cost } : {}) };
  writeFileSync(path.join(outDir, "usage.json"), JSON.stringify(usage, null, 2));
  console.log(JSON.stringify({ outDir, usage }));
}

main().catch((e: unknown) => {
  console.error(`fill:live failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
