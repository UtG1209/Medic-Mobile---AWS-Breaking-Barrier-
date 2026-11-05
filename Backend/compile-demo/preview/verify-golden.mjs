// Verifies the cht-conf compiled form against (a) the golden cases and (b) the logic interpreter.
//
// Run from Backend with `npm run compile:verify` (tsx, so the TypeScript interpreter in src/logic is
// imported directly). The compiled form runs in headless Chrome inside the preview page, i.e. in
// enketo-core 7.2.5 + openrosa-xpath-evaluator 2.0.13 with the CHT webapp's config.
//
//   1. Golden cases (tests/fixtures/logic/golden-testcases.json): UI level. Each case is typed into
//      the real inputs (radio clicks, number fields + change), the real Next button is pressed, and
//      the saved calculate values and the visible result notes are read. Only the screens that
//      appear are answered (the derived flow skips questions that cannot change the outcome), and
//      the visible screen sequence must equal the sequence the flow asks for that case.
//   2. Edit scenarios (UI level): answers changed after the fact, so hidden questions hold stale
//      values, as a health worker could do.
//   3. Differential grid (model level, one browser page): every point of enumerateAnswers(model),
//      fresh form per point, ALL answers set (hidden questions are treated as blank by enketo, as in
//      CHT), compared with evaluate() on the FULL answers for outcome and result notes; fast_breathing
//      and danger_sign against evaluate() on the shown answers; shown questions against the flow.
//   4. Partial answers (model level, informational): grid points with one shown question left
//      empty, compared with evaluate(..., { allowMissing: true }). Such forms cannot be submitted
//      (every question is required), so this only probes empty-field semantics.
//
// Writes compile-demo/output/VERIFY.md and verify-result.json, and adds a linked section to REPORT.md.
// Exit code 0 only if there are no mismatches in 1 to 3.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync, readdirSync } from "node:fs";
import { BACKEND_DIR, FORM_XML, OUTPUT_DIR, ensureDeps } from "./paths.mjs";
import { deriveFlow, effectiveShownWhen, enumerateAnswers, evalFlowCondition, evaluate, modelSha, parseModel, walkFlow } from "../../src/logic/index.ts";
import { flowOptionsFor } from "../../src/compiler/flowMode.ts";

ensureDeps();
const { buildPreview } = await import("./build-preview.mjs");
const { openPreview, toFormAnswers } = await import("./driver.mjs");

if (!existsSync(FORM_XML)) {
  console.error("No compiled form: run `npm run compile:demo` first.");
  process.exit(1);
}

const FIXTURES = join(BACKEND_DIR, "tests", "fixtures", "logic");
const parsed = parseModel(JSON.parse(readFileSync(join(FIXTURES, "v1.json"), "utf8")));
if (!parsed.ok) throw new Error("v1.json does not parse: " + parsed.issues.join("; "));
const model = parsed.value;
const golden = JSON.parse(readFileSync(join(FIXTURES, "golden-testcases.json"), "utf8"));

// The flow mode the compiled form was built with (manifest written by compile:demo).
const manifest = JSON.parse(readFileSync(join(OUTPUT_DIR, "manifest.json"), "utf8"));
const FLOW_MODE = manifest.flow?.mode ?? "full";
const flowOpts = flowOptionsFor(FLOW_MODE);
const flow = flowOpts ? deriveFlow(model, flowOpts) : null;
const relevance = new Map(model.questions.map((q) => [q.id, flow ? effectiveShownWhen(model, flow, q.id) : (q.shown_when ?? null)]));
/** What the compiled form shows for these answers: questions in model order, and the answers kept (others blank). */
function visible(answers) {
  const form = {};
  const seq = [];
  for (const q of model.questions) {
    if (evalFlowCondition(relevance.get(q.id) ?? null, form)) {
      seq.push(q.id);
      if (answers[q.id] !== undefined) form[q.id] = answers[q.id];
    }
  }
  return { form, seq };
}
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
console.log(`flowMode of the compiled form: ${FLOW_MODE}`);

const yn = (b) => (b ? "yes" : "no");

/** Result notes the model says should show: the outcome note plus dose notes whose age band holds. */
function expectedNotes(outcomeId, effective) {
  const o = model.outcomes.find((x) => x.id === outcomeId);
  const notes = [`outcome_${outcomeId}`];
  const age = effective.age_months;
  (o?.actions ?? []).forEach((a, ai) =>
    (a.dose_by_age ?? []).forEach((band, bi) => {
      if (typeof age === "number" && age >= band.age_months_min && age < band.age_months_below) notes.push(`outcome_${outcomeId}_dose_${ai + 1}_${bi + 1}`);
    }),
  );
  return notes.sort();
}

