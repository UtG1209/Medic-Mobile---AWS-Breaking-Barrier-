// Test children and form settings for a run of samples/demo-quick-guideline.pdf (the 2-page demo chart).
//
// The AI names questions and results differently on every upload, so this reads the run's latest version, finds
// each chart question and result by meaning, and writes the expected result for 7 test children as the chart
// states it (not as the draft computes it). Prints the matching so you can check it, then writes:
//   <out>/golden_cases.json      -> s3://<artifact bucket>/runs/<runId>/inputs/golden_cases.json
//   <out>/compile_settings.json  -> s3://<artifact bucket>/runs/<runId>/inputs/compile_settings.json
// The next saved version (for example the clinician's approval) is checked with them.
//
// Usage: npx tsx scripts/demoInputs.ts <API base URL> <runId> [outDir]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type Q = { id: string; label: string; answer_type: string };
type O = { id: string; title: string; severity: number };

const [api, runId, outDir = "demo-inputs"] = process.argv.slice(2);
if (!api || !runId) {
  console.error("usage: npx tsx scripts/demoInputs.ts <API base URL> <runId> [outDir]");
  process.exit(2);
}
const get = async (p: string): Promise<any> => {
  const r = await fetch(api.replace(/\/+$/, "") + p);
  if (!r.ok) throw new Error(`GET ${p}: ${r.status}`);
  return r.json();
};

const versions = (await get(`/runs/${runId}/versions`)) as { n: number }[];
const n = versions[versions.length - 1]!.n;
const body = (await get(`/runs/${runId}/versions/${n}`)).body as { questions: Q[]; outcomes: O[] };

const fail: string[] = [];
const pick = <T extends { id: string }>(what: string, list: T[], text: (x: T) => string, re: RegExp, not?: RegExp): T | undefined => {
  const hits = list.filter((x) => re.test(text(x)) && !(not?.test(text(x)) ?? false));
  if (hits.length !== 1) fail.push(`${what}: ${hits.length} matches (${hits.map((h) => h.id).join(", ") || "none"})`);
  return hits[0];
};
const qText = (q: Q) => `${q.id} ${q.label}`;
const q = {
  age: pick("age question", body.questions, qText, /\bage\b|month/i),
  cough: pick("cough question", body.questions, qText, /cough/i),
  convulsions: pick("convulsions question", body.questions, qText, /convuls/i),
  drink: pick("drink question", body.questions, qText, /drink|breastfeed/i),
  indrawing: pick("chest indrawing question", body.questions, qText, /indrawing/i),
  breaths: pick("breaths question", body.questions, qText, /breath/i),
};
const oText = (o: O) => `${o.id} ${o.title}`;
const others = body.outcomes.filter((o) => !/outside_age_range/.test(o.id));
const o = {
  ageUrgent: body.outcomes.find((x) => x.id === "refer_urgent_outside_age_range"),
  age: body.outcomes.find((x) => x.id === "refer_outside_age_range"),
  danger: pick("danger sign result", others, oText, /danger|refer|immediate/i),
  fast: pick("fast breathing result", others, oText, /fast|pneumonia|amoxicillin|treat/i, /no treatment|danger|refer/i),
  homeCare: pick("cough home care result", others, oText, /home care|cough/i, /fast|no cough|no treatment|pneumonia/i),
  none: pick("no treatment result", others, oText, /no treatment|no cough|none|well/i),
};
if (o.ageUrgent === undefined) fail.push("result refer_urgent_outside_age_range not found");
if (o.age === undefined) fail.push("result refer_outside_age_range not found");
if (fail.length > 0) {
  console.error(`Could not match the demo chart in run ${runId} v${n}:\n- ${fail.join("\n- ")}`);
  console.error(`questions: ${body.questions.map(qText).join(" | ")}\nresults: ${body.outcomes.map(oText).join(" | ")}`);
  process.exit(1);
}

// One child per chart box plus both out-of-age results. Ages and counts sit away from the cut-offs except where the
// case is about a cut-off (exactly 50 breaths at 6 months is fast).
const child = (age: number, a: Partial<Record<"cough" | "convulsions" | "drink" | "indrawing", boolean>>, breaths: number) => ({
  [q.age!.id]: age,
  [q.cough!.id]: a.cough ?? false,
  [q.convulsions!.id]: a.convulsions ?? false,
  [q.drink!.id]: a.drink ?? false,
  [q.indrawing!.id]: a.indrawing ?? false,
  [q.breaths!.id]: breaths,
});
const cases = [
  { id: "demo1", description: "18 months, convulsions: any danger sign, box 1", answers: child(18, { convulsions: true, cough: true }, 30), expected_outcome: o.danger!.id },
  { id: "demo2", description: "6 months, cough, exactly 50 breaths: fast breathing, box 2", answers: child(6, { cough: true }, 50), expected_outcome: o.fast!.id },
  { id: "demo3", description: "24 months, cough, 44 breaths: fast breathing, box 2", answers: child(24, { cough: true }, 44), expected_outcome: o.fast!.id },
  { id: "demo4", description: "24 months, cough, 30 breaths: cough, no fast breathing, box 3", answers: child(24, { cough: true }, 30), expected_outcome: o.homeCare!.id },
  { id: "demo5", description: "24 months, no cough, 30 breaths: none of the boxes, box 4", answers: child(24, {}, 30), expected_outcome: o.none!.id },
  { id: "demo6", description: "1 month, no danger sign: outside the chart's ages, refer", answers: child(1, { cough: true }, 40), expected_outcome: o.age!.id },
  { id: "demo7", description: "1 month, chest indrawing: outside the chart's ages with a danger sign, refer urgently", answers: child(1, { indrawing: true }, 40), expected_outcome: o.ageUrgent!.id },
].map((c) => ({ ...c, note: "Demo test child for samples/demo-quick-guideline.pdf; expected result as the chart states it." }));

const settings = { formTitle: "Cough and fast breathing (demo)", icon: "icon-healthcare", taskWindowDays: 2, contactTypes: { person: true, place: false }, flowMode: "minimal" };

console.log(`run ${runId} v${n}`);
for (const [k, v] of Object.entries(q)) console.log(`  question ${k.padEnd(10)} -> ${v!.id}`);
for (const [k, v] of Object.entries(o)) console.log(`  result   ${k.padEnd(10)} -> ${v!.id}  (${v!.title.slice(0, 60)})`);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "golden_cases.json"), JSON.stringify(cases, null, 2) + "\n");
writeFileSync(path.join(outDir, "compile_settings.json"), JSON.stringify(settings, null, 2) + "\n");
console.log(`wrote ${path.join(outDir, "golden_cases.json")} (${cases.length} children) and ${path.join(outDir, "compile_settings.json")}`);
