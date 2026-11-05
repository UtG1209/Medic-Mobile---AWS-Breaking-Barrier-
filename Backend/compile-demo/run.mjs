// End-to-end compile demo: logic model fixture -> compileSnapshot (preview) -> real cht-conf.
// Run from Backend/:  npm run compile:demo   (runs this file with tsx so it can import the TS sources)
// Writes everything under compile-demo/output/ (see compile-demo/README.md).
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModel } from "../src/logic/index.js";
import { compileSnapshot } from "../src/compiler/compileSnapshot.js";
import { readSheets } from "../src/compiler/xlsx.js";
import { buildForm, SURVEY_COLUMNS, SURVEY_HEADERS } from "../src/compiler/form.js";
import { FLOW_MODES } from "../src/compiler/types.js";
import { writeFlowOutputs } from "./flow-outputs.mjs";
// The cht-conf driver is shared with scripts/compileLocked.ts and the pipeline demo (one copy).
import { ASSUMED_CHT_VERSION, chtConfVersion, chtToolsInstalled, installChtTools, runChtConf } from "./chtConf.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, "..");
const REPO = resolve(BACKEND, "..");
const OUT = join(HERE, "output");
const PROJECT = join(OUT, "project");
const LOGS = join(OUT, "logs");
const TOOLS = join(HERE, "tools");
const FIXTURE = join(BACKEND, "tests", "fixtures", "logic", "v1.json");
const SETTINGS = join(HERE, "settings.demo.json");
const GOLDEN = join(BACKEND, "tests", "fixtures", "logic", "golden-testcases.json");
const PREVIEW_DIR = join(HERE, "preview");
/** Per-flow-mode verification results (written by compile:verify) survive a recompile. */
const VERIFY_MODES = join(OUT, "verify-modes");
const flowArg = process.argv.find((a) => a.startsWith("--flow="))?.slice("--flow=".length);
if (flowArg !== undefined && !FLOW_MODES.includes(flowArg)) {
  process.stdout.write(`unknown --flow=${flowArg}; use one of ${FLOW_MODES.join(", ")}\n`);
  process.exit(2);
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
const tmpRoot = mkdtempSync(join(tmpdir(), "compile-demo-"));
const sanitize = (s) =>
  stripAnsi(s)
    .split(tmpRoot).join("<tmp>")
    .split(REPO).join("<repo>")
    .split(homedir()).join("~");
const rel = (p) => sanitize(p);

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

// ---------------------------------------------------------------- 0. tools
if (!chtToolsInstalled(TOOLS)) {
  log("cht-conf not installed in compile-demo/tools; installing (npm install, pinned cht-conf@6.6.1)...");
  if (!installChtTools(TOOLS)) {
    log("npm install failed in compile-demo/tools");
    process.exit(1);
  }
}
const chtVersion = chtConfVersion(TOOLS);

const keptVerify = join(tmpRoot, "verify-modes");
if (existsSync(VERIFY_MODES)) cpSync(VERIFY_MODES, keptVerify, { recursive: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(LOGS, { recursive: true });
if (existsSync(keptVerify)) cpSync(keptVerify, VERIFY_MODES, { recursive: true });

// ---------------------------------------------------------------- 1. compile
const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
const parsed = parseModel(raw);
if (!parsed.ok) {
  log(`fixture does not parse:\n${parsed.issues.join("\n")}`);
  process.exit(1);
}
const model = parsed.value;
const { _note: _ignored, ...settings } = JSON.parse(readFileSync(SETTINGS, "utf8"));
if (flowArg !== undefined) settings.flowMode = flowArg;
settings.flowMode ??= "minimal";
log(`flowMode: ${settings.flowMode}${flowArg !== undefined ? " (from --flow)" : " (from settings.demo.json)"}`);
const manifest = await compileSnapshot(model, { projectDir: PROJECT, buildKind: "preview", settings });
writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
log(`compiled ${manifest.formId} ${manifest.version}: ${manifest.files.length} files; flow ${manifest.flow.mode}: average ${manifest.flow.avgQuestions.toFixed(2)} questions (all: ${manifest.flow.avgQuestionsFullForm.toFixed(2)}), 0 mismatches required, got ${manifest.flow.compiledMismatches}`);
const flowOut = await writeFlowOutputs({
  model,
  outDir: OUT,
  previewDir: PREVIEW_DIR,
  compiledMode: settings.flowMode,
  golden: JSON.parse(readFileSync(GOLDEN, "utf8")),
  modelSha: manifest.modelSha,
});
log(`flow outputs: output/flow.md, output/flow.html (${flowOut.modes.map((m) => `${m.mode} ${m.avgQuestions.toFixed(2)}`).join(", ")})`);

// ---------------------------------------------------------------- 2. determinism
const second = await compileSnapshot(model, { projectDir: join(tmpRoot, "second"), buildKind: "preview", settings });
const mismatches = [];
const byPath = new Map(second.files.map((f) => [f.path, f]));
for (const f of manifest.files) {
  const g = byPath.get(f.path);
  if (!g) mismatches.push(`${f.path}: missing in second run`);
  else if (g.sha256 !== f.sha256) mismatches.push(`${f.path}: ${f.sha256} != ${g.sha256}`);
}
for (const g of second.files) if (!manifest.files.some((f) => f.path === g.path)) mismatches.push(`${g.path}: only in second run`);
const xlsxPath = `forms/app/${manifest.formId}.xlsx`;
const sheetsA = await readSheets(readFileSync(join(PROJECT, xlsxPath)));
const sheetsB = await readSheets(readFileSync(join(tmpRoot, "second", xlsxPath)));
const sheetsEqual = JSON.stringify(sheetsA) === JSON.stringify(sheetsB);
log(`determinism: ${mismatches.length === 0 ? "all file sha256 identical" : `${mismatches.length} mismatches`}; sheet contents ${sheetsEqual ? "identical" : "DIFFER"}`);

// ---------------------------------------------------------------- 3-5. cht-conf (compile-demo/chtConf.ts)
// Python probe and shim, whitespace-safe launcher, the three cht-conf steps, then the offline run of the
// instance-only validations. See compile-demo/README.md ("How Python is chosen", "Paths with spaces").
const xmlRel = `forms/app/${manifest.formId}.xml`;
const xmlAbs = join(PROJECT, xmlRel);
const cht = await runChtConf({ projectDir: PROJECT, logsDir: LOGS, formId: manifest.formId, tmpRoot, sanitize, log, tools: TOOLS });
const python = cht.python.chosen;
const probes = cht.python.probes;
const chtLauncher = cht.launcher.args;
const usedSymlink = cht.launcher.whitespaceSymlink;
const steps = cht.steps;
const extra = cht.extraValidations;

// ---------------------------------------------------------------- 6. collect outputs
const appSettingsAbs = join(PROJECT, "app_settings.json");
const outputs = [xmlRel, "app_settings.json"].map((p) => {
  const abs = join(PROJECT, p);
  if (!existsSync(abs)) return { path: p, exists: false };
  const b = readFileSync(abs);
  return { path: p, exists: true, bytes: b.length, sha256: sha256(b) };
});
let appSettingsSummary = null;
if (existsSync(appSettingsAbs)) {
  const a = JSON.parse(readFileSync(appSettingsAbs, "utf8"));
  appSettingsSummary = {
    keys: Object.keys(a).sort(),
    tasksIsDeclarative: a.tasks?.isDeclarative,
    tasksRulesBytes: typeof a.tasks?.rules === "string" ? a.tasks.rules.length : 0,
    targets: a.tasks?.targets,
    contactSummaryBytes: typeof a.contact_summary === "string" ? a.contact_summary.length : 0,
  };
}
let xmlFacts = null;
if (existsSync(xmlAbs)) {
  const x = readFileSync(xmlAbs, "utf8");
  xmlFacts = {
    hasInstanceId: /<instanceID\s*\/>/.test(x),
    hasOutcomeBind: /nodeset="\/[^"]*\/outcome"/.test(x),
    version: (x.match(/version="([^"]+)"/) ?? [])[1] ?? null,
  };
}

const allPass = !!python && steps.every((s) => s.status === "pass") && extra.every((e) => e.errors.length === 0);
const result = {
  status: allPass ? "pass" : "fail",
  flow: manifest.flow,
  chtConfVersion: chtVersion,
  python: { chosen: python, probes },
  chtLauncher: { args: chtLauncher, whitespaceSymlink: usedSymlink },
  steps: steps.map((s) => ({ ...s, log: rel(s.log) })),
  extraValidations: extra,
  outputs,
  xmlFacts,
  appSettingsSummary,
  determinism: { fileShaMismatches: mismatches, sheetContentsEqual: sheetsEqual },
};
writeFileSync(join(OUT, "run-result.json"), `${JSON.stringify(result, null, 2)}\n`);

// ---------------------------------------------------------------- 7. REPORT.md and survey.html
const form = buildForm(model, settings, manifest.version);
const fl = manifest.flow;
const mdCell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
const mdTable = (headers, rows) =>
  [`| ${headers.map(mdCell).join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`)].join("\n");
const tail = (file, n = 25) => {
  const t = readFileSync(file, "utf8").trimEnd().split("\n");
  return t.slice(-n).join("\n");
};
const fence = (lang, s) => `\`\`\`${lang}\n${s.trimEnd()}\n\`\`\``;

const report = [];
report.push(
  "# Compile demo report",
  "",
  `Model: \`${model.meta.pathway_id}\` v${model.meta.version} (fixture \`Backend/tests/fixtures/logic/v1.json\`)  `,
  `modelSha: \`${manifest.modelSha}\`  `,
  `Build: **${manifest.buildKind}**, form version \`${manifest.version}\`: preview build, not approved, not deployable.  `,
  `cht-conf: ${chtVersion} (npm, compile-demo/tools). Python for xls2xform-medic: ${python ? `\`${rel(python)}\`` : "NONE FOUND"}.  `,
  `Overall: **${allPass ? "PASS" : "FAIL"}**`,
  "",
  "Synthetic data only. The settings used (`compile-demo/settings.demo.json`) are demo placeholders.",
  "",
  "## 0. Question flow",
  "",
  `flowMode: **${fl.mode}** (flow derivation version \`${fl.derivationVersion}\`). Average questions asked over the ${fl.points}-combination grid: **${fl.avgQuestions.toFixed(2)}** (all questions: ${fl.avgQuestionsFullForm.toFixed(2)}).`,
  fl.mode === "full"
    ? "No derived flow: every question its authored shown_when allows is asked."
    : `Flow tree: ${fl.nodes} nodes, ${fl.leaves} leaves. Always asked: ${fl.questionsAlwaysAsked.join(", ") || "none"}. Sometimes skipped: ${fl.questionsSometimesSkipped.join(", ") || "none"}. Never asked: ${fl.neverAsked.join(", ") || "none"}. verifyFlow before emitting: ${fl.treeMismatches} tree / ${fl.compiledMismatches} compiled mismatches, ${fl.sequenceDifferences} sequence differences (the compile refuses on any mismatch).`,
  "Diagram and plain sentences for minimal and danger_signs_always: [flow.md](flow.md), [flow.html](flow.html) (offline).",
  fl.mode === "minimal"
    ? "The minimal flow never asks danger-sign questions of a child outside the age range (the outcome is already decided); `--flow=danger_signs_always` asks them always. The clinician chooses."
    : "",
  "",
  "## 1. What was compiled (compileSnapshot manifest)",
  "",
  mdTable(["file", "bytes", "sha256"], manifest.files.map((f) => [`project/${f.path}`, f.bytes, `\`${f.sha256}\``])),
  "",
  "Files added by cht-conf:",
  "",
  mdTable(
    ["file", "bytes", "sha256"],
    outputs.map((o) => [`project/${o.path}`, o.exists ? o.bytes : "MISSING", o.exists ? `\`${o.sha256}\`` : ""]),
  ),
  "",
  `- Generated XForm: \`compile-demo/output/project/${xmlRel}\`${xmlFacts ? ` (instanceID present: ${xmlFacts.hasInstanceId}, outcome bind present: ${xmlFacts.hasOutcomeBind})` : ""}`,
  "- Compiled app settings: `compile-demo/output/project/app_settings.json`" +
    (appSettingsSummary
      ? ` (tasks.isDeclarative: ${appSettingsSummary.tasksIsDeclarative}, compiled task rules ${appSettingsSummary.tasksRulesBytes} chars, targets ${JSON.stringify(appSettingsSummary.targets)})`
      : ""),
  "- Source XLSForm: `compile-demo/output/project/" + xlsxPath + "`",
  "- Sourcemap (row/task -> model item and {page, quote}): `compile-demo/output/project/sourcemap.json`",
  "- Browser view of the survey: `compile-demo/output/survey.html`",
  "",
  "## 2. cht-conf steps",
  "",
  "Run in this order: convert-app-forms (xlsx -> XForm via xls2xform-medic), validate-app-forms (reads the XForm, so it",
  "must follow convert, as in cht-conf's own default action order), compile-app-settings (tasks.js, targets.js,",
  "contact summary, base settings -> app_settings.json). Flags: `--source=<project> --skip-dependency-check",
  "--skip-version-check --skip-git-check <action>`; no `--local`/`--url`, so no CouchDB is needed.",
  "",
  mdTable(
    ["step", "result", "exit", "errors", "warnings", "log"],
    steps.map((s) => [s.action, s.status.toUpperCase(), s.exit ?? "", s.errors.length, s.warnings.length, `\`${rel(s.log).replace(/^<repo>\/Backend\//, "")}\``]),
  ),
  "",
);
for (const s of steps) {
  report.push(`### ${s.action}: ${s.status.toUpperCase()}`, "", fence("text", tail(s.log)), "");
}
report.push(
  "### Validations cht-conf skips without a CHT instance",
  "",
  "validate-app-forms ran has-instance-id, no-required-notes, check-xpaths-exist, db-doc-is-valid, db-doc-ref-is-valid and",
  "validate-field-paths. It skipped deprecated-appearance, deprecated-tel-type and can-generate-xform because they need an instance.",
  `The first two only need a version number, so this run also executed them directly with apiVersion ${ASSUMED_CHT_VERSION}`,
  "(assumed: the local cht-core checkout version). can-generate-xform posts the form to the CHT API and was NOT run.",
  "",
  mdTable(["validation", "errors", "warnings"], extra.map((e) => [e.name, e.errors.length ? e.errors.join("; ") : "0", e.warnings.length ? e.warnings.join("; ") : "0"])),
  "",
  "## 3. Survey sheet",
  "",
  mdTable(SURVEY_COLUMNS.map((c) => SURVEY_HEADERS[c]), form.survey.map((r) => SURVEY_COLUMNS.map((c) => r[c] ?? ""))),
  "",
  "## 4. Choices sheet",
  "",
  mdTable(["list_name", "name", "label::en"], form.choices.map((c) => [c.list_name, c.name, c.label])),
  "",
  "Settings sheet: " + mdTable(Object.keys(form.settings), [Object.values(form.settings)]).replace(/^/, "\n\n"),
  "",
  "## 5. Generated tasks.js",
  "",
  fence("js", readFileSync(join(PROJECT, "tasks.js"), "utf8")),
  "",
  "## 6. Generated properties.json",
  "",
  fence("json", readFileSync(join(PROJECT, `forms/app/${manifest.formId}.properties.json`), "utf8")),
  "",
  "## 7. Not compiled and warnings",
  "",
  mdTable(["item", "reason"], manifest.notCompiled.map((n) => [n.item, n.reason])),
  "",
  ...manifest.warnings.map((w) => `- ${w}`),
  "",
  "Note: `refer_urgent_with_antibiotic` and `refer_urgent` carry due_in_days 7 but kind `on_return`; per the compiler rules",
  "on_return follow-ups are not turned into tasks until a return trigger is defined.",
  "",
  "## 8. Determinism",
  "",
  mismatches.length === 0
    ? `Compiled twice (second run in a temp directory): all ${manifest.files.length} generated files have identical sha256, including the .xlsx.`
    : `Compiled twice: ${mismatches.length} sha256 mismatches:\n\n${mismatches.map((m) => `- ${m}`).join("\n")}`,
  `Sheet contents read back from both .xlsx files: ${sheetsEqual ? "identical" : "DIFFERENT"}.`,
  "How: exceljs stamps zip entries with the current time, so the compiler fixes workbook creator/created/modified and",
  "re-packs the zip with JSZip giving every entry the same fixed date (byte-level determinism, not just sheet equality).",
  "The cht-conf outputs (XForm, app_settings.json) are not part of this comparison.",
  "",
  "## 9. Not yet verified",
  "",
  "- compile:demo alone does not fill the form: `npm run compile:verify` does (golden cases in the UI, edit scenarios, the",
  "  differential grid against the interpreter in the CHT enketo engine); its result is linked below once it has run.",
  "- tasks.js and targets behaviour are not exercised (needs cht-conf-test-harness).",
  "- No round-trip parse-back (XForm or xlsx -> logic model) has been done.",
  "- Not approved, not signed: this is a preview build and must not be deployed.",
  "- can-generate-xform (CHT API form validation) was not run: there is no CHT instance.",
  "- Demo settings (form title, icon, 7-day task window for Q5, contact types) are placeholders, not decisions.",
  "- Open questions Q1 to Q6 in the model are still open; the compiled logic reflects the current draft answers.",
  "",
);
writeFileSync(join(OUT, "REPORT.md"), report.join("\n"));

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
let depth = 0;
const htmlRows = form.survey
  .map((r, i) => {
    if (r.type === "end group") depth = Math.max(0, depth - 1);
    const pad = depth;
    if (r.type === "begin group") depth++;
    const cls = r.type.replace(/[^a-z]+/g, "-");
    return `<tr class="${cls}"><td>${i + 2}</td><td style="padding-left:${0.5 + pad * 1.5}em">${esc(r.type)}</td><td><code>${esc(r.name)}</code></td><td>${esc(r.label).replace(/\n/g, "<br>")}</td><td>${esc(r.required)}</td><td><code>${esc(r.relevant)}</code></td><td><code>${esc(r.constraint)}</code>${r.constraint_message ? `<br><small>${esc(r.constraint_message)}</small>` : ""}</td><td><code>${esc(r.calculation)}</code></td></tr>`;
  })
  .join("\n");
const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(settings.formTitle)}: survey preview</title>
<style>
body{font-family:system-ui,sans-serif;margin:1.5em;color:#222}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #ccc;padding:4px 6px;vertical-align:top;text-align:left}
th{background:#f0f0f0;position:sticky;top:0}
code{font-size:12px;white-space:pre-wrap;word-break:break-word}
tr.begin-group td,tr.end-group td{background:#eef3fb}
tr.calculate td{background:#fbf7ea}
tr.note td{background:#eefbef}
.banner{background:#fff3cd;border:1px solid #e0c060;padding:8px;margin-bottom:1em}
</style></head><body>
<div class="banner"><strong>preview build, not approved, not deployable.</strong> Form <code>${esc(manifest.formId)}</code> version <code>${esc(manifest.version)}</code>, modelSha <code>${esc(manifest.modelSha)}</code>. Synthetic demo; settings are placeholders.</div>
<h1>${esc(settings.formTitle)}</h1>
<p>Survey rows in order (row = worksheet row in <code>forms/app/${esc(manifest.formId)}.xlsx</code>). Choices: yes_no = yes (Yes), no (No).</p>
<table><thead><tr><th>row</th><th>type</th><th>name</th><th>label</th><th>required</th><th>relevant</th><th>constraint</th><th>calculation</th></tr></thead>
<tbody>
${htmlRows}
</tbody></table>
</body></html>
`;
writeFileSync(join(OUT, "survey.html"), html);

rmSync(tmpRoot, { recursive: true, force: true });
log(`\nOverall: ${allPass ? "PASS" : "FAIL"}`);
log(`Report: ${rel(join(OUT, "REPORT.md"))}`);
log(`Survey: ${rel(join(OUT, "survey.html"))}`);
process.exit(allPass ? 0 : 1);