function interp(answers, opts) {
  const e = evaluate(model, answers, opts);
  return {
    outcome: e.outcome,
    fast_breathing: yn(e.derived.fast_breathing),
    danger_sign: yn(e.derived.danger_sign),
    notes: expectedNotes(e.outcome, e.effective),
  };
}

const sameNotes = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const fmtAnswers = (a) =>
  Object.entries(a)
    .map(([k, v]) => `${k}=${typeof v === "boolean" ? yn(v) : v}`)
    .join(", ");

console.log("building preview from the current compiled form...");
await buildPreview({ quiet: true });
const { browser, api, problems } = await openPreview();
const t0 = Date.now();

// ------------------------------------------------------------------ 1. golden cases (UI)
const goldenRows = [];
for (const g of golden) {
  await api.restart();
  const fill = await api.fillWizard(toFormAnswers(g.answers));
  const advanced = await api.next();
  const st = await api.state();
  const submitted = advanced ? await api.submit() : false;
  const ip = interp(g.answers);
  const vis = visible(g.answers);
  const ipShown = interp(vis.form, { allowMissing: true });
  const treeSeq = flow ? walkFlow(flow, g.answers).asked : vis.seq;
  const expectedSkipped = Object.keys(g.answers).filter((k) => !vis.seq.includes(k)).sort();
  const notes = st.visibleNotes.map((n) => n.name.split("/").pop()).sort();
  const row = {
    id: g.id,
    screens: fill.answered,
    expected_screens: vis.seq,
    tree_screens: treeSeq,
    skipped: [...fill.notShown].sort(),
    expected_skipped: expectedSkipped,
    description: g.description,
    expected: g.expected_outcome,
    interpreter: ip.outcome,
    form: st.calcs.outcome,
    form_fast_breathing: st.calcs.fast_breathing,
    form_danger_sign: st.calcs.danger_sign,
    interp_fast_breathing: ipShown.fast_breathing,
    interp_danger_sign: ipShown.danger_sign,
    notes,
    expected_notes: ip.notes,
    note_text: st.visibleNotes.map((n) => n.text),
    advanced,
    submitted,
    not_shown: fill.notShown,
    errors: st.errors,
  };
  row.pass =
    advanced &&
    submitted &&
    row.form === row.expected &&
    row.interpreter === row.expected &&
    row.form_fast_breathing === row.interp_fast_breathing &&
    row.form_danger_sign === row.interp_danger_sign &&
    sameNotes(notes, ip.notes) &&
    sameList(row.screens, row.expected_screens) &&
    sameList(row.tree_screens, row.expected_screens) &&
    sameList(row.skipped, row.expected_skipped);
  goldenRows.push(row);
  console.log(`${row.pass ? "PASS" : "FAIL"} ${g.id} expected=${row.expected} interpreter=${row.interpreter} form=${row.form} screens=${row.screens.length} notes=${notes.join("+")}`);
}

// ------------------------------------------------------------------ 2. edit scenarios (UI)
const NO_SIGNS = { convulsions: false, not_able_to_drink_or_feed: false, vomits_everything: false, chest_indrawing: false, unusually_sleepy: false };
const EDITS = [
  {
    id: "e1",
    description: "Cough 20 days (danger sign) entered, then cough changed to no: hidden cough_days keeps 20",
    first: { age_months: 24, cough: true, cough_days: 20, ...NO_SIGNS, breaths_per_minute: 30 },
    change: { cough: false },
  },
  {
    id: "e2",
    description: "52 breaths at 6 months (fast) entered, then cough changed to no: hidden breaths keep 52",
    first: { age_months: 6, cough: true, cough_days: 3, ...NO_SIGNS, breaths_per_minute: 52 },
    change: { cough: false },
  },
  {
    id: "e3",
    description: "Cough no first, then cough yes with 3 days and 45 breaths at 24 months",
    first: { age_months: 24, cough: false, ...NO_SIGNS },
    change: { cough: true, cough_days: 3, breaths_per_minute: 45 },
  },
  {
    id: "e4",
    description: "Fast breathing at 6 months, then age corrected to 70 months",
    first: { age_months: 6, cough: true, cough_days: 3, ...NO_SIGNS, breaths_per_minute: 52 },
    change: { age_months: 70 },
  },
];
const editRows = [];
for (const s of EDITS) {
  await api.restart();
  await api.fillWizard(toFormAnswers(s.first));
  for (const [k, v] of Object.entries(toFormAnswers(s.change))) await api.setQuestion(k, v);
  // With a derived flow an edit can bring back screens that were skipped (still unanswered), so the
  // health worker walks the form again from the first screen; stale values in now-hidden questions stay.
  const final = { ...s.first, ...s.change };
  await api.firstPage();
  const refill = await api.fillWizard(toFormAnswers(final));
  const advanced = await api.next();
  const st = await api.state();
  const submitted = advanced ? await api.submit() : false;
  // Outcome: the interpreter on the full final answers (it drops answers to questions hidden by shown_when).
  const ip = interp(final);
  const vis = visible(final);
  const ipShown = interp(vis.form, { allowMissing: true });
  const notes = st.visibleNotes.map((n) => n.name.split("/").pop()).sort();
  const row = { ...s, interpreter: ip.outcome, form: st.calcs.outcome, fb: [st.calcs.fast_breathing, ipShown.fast_breathing], ds: [st.calcs.danger_sign, ipShown.danger_sign], notes, expected_notes: ip.notes, screens: refill.answered, expected_screens: vis.seq, advanced, submitted };
  row.pass = advanced && submitted && row.form === row.interpreter && st.calcs.fast_breathing === ipShown.fast_breathing && st.calcs.danger_sign === ipShown.danger_sign && sameNotes(notes, ip.notes) && sameList(refill.answered, vis.seq);
  editRows.push(row);
  console.log(`${row.pass ? "PASS" : "FAIL"} ${s.id} interpreter=${row.interpreter} form=${row.form}`);
}

// ------------------------------------------------------------------ 3. differential grid (model)
const fullGrid = enumerateAnswers(model);
// Development aids: --grid-limit=N checks only every k-th point (never reported as PASS);
// --no-partial skips the informational partial-answer pass.
const gridLimit = Number(process.argv.find((a) => a.startsWith("--grid-limit="))?.split("=")[1] ?? 0);
const grid = gridLimit > 0
  ? { ...fullGrid, exact: false, points: fullGrid.points.filter((_, i) => i % Math.ceil(fullGrid.points.length / gridLimit) === 0) }
  : fullGrid;
const BATCH = 250;

async function runGrid(pageApi, label) {
  const mismatches = [];
  const perOutcome = {};
  let compared = 0;
  let shownTotal = 0;
  let shownMismatches = 0;
  for (let i = 0; i < grid.points.length; i += BATCH) {
    const chunk = grid.points.slice(i, i + BATCH);
    const results = await pageApi.evaluatePoints(chunk.map(toFormAnswers));
    chunk.forEach((p, j) => {
      const f = results[j];
      const ip = interp(p); // FULL answers
      const vis = visible(p);
      const ipShown = interp(vis.form, { allowMissing: true }); // shown answers only (derived values)
      perOutcome[ip.outcome] = (perOutcome[ip.outcome] ?? 0) + 1;
      compared++;
      shownTotal += f.shown.length;
      const diffs = [];
      if (f.outcome !== ip.outcome) diffs.push(`outcome form=${f.outcome} interpreter=${ip.outcome}`);
      if (f.fast_breathing !== ipShown.fast_breathing) diffs.push(`fast_breathing form=${f.fast_breathing} interpreter(shown)=${ipShown.fast_breathing}`);
      if (f.danger_sign !== ipShown.danger_sign) diffs.push(`danger_sign form=${f.danger_sign} interpreter(shown)=${ipShown.danger_sign}`);
      if (!sameNotes(f.notes, ip.notes)) diffs.push(`notes form=${[...f.notes].sort().join("+")} expected=${ip.notes.join("+")}`);
      if (!sameList(f.shown, vis.seq)) {
        shownMismatches++;
        diffs.push(`shown form=${f.shown.join("+")} flow=${vis.seq.join("+")}`);
      }
      if (diffs.length) mismatches.push({ answers: p, diffs });
    });
    process.stdout.write(`\r${label}: ${Math.min(i + BATCH, grid.points.length)}/${grid.points.length}`);
  }
  process.stdout.write("\n");
  return { mismatches, perOutcome, compared, avgShown: shownTotal / (compared || 1), shownMismatches };
}

const { mismatches: gridMismatches, perOutcome, compared, avgShown, shownMismatches } = await runGrid(api, "grid");

// ------------------------------------------------------------------ 4. partial answers (informational)
const partialPoints = [];
if (!process.argv.includes("--no-partial")) grid.points.forEach((p, idx) => {
  const keys = visible(p).seq.filter((k) => p[k] !== undefined);
  const drop = keys[idx % keys.length];
  const q = { ...p };
  delete q[drop];
  partialPoints.push({ answers: q, dropped: drop });
});
const partialMismatches = [];
for (let i = 0; i < partialPoints.length; i += BATCH) {
  const chunk = partialPoints.slice(i, i + BATCH);
  const results = await api.evaluatePoints(chunk.map((c) => toFormAnswers(c.answers)));
  chunk.forEach((c, j) => {
    const f = results[j];
    const ip = interp(visible(c.answers).form, { allowMissing: true });
    const diffs = [];
    if (f.outcome !== ip.outcome) diffs.push(`outcome form=${f.outcome} interpreter=${ip.outcome}`);
    if (f.fast_breathing !== ip.fast_breathing) diffs.push(`fast_breathing form=${f.fast_breathing} interpreter=${ip.fast_breathing}`);
    if (f.danger_sign !== ip.danger_sign) diffs.push(`danger_sign form=${f.danger_sign} interpreter=${ip.danger_sign}`);
    if (diffs.length) partialMismatches.push({ answers: c.answers, dropped: c.dropped, diffs });
  });
  process.stdout.write(`\rpartial: ${Math.min(i + BATCH, partialPoints.length)}/${partialPoints.length}`);
}
process.stdout.write("\n");
await browser.close();

// ------------------------------------------------------------------ 5. mutation self-check (optional)
// Plants known build-stage bugs in a COPY of the compiled XForm and checks the grid catches each one.
// Proves the differential check is able to fail. Off by default (adds a few minutes): --mutation-check.
// equivalentIn: flow modes in which the mutant changes no answer (with the reason in `what`); in every
// other mode it must be caught. needsFlow: the anchor only exists when the form carries flow conditions.
const MUTATIONS = [
  { id: "m1", what: "fast-breathing boundary off by one: breaths >= 50 emitted as > 50", from: "breaths_per_minute  &gt;= 50", to: "breaths_per_minute  &gt; 50" },
  {
    id: "m2",
    what: "age band edge: age < 12 emitted as <= 12 in fast_breathing (EQUIVALENT mutant: at 12 months with 50+ breaths the 12-59 band, 40+, already holds, so no answer changes and no test can catch it)",
    from: "age_months  &lt; 12) and ( /data/q_breaths_per_minute/breaths_per_minute",
    to: "age_months  &lt;= 12) and ( /data/q_breaths_per_minute/breaths_per_minute",
    equivalentIn: ["full", "minimal", "danger_signs_always"],
  },
  { id: "m2b", what: "age band edge: age >= 12 emitted as > 12 in the 12-59 month fast-breathing band", from: "age_months  &gt;= 12) and ( /data/q_age_months/age_months  != '' and  /data/q_age_months/age_months  &lt; 60) and ( /data/q_breaths_per_minute/breaths_per_minute", to: "age_months  &gt; 12) and ( /data/q_age_months/age_months  != '' and  /data/q_age_months/age_months  &lt; 60) and ( /data/q_breaths_per_minute/breaths_per_minute" },
  {
    id: "m3",
    what: "rule order: the out-of-range rule R2 checked before R1 (outside the age range AND a danger sign), so a child outside the age range with a danger sign gets the lower-urgency result. Not equivalent: the final model's R1 exists to prevent exactly this",
    from: "if(( /data/outside_age_range  = 'yes' and  /data/danger_sign  = 'yes'), 'refer_urgent_outside_age_range', if( /data/outside_age_range  = 'yes', 'refer_outside_age_range', ",
    to: "if( /data/outside_age_range  = 'yes', 'refer_outside_age_range', if(( /data/outside_age_range  = 'yes' and  /data/danger_sign  = 'yes'), 'refer_urgent_outside_age_range', ",
  },
  {
    id: "m4",
    what: "flow is_no emitted with the wrong value: convulsions = 'no' emitted as = 'yes' in every relevance (drink, vomit, sleepy screens follow the wrong answer)",
    fromAll: "/data/q_convulsions/convulsions  = 'no'",
    toAll: "/data/q_convulsions/convulsions  = 'yes'",
    needsFlow: true,
  },
  {
    id: "m5",
    what: "flow is_no emitted so that blank counts as no: cough/convulsions/... = 'no' emitted as != 'yes'. EQUIVALENT for v1: every is_no atom sits next to the conditions that show its question, so the question is answered whenever the atom is read",
    regexAll: / (\/data\/q_[a-z_]+\/[a-z_]+)  = 'no'/g,
    replace: " $1  != 'yes'",
    needsFlow: true,
    equivalentIn: ["minimal", "danger_signs_always"],
  },
  {
    id: "m6",
    what: "flow threshold off by one: cough_days < 14 emitted as < 13 in the relevance of the danger-sign screens (a child coughing 13 days is not asked about convulsions)",
    fromAll: "cough_days  &lt; 14",
    toAll: "cough_days  &lt; 13",
    needsFlow: true,
  },
];
const mutationRows = [];
if (process.argv.includes("--mutation-check")) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "verify-mutation-"));
  const original = readFileSync(FORM_XML, "utf8");
  try {
    for (const m of MUTATIONS) {
      let xml = original;
      if (m.needsFlow && FLOW_MODE === "full") {
        mutationRows.push({ ...m, mismatches: 0, verdict: "n/a (no flow conditions in flowMode full)", pass: true, skipped: true });
        continue;
      }
      if (m.fromAll) {
        if (!xml.includes(m.fromAll)) throw new Error(`mutation ${m.id}: anchor not found`);
        xml = xml.split(m.fromAll).join(m.toAll);
      } else if (m.regexAll) {
        if (!m.regexAll.test(xml)) throw new Error(`mutation ${m.id}: anchor not found`);
        xml = xml.replace(m.regexAll, m.replace);
      } else if (m.swapOutcome) {
        const re = /calculate="if\(\((\( \/data\/q_age_months\/age_months  != '' and  \/data\/q_age_months\/age_months  &lt; 2\) or \( \/data\/q_age_months\/age_months  != '' and  \/data\/q_age_months\/age_months  &gt;= 60\))\), 'refer_outside_age_range', /;
        if (!re.test(xml)) throw new Error(`mutation ${m.id}: anchor not found`);
        xml = xml.replace(re, (_all, cond) => `calculate="if( /data/danger_sign  = 'yes' and not( /data/fast_breathing  = 'yes' or  /data/q_chest_indrawing/chest_indrawing  = 'yes'), 'refer_urgent', if((${cond}), 'refer_outside_age_range', `).replace(/'no_cough'\)\)\)\)\)"/, "'no_cough'))))))\"");
      } else {
        if (!xml.includes(m.from)) throw new Error(`mutation ${m.id}: anchor not found`);
        xml = xml.replace(m.from, m.to);
      }
      const path = join(dir, `${m.id}.xml`);
      writeFileSync(path, xml);
      await buildPreview({ quiet: true, formXmlPath: path });
      const mp = await openPreview();
      const r = await runGrid(mp.api, `mutation ${m.id}`);
      await mp.browser.close();
      const equivalent = (m.equivalentIn ?? []).includes(FLOW_MODE);
      const verdict = equivalent ? (r.mismatches.length === 0 ? "EQUIVALENT (no change, as expected)" : "UNEXPECTED: equivalent mutant changed answers") : r.mismatches.length > 0 ? "CAUGHT" : "MISSED";
      mutationRows.push({ ...m, regexAll: m.regexAll ? String(m.regexAll) : undefined, equivalent, mismatches: r.mismatches.length, example: r.mismatches[0], verdict, pass: equivalent ? r.mismatches.length === 0 : r.mismatches.length > 0 });
      console.log(`${verdict} ${m.id}: ${r.mismatches.length} mismatching points`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await buildPreview({ quiet: true }); // restore the real preview
  }
}
const seconds = ((Date.now() - t0) / 1000).toFixed(1);

// ------------------------------------------------------------------ report
const goldenPass = goldenRows.filter((r) => r.pass).length;
const editPass = editRows.filter((r) => r.pass).length;
const goldenVsExpectedInterp = goldenRows.filter((r) => r.interpreter === r.expected).length;
const ok = goldenPass === goldenRows.length && editPass === editRows.length && gridMismatches.length === 0 && grid.exact && mutationRows.every((m) => m.pass);
const goldenAvgScreens = goldenRows.reduce((a, r) => a + r.screens.length, 0) / (goldenRows.length || 1);
const caught = mutationRows.filter((m) => !m.skipped && !m.equivalent && m.mismatches > 0).length;
const mustCatch = mutationRows.filter((m) => !m.skipped && !m.equivalent).length;
const equivOk = mutationRows.filter((m) => !m.skipped && m.equivalent && m.mismatches === 0).length;
const formSha = (await import("node:crypto")).createHash("sha256").update(readFileSync(FORM_XML)).digest("hex");

const md = [];
md.push("# VERIFY: compiled CHT form vs golden cases and the logic interpreter", "");
md.push("PREVIEW BUILD, not approved, demo settings. Synthetic data only. The golden outcomes are proposed from v1.json and the booklet, not clinically confirmed (awaiting Medic).", "");
md.push(`Overall: **${ok ? "PASS" : "FAIL"}**  `);
md.push(`Form under test: \`compile-demo/output/project/forms/app/cough_fast_breathing.xml\` (cht-conf 6.6.1 output), sha256 \`${formSha}\`  `);
md.push(`Model: \`tests/fixtures/logic/v1.json\` (${model.meta.pathway_id} v${model.meta.version}); interpreter: \`src/logic\` evaluate()  `);
md.push("Engine: enketo-core 7.2.5 + openrosa-xpath-evaluator 2.0.13 in headless Google Chrome, CHT webapp enketo config (excludeNonRelevant: true, validatePage: true), CHT's enketo-core patch (/inputs always relevant), HTML and model made with cht-core's XSL (as cht-core api does). Opened as from a contact profile with a synthetic contact.  ");
md.push(`Flow: **flowMode ${FLOW_MODE}** (from \`output/manifest.json\`; flow derivation \`${manifest.flow?.derivationVersion ?? "-"}\`)  `);
md.push(`**Average questions asked: ${avgShown.toFixed(2)} per grid point in the CHT engine** (flow prediction ${(manifest.flow?.avgQuestions ?? 0).toFixed(2)}, all questions ${(manifest.flow?.avgQuestionsFullForm ?? 0).toFixed(2)}); ${goldenAvgScreens.toFixed(2)} screens per golden case typed in the UI.  `);
md.push(`Run time: ${seconds} s. Re-run: \`cd Backend && npm run compile:verify\` (after \`npm run compile:demo -- --flow=<mode>\` for another mode).`, "");

md.push("## 1. Golden cases (UI level)", "");
md.push("Each case was typed into the real form inputs (radio clicks, number fields), the real Next button was pressed (enketo page validation), the result page was read, and the form was submitted (enketo validate()). Pass = form outcome, interpreter outcome and expected outcome agree, fast_breathing and danger_sign agree with the interpreter, the visible result notes equal the model's notes for that outcome (outcome note plus the dose note for the child's age band), the screens that appeared were exactly the questions the flow asks for that case, in order (the case's answers to skipped questions were not typed), and validation passed. fast_breathing and danger_sign are compared with the interpreter on the answers actually shown (a skipped question is blank in CHT).", "");
md.push("| case | description | expected | interpreter | compiled form | screens (shown / expected) | fast_breathing (form/interp) | danger_sign (form/interp) | visible result notes | result |");
md.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of goldenRows) {
  md.push(`| ${r.id} | ${r.description} | ${r.expected} | ${r.interpreter} | ${r.form} | ${r.screens.length} / ${r.expected_screens.length}${sameList(r.screens, r.expected_screens) ? "" : " DIFFERENT"} | ${r.form_fast_breathing}/${r.interp_fast_breathing} | ${r.form_danger_sign}/${r.interp_danger_sign} | ${r.notes.join(", ")} | ${r.pass ? "PASS" : "FAIL"} |`);
}
md.push("", `Golden: ${goldenPass}/${goldenRows.length} pass (interpreter equals expected in ${goldenVsExpectedInterp}/${goldenRows.length}).`, "");
const failing = goldenRows.filter((r) => !r.pass);
if (failing.length) {
  md.push("Failing golden details:", "", "```json", JSON.stringify(failing, null, 2), "```", "");
}
md.push("Note text shown for g01 (exactly as on screen):", "", "```", ...(goldenRows[0]?.note_text ?? []).flatMap((t) => [t, ""]), "```", "");

md.push("## 2. Edit scenarios (UI level, stale hidden values)", "");
md.push("Answers were changed after first entry, so a now-hidden question still holds its old value in the model. CHT's config (excludeNonRelevant) treats hidden values as blank in calculations and drops them on save; the interpreter drops answers to hidden questions. After the edit the form is walked again from the first screen (an edit can bring back screens the flow had skipped), answering only the screens that appear. Outcome and notes must equal the interpreter on the full final answers; the screens must equal the flow's sequence.", "");
md.push("| case | scenario | interpreter | compiled form | fast_breathing (form/interp) | danger_sign (form/interp) | notes | result |");
md.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of editRows) md.push(`| ${r.id} | ${r.description} | ${r.interpreter} | ${r.form} | ${r.fb.join("/")} | ${r.ds.join("/")} | ${r.notes.join(", ")} | ${r.pass ? "PASS" : "FAIL"} |`);
md.push("", `Edit scenarios: ${editPass}/${editRows.length} pass.`, "");

md.push("## 3. Differential grid (model level)", "");
md.push(`Points: ${grid.points.length} from enumerateAnswers(model) (exact: ${grid.exact}; every integer cut point of every threshold and constraint bound, every yes/no combination, hidden questions omitted). Each point: a fresh enketo form, values set on the model nodes, enketo's evaluation cascade run, calculate nodes and relevant result notes read. Every answer of the point is set, including questions the flow hides: enketo (excludeNonRelevant, as in CHT) treats hidden questions as blank. Outcome and notes are compared with evaluate() on the FULL answers (so the short form must give the outcome of answering everything); fast_breathing and danger_sign with evaluate() on the shown answers; the questions enketo shows with the flow's sequence.`, "");
md.push(`Compared: ${compared}. **Mismatches: ${gridMismatches.length}** (of which shown-question differences: ${shownMismatches}). Average questions shown: ${avgShown.toFixed(2)}.`, "");
md.push("| outcome (interpreter) | points |", "| --- | --- |", ...Object.entries(perOutcome).map(([k, v]) => `| ${k} | ${v} |`), "");
if (gridMismatches.length) {
  md.push("First 10 mismatches:", "", "| # | answers | differences |", "| --- | --- | --- |");
  gridMismatches.slice(0, 10).forEach((m, i) => md.push(`| ${i + 1} | ${fmtAnswers(m.answers)} | ${m.diffs.join("; ")} |`));
  md.push("");
}

md.push("## 4. Partial answers (informational)", "");
md.push(`Every grid point again with one shown question left empty (${partialPoints.length} points, the dropped question rotating), compared with evaluate(..., { allowMissing: true }) on outcome, fast_breathing and danger_sign. The real form cannot be submitted like this (all questions are required, enketo blocks Next), so this only checks that empty fields behave the same in both (the compiler guards every comparison with \`!= ''\`). Mismatches: **${partialMismatches.length}**.`, "");
if (partialMismatches.length) {
  md.push("| # | answers | left empty | differences |", "| --- | --- | --- | --- |");
  partialMismatches.slice(0, 10).forEach((m, i) => md.push(`| ${i + 1} | ${fmtAnswers(m.answers)} | ${m.dropped} | ${m.diffs.join("; ")} |`));
  md.push("");
}

md.push("## 5. Mutation self-check (can the grid fail?)", "");
if (mutationRows.length) {
  md.push(`Known build-stage bugs were planted in a temporary copy of the compiled XForm (the real one is untouched) and the full grid was re-run on each copy. Every mutation that changes an answer must produce mismatches; mutants marked equivalent for flowMode ${FLOW_MODE} change the XPath but no answer (reason in the row) and must produce none, which shows the grid reports real behaviour, not text differences. Result: ${caught}/${mustCatch} caught, ${equivOk} equivalent as expected.`, "");
  md.push("| mutation | planted bug | mismatching grid points | first example | result |", "| --- | --- | --- | --- | --- |");
  for (const m of mutationRows) md.push(`| ${m.id} | ${m.what} | ${m.mismatches} | ${m.example ? `${fmtAnswers(m.example.answers)}: ${m.example.diffs.join("; ")}` : "-"} | ${m.verdict} |`);
  md.push("");
} else {
  md.push("Not run this time (`npm run compile:verify -- --mutation-check` to run it).", "");
}
md.push("## What this proves", "");
md.push("- The XPath the compiler emitted, after cht-conf's xlsx-to-XForm conversion, computes the same outcome, fast_breathing and danger_sign as the logic interpreter at every point of the exact answer grid, in the same engine and configuration the CHT webapp uses. This is the check that catches build-stage logic bugs (operator precedence, bracket, threshold and boundary errors).");
md.push("- The golden cases give their expected outcome when typed into the real form, and the right outcome and dose notes appear.");
md.push("- Constraints, required fields and relevance work in the form (see the screenshots: `output/screenshots/`).", "");
md.push("## What is NOT verified", "");
md.push("- CHT-specific widgets: the contact selector (db-object-widget, `select-contact type-person` on inputs/contact/_id) and CHT's other custom widgets are not loaded; the preview opens the form as if launched from a contact profile, so that group is hidden.");
md.push("- CHT's medic XPath extensions (not used by this form) and CHT's own webapp styles.");
md.push("- Offline behaviour, PouchDB storage, sync, the saved report document shape in CouchDB (only enketo's record XML is produced), form upload with `cht --local`, and the CHT API's can-generate-xform validation.");
md.push("- tasks.js behaviour (task appears on the right days, resolves, the 7-day demo window) and targets: nothing here runs the rules engine. cht-conf-test-harness would be needed.");
md.push("- The contact/patient linkage (patient_uuid etc. are filled from the synthetic contact only) and contact-summary.");
md.push("- Other languages, real Android devices and CHT app versions other than cht-core 5.3.0's enketo stack.");
md.push("- Clinical correctness: the golden file and v1.json are proposals awaiting Medic, and the interpreter is itself the reference here (a shared misreading of the guideline would not be caught).", "");
if (problems.length) md.push("## Browser console errors", "", "```", ...problems, "```", "");

// Per-flow-mode summary (kept across recompiles by run.mjs), listed in every VERIFY.md.
const MODES_DIR = join(OUTPUT_DIR, "verify-modes");
mkdirSync(MODES_DIR, { recursive: true });
const sha = modelSha(model);
writeFileSync(
  join(MODES_DIR, `${FLOW_MODE}.json`),
  JSON.stringify({ mode: FLOW_MODE, ok, modelSha: sha, formSha256: formSha, avgQuestions: avgShown, goldenAvgScreens, golden: `${goldenPass}/${goldenRows.length}`, edits: `${editPass}/${editRows.length}`, gridPoints: compared, gridMismatches: gridMismatches.length, shownMismatches, partialMismatches: partialMismatches.length, mutation: mutationRows.length ? `${caught}/${mustCatch} caught, ${equivOk} equivalent as expected` : "not run", seconds: Number(seconds) }, null, 2) + "\n",
);
const modeRows = readdirSync(MODES_DIR).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(MODES_DIR, f), "utf8")));
md.push("## Per flow mode (latest run of each)", "");
md.push("Each row is the latest `compile:verify` for that flow mode (kept in `output/verify-modes/` across recompiles). A row whose modelSha differs from the current model is stale.", "");
md.push("| flowMode | overall | avg questions (grid, CHT engine) | screens per golden case | golden | edits | grid mismatches (shown diffs) | partial | mutation check | modelSha |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of modeRows) md.push(`| ${r.mode}${r.mode === FLOW_MODE ? " (this run)" : ""} | ${r.ok ? "PASS" : "FAIL"} | ${r.avgQuestions.toFixed(2)} | ${r.goldenAvgScreens.toFixed(2)} | ${r.golden} | ${r.edits} | ${r.gridMismatches} (${r.shownMismatches}) | ${r.partialMismatches} | ${r.mutation} | ${r.modelSha === sha ? "current" : "STALE"} |`);
md.push("");
writeFileSync(join(OUTPUT_DIR, "VERIFY.md"), md.join("\n"));
writeFileSync(
  join(OUTPUT_DIR, "verify-result.json"),
  JSON.stringify({ ok, flowMode: FLOW_MODE, avgQuestions: avgShown, goldenAvgScreens, formSha256: formSha, golden: goldenRows, edits: editRows, grid: { points: grid.points.length, exact: grid.exact, mismatches: gridMismatches.length, firstMismatches: gridMismatches.slice(0, 10), perOutcome }, partial: { points: partialPoints.length, mismatches: partialMismatches.length, firstMismatches: partialMismatches.slice(0, 10) }, mutations: mutationRows, browserProblems: problems }, null, 2),
);

// Linked section in REPORT.md (idempotent; compile:demo regenerates REPORT.md without it).
const reportPath = join(OUTPUT_DIR, "REPORT.md");
if (existsSync(reportPath)) {
  const START = "<!-- verify:start -->";
  const END = "<!-- verify:end -->";
  let report = readFileSync(reportPath, "utf8");
  report = report.replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`), "\n");
  const section = [
    START,
    "## Form preview and verification (compile:preview, compile:verify)",
    "",
    `Overall: **${ok ? "PASS" : "FAIL"}**. Details: [VERIFY.md](VERIFY.md). Form preview: \`preview/index.html\` (or \`npm run compile:preview\`). Screenshots: \`screenshots/\`.`,
    "",
    `- flowMode ${FLOW_MODE}: average questions asked ${avgShown.toFixed(2)} per grid point (all questions ${(manifest.flow?.avgQuestionsFullForm ?? 0).toFixed(2)}).`,
    `- Golden cases typed into the real form (enketo-core 7.2.5, CHT config), only the screens that appear: ${goldenPass}/${goldenRows.length} pass.`,
    `- Edit scenarios with stale hidden values: ${editPass}/${editRows.length} pass.`,
    `- Differential grid vs interpreter: ${compared} points, ${gridMismatches.length} mismatches.`,
    `- Partial answers (informational): ${partialPoints.length} points, ${partialMismatches.length} mismatches.`,
    mutationRows.length ? `- Mutation self-check (flowMode ${FLOW_MODE}): ${caught}/${mustCatch} planted bugs caught (plus ${equivOk} equivalent mutants correctly not flagged).` : "- Mutation self-check: not run this time.",
    "",
    END,
    "",
  ].join("\n");
  writeFileSync(reportPath, report.trimEnd() + "\n\n" + section);
}

console.log(`golden ${goldenPass}/${goldenRows.length}, edits ${editPass}/${editRows.length}, grid ${compared} points ${gridMismatches.length} mismatches, partial ${partialPoints.length} points ${partialMismatches.length} mismatches (${seconds}s)`);
console.log(`Overall: ${ok ? "PASS" : "FAIL"}. Report: compile-demo/output/VERIFY.md`);
process.exit(ok ? 0 : 1);
